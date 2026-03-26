/**
 * WebSocket server — receives streamed export data from the Chrome extension.
 *
 * Listens on a configurable port (default 7890) and handles the full export
 * lifecycle: handshake, data streaming, and completion/error.
 *
 * Also exposes HTTP API endpoints for external tooling (e.g. agent skills):
 *   GET  /api/status   — connection info
 *   GET  /api/spaces   — list available spaces (async, waits for extension)
 *   POST /api/export   — trigger an export
 *   GET  /api/exports  — active + recently completed export progress
 */

import type { ServerWebSocket } from "bun";
import { type ClientConfig, expandTilde } from "./config.js";
import {
	type ExportCompleteMessage,
	type ExportConfig,
	type ExportDataMessage,
	type ExportErrorMessage,
	type ExportStartMessage,
	type ExtensionMessage,
	type HelloAckMessage,
	PROTOCOL_VERSION,
	type ProgressMessage,
	type SpaceInfo,
	type SpacesDataMessage,
	type SpacesListRequestMessage,
	type TriggerExportMessage,
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

/** Recently completed exports (kept for 5 minutes for API consumers to poll). */
interface CompletedExport {
	spaceId: string;
	spaceName?: string;
	totalTopics: number;
	totalMessages: number;
	bytesWritten: number;
	elapsedMs: number;
	completedAt: number;
}
const recentlyCompleted = new Map<string, CompletedExport>();

/** Pending promise resolver for the async GET /api/spaces endpoint. */
let pendingSpacesResolve: ((spaces: SpaceInfo[]) => void) | null = null;

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

	const elapsedMs = Date.now() - state.startedAt;
	console.log(
		`Export complete: ${state.spaceName ?? msg.spaceId} ` +
			`(${msg.totalTopics} topics, ${msg.totalMessages} messages, ` +
			`${(state.bytesWritten / 1024).toFixed(1)} KB, ${(elapsedMs / 1000).toFixed(1)}s)`,
	);

	// Store in recently completed for API consumers (kept for 5 minutes)
	recentlyCompleted.set(msg.spaceId, {
		spaceId: msg.spaceId,
		spaceName: state.spaceName,
		totalTopics: msg.totalTopics,
		totalMessages: msg.totalMessages,
		bytesWritten: state.bytesWritten,
		elapsedMs,
		completedAt: Date.now(),
	});

	sendProgress(state);
	activeExports.delete(msg.spaceId);
}

function handleExportError(msg: ExportErrorMessage): void {
	console.error(`Export error for ${msg.spaceId}: ${msg.error}`);
	activeExports.delete(msg.spaceId);
}

function handleSpacesData(msg: SpacesDataMessage): void {
	// Resolve pending HTTP request if any
	if (pendingSpacesResolve) {
		pendingSpacesResolve(msg.spaces);
		pendingSpacesResolve = null;
	}

	console.log(`\nAvailable spaces (${msg.spaces.length}):`);
	for (const space of msg.spaces) {
		const label = space.type === "dm" ? "DM" : "Space";
		console.log(`  [${label}] ${space.name ?? "(unnamed)"} — ${space.id}`);
	}
}

// ─── HTTP Helpers ────────────────────────────────────────────────────────────

function jsonResponse(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data, null, 2), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

/** Evict completed exports older than 5 minutes. */
function pruneCompleted(): void {
	const cutoff = Date.now() - 5 * 60 * 1000;
	for (const [id, exp] of recentlyCompleted) {
		if (exp.completedAt < cutoff) recentlyCompleted.delete(id);
	}
}

// ─── Server ──────────────────────────────────────────────────────────────────

export function createServer(config: ClientConfig): ReturnType<typeof Bun.serve> {
	const server = Bun.serve({
		port: config.port,
		async fetch(req, server) {
			const url = new URL(req.url);

			// Health check endpoint
			if (url.pathname === "/health") {
				return jsonResponse({ status: "ok", version: PROTOCOL_VERSION });
			}

			// ─── HTTP API ────────────────────────────────────────────────

			// GET /api/status — connection info
			if (url.pathname === "/api/status" && req.method === "GET") {
				return jsonResponse({
					connected: isExtensionConnected(),
					version: PROTOCOL_VERSION,
					activeExports: activeExports.size,
				});
			}

			// GET /api/spaces — list available spaces (async: waits for extension response)
			if (url.pathname === "/api/spaces" && req.method === "GET") {
				if (!isExtensionConnected()) {
					return jsonResponse({ error: "Extension not connected" }, 503);
				}

				try {
					const spaces = await new Promise<SpaceInfo[]>((resolve, reject) => {
						pendingSpacesResolve = resolve;
						const timer = setTimeout(() => {
							if (pendingSpacesResolve === resolve) {
								pendingSpacesResolve = null;
								reject(new Error("Timeout waiting for spaces data (15s)"));
							}
						}, 15_000);
						// Clear timeout if resolved normally
						const origResolve = resolve;
						pendingSpacesResolve = (spaces) => {
							clearTimeout(timer);
							origResolve(spaces);
						};
						sendMessage({ type: "spaces:list" } as SpacesListRequestMessage);
					});
					return jsonResponse({ spaces });
				} catch (err) {
					return jsonResponse({ error: (err as Error).message }, 504);
				}
			}

			// POST /api/export — trigger an export
			if (url.pathname === "/api/export" && req.method === "POST") {
				if (!isExtensionConnected()) {
					return jsonResponse({ error: "Extension not connected" }, 503);
				}

				try {
					const body = (await req.json()) as Partial<ExportConfig>;
					if (!body.spaces || body.spaces.length === 0) {
						return jsonResponse(
							{ error: "Missing 'spaces' array in request body" },
							400,
						);
					}

					const exportConfig: ExportConfig = {
						spaces: body.spaces,
						format: body.format ?? config.format,
						raw: body.raw ?? config.raw,
						outputDir: body.outputDir ?? config.outputDir,
						sinceUsec: body.sinceUsec,
						untilUsec: body.untilUsec,
					};

					const msg: TriggerExportMessage = {
						type: "trigger:export",
						config: exportConfig,
					};

					sendMessage(msg);
					return jsonResponse({ status: "started", config: exportConfig }, 202);
				} catch (err) {
					return jsonResponse({ error: (err as Error).message }, 400);
				}
			}

			// GET /api/exports — active + recently completed exports
			if (url.pathname === "/api/exports" && req.method === "GET") {
				pruneCompleted();

				const active = Array.from(activeExports.values()).map((state) => ({
					spaceId: state.spaceId,
					spaceName: state.spaceName,
					format: state.format,
					outputDir: state.outputDir,
					totalTopics: state.totalTopics,
					totalMessages: state.totalMessages,
					bytesWritten: state.bytesWritten,
					elapsedMs: Date.now() - state.startedAt,
				}));

				const completed = Array.from(recentlyCompleted.values());

				return jsonResponse({ active, recentlyCompleted: completed });
			}

			// ─── WebSocket upgrade ───────────────────────────────────────

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
