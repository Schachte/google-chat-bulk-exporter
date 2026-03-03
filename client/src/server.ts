/**
 * WebSocket server — receives streamed export data from the Chrome extension.
 *
 * Listens on a configurable port (default 7890) and handles the full export
 * lifecycle: handshake, data streaming, and completion/error.
 */

import type { ServerWebSocket } from "bun";
import { type ClientConfig, expandTilde } from "./config.js";
import {
	type ExportCompleteMessage,
	type ExportDataMessage,
	type ExportErrorMessage,
	type ExportStartMessage,
	type ExtensionMessage,
	type HelloAckMessage,
	PROTOCOL_VERSION,
	type ProgressMessage,
	type SpacesDataMessage,
} from "./protocol.js";
import { appendJsonl, bufferJsonTopics, flushJson, writeBatch } from "./writer.js";

interface ExportState {
	spaceId: string;
	spaceName?: string;
	format: "json" | "jsonl" | "json-batched";
	raw: boolean;
	outputDir: string;
	totalTopics: number;
	totalMessages: number;
	bytesWritten: number;
	startedAt: number;
}

/** Active export states keyed by spaceId. */
const activeExports = new Map<string, ExportState>();

/** Reference to the connected extension WebSocket (only one at a time). */
let connectedSocket: ServerWebSocket<unknown> | null = null;

function sendToExtension(msg: object): void {
	if (connectedSocket?.readyState === WebSocket.OPEN) {
		connectedSocket.send(JSON.stringify(msg));
	}
}

function sendProgress(state: ExportState): void {
	const msg: ProgressMessage = {
		type: "progress",
		spaceId: state.spaceId,
		writtenTopics: state.totalTopics,
		writtenMessages: state.totalMessages,
		bytesWritten: state.bytesWritten,
	};
	sendToExtension(msg);
}

// ─── Message Handlers ────────────────────────────────────────────────────────

async function handleExportStart(msg: ExportStartMessage, config: ClientConfig): Promise<void> {
	const rawDir = msg.config.outputDir ?? config.outputDir;
	const outputDir = expandTilde(rawDir);
	const state: ExportState = {
		spaceId: msg.spaceId,
		spaceName: msg.spaceName,
		format: msg.config.format,
		raw: msg.config.raw ?? false,
		outputDir,
		totalTopics: 0,
		totalMessages: 0,
		bytesWritten: 0,
		startedAt: Date.now(),
	};

	activeExports.set(msg.spaceId, state);
	console.log(
		`Export started: ${msg.spaceName ?? msg.spaceId} (format=${state.format}, dir=${outputDir})`,
	);
}

async function handleExportData(msg: ExportDataMessage, config: ClientConfig): Promise<void> {
	const state = activeExports.get(msg.spaceId);
	if (!state) {
		console.warn(`Received data for unknown export: ${msg.spaceId}`);
		return;
	}

	const topicCount = msg.topics.length;
	const messageCount = msg.topics.reduce((sum, t) => sum + t.messages.length, 0);

	let result: { bytesWritten: number; filePath: string };

	switch (state.format) {
		case "jsonl":
			result = await appendJsonl(
				state.outputDir,
				msg.spaceId,
				state.spaceName,
				msg.topics,
				state.raw ? msg.raw : undefined,
			);
			break;

		case "json":
			bufferJsonTopics(msg.spaceId, msg.topics);
			result = { bytesWritten: 0, filePath: "" };
			break;

		case "json-batched":
			result = await writeBatch(
				state.outputDir,
				msg.spaceId,
				state.spaceName,
				msg.topics,
				msg.page,
			);
			break;
	}

	state.totalTopics += topicCount;
	state.totalMessages += messageCount;
	state.bytesWritten += result.bytesWritten;

	const suffix = result.filePath ? ` -> ${result.filePath}` : "";
	console.log(`  Page ${msg.page}: ${topicCount} topics, ${messageCount} messages${suffix}`);

	sendProgress(state);
}

async function handleExportComplete(
	msg: ExportCompleteMessage,
	config: ClientConfig,
): Promise<void> {
	const state = activeExports.get(msg.spaceId);
	if (!state) return;

	// For JSON format, flush the buffer now
	if (state.format === "json") {
		const result = await flushJson(state.outputDir, msg.spaceId, state.spaceName);
		state.bytesWritten += result.bytesWritten;
		console.log(`  Flushed JSON: ${result.filePath}`);
	}

	const elapsed = ((Date.now() - state.startedAt) / 1000).toFixed(1);
	console.log(
		`Export complete: ${state.spaceName ?? msg.spaceId} ` +
			`(${msg.totalTopics} topics, ${msg.totalMessages} messages, ` +
			`${(state.bytesWritten / 1024).toFixed(1)} KB, ${elapsed}s)`,
	);

	sendProgress(state);
	activeExports.delete(msg.spaceId);
}

function handleExportError(msg: ExportErrorMessage): void {
	console.error(`Export error for ${msg.spaceId}: ${msg.error}`);
	activeExports.delete(msg.spaceId);
}

function handleSpacesData(msg: SpacesDataMessage): void {
	console.log(`\nAvailable spaces (${msg.spaces.length}):`);
	for (const space of msg.spaces) {
		const label = space.type === "dm" ? "DM" : "Space";
		console.log(`  [${label}] ${space.name ?? "(unnamed)"} — ${space.id}`);
	}
}

// ─── Server ──────────────────────────────────────────────────────────────────

export function createServer(config: ClientConfig): ReturnType<typeof Bun.serve> {
	const server = Bun.serve({
		port: config.port,
		fetch(req, server) {
			const url = new URL(req.url);

			// Health check endpoint
			if (url.pathname === "/health") {
				return new Response(JSON.stringify({ status: "ok", version: PROTOCOL_VERSION }), {
					headers: { "Content-Type": "application/json" },
				});
			}

			// WebSocket upgrade
			if (url.pathname === "/ws") {
				const upgraded = server.upgrade(req);
				if (!upgraded) {
					return new Response("WebSocket upgrade failed", { status: 400 });
				}
				return undefined;
			}

			return new Response("Not found", { status: 404 });
		},
		websocket: {
			open(ws) {
				connectedSocket = ws;
				console.log("Extension connected");

				const ack: HelloAckMessage = {
					type: "hello:ack",
					version: PROTOCOL_VERSION,
					serverName: "chat-export-client",
				};
				ws.send(JSON.stringify(ack));
			},

			async message(ws, data) {
				try {
					const msg = JSON.parse(String(data)) as ExtensionMessage;

					switch (msg.type) {
						case "hello":
							console.log(`Extension handshake: ${msg.clientName} v${msg.version}`);
							break;
						case "export:start":
							await handleExportStart(msg, config);
							break;
						case "export:data":
							await handleExportData(msg, config);
							break;
						case "export:complete":
							await handleExportComplete(msg, config);
							break;
						case "export:error":
							handleExportError(msg);
							break;
						case "spaces:data":
							handleSpacesData(msg);
							break;
						default:
							console.warn(`Unknown message type: ${(msg as { type: string }).type}`);
					}
				} catch (err) {
					console.error("Failed to process message:", (err as Error).message);
				}
			},

			close() {
				console.log("Extension disconnected");
				connectedSocket = null;
			},
		},
	});

	return server;
}

/**
 * Send a message to the connected extension.
 * Returns true if the message was sent, false if no extension is connected.
 */
export function sendMessage(msg: object): boolean {
	if (!connectedSocket || connectedSocket.readyState !== WebSocket.OPEN) {
		return false;
	}
	connectedSocket.send(JSON.stringify(msg));
	return true;
}

/**
 * Check if an extension is currently connected.
 */
export function isExtensionConnected(): boolean {
	return connectedSocket !== null && connectedSocket.readyState === WebSocket.OPEN;
}
