/**
 * CLI entry point for the local Bun client.
 *
 * Commands:
 *   start                  — Start the WebSocket server and wait for the extension
 *   spaces                 — Request space listing from the connected extension
 *   export [options]       — Trigger an export via the extension
 *   status                 — Show connection and active export status
 */

import { parseArgs } from "node:util";
import { type ClientConfig, loadConfig } from "./config.js";
import {
	PROTOCOL_VERSION,
	type SpacesListRequestMessage,
	type TriggerExportMessage,
} from "./protocol.js";
import { createServer, isExtensionConnected, sendMessage } from "./server.js";

function printUsage(): void {
	console.log(`
chat-export-client v${PROTOCOL_VERSION}

Usage:
  bun run src/cli.ts <command> [options]

Commands:
  start                Start the WebSocket server
  spaces               Request space listing from the extension
  export <spaceId...>  Export one or more spaces
  status               Show connection status

Options:
  --port <number>      WebSocket server port (default: 7890)
  --output <dir>       Output directory (default: ~/chat-exports)
  --format <fmt>       Output format: json, jsonl, json-batched (default: jsonl)
  --since <date>       Start date (ISO 8601, e.g. 2024-01-01)
  --until <date>       End date (ISO 8601, e.g. 2024-12-31)
  --raw                Include raw PBLite data in output
  --help               Show this help message
`);
}

function main(): void {
	const { values, positionals } = parseArgs({
		args: Bun.argv.slice(2),
		options: {
			port: { type: "string", short: "p" },
			output: { type: "string", short: "o" },
			format: { type: "string", short: "f" },
			since: { type: "string" },
			until: { type: "string" },
			raw: { type: "boolean" },
			help: { type: "boolean", short: "h" },
		},
		allowPositionals: true,
		strict: false,
	});

	if (values.help) {
		printUsage();
		process.exit(0);
	}

	const command = positionals[0] ?? "start";

	const portStr = typeof values.port === "string" ? values.port : undefined;
	const outputStr = typeof values.output === "string" ? values.output : undefined;
	const formatStr = typeof values.format === "string" ? values.format : undefined;

	const config = loadConfig({
		...(portStr ? { port: Number(portStr) } : {}),
		...(outputStr ? { outputDir: outputStr } : {}),
		...(formatStr ? { format: formatStr as ClientConfig["format"] } : {}),
		...(values.raw === true ? { raw: true } : {}),
	});

	const sinceStr = typeof values.since === "string" ? values.since : undefined;
	const untilStr = typeof values.until === "string" ? values.until : undefined;

	switch (command) {
		case "start":
			startServer(config);
			break;

		case "spaces":
			requestSpaces(config);
			break;

		case "export":
			triggerExport(config, positionals.slice(1), sinceStr, untilStr);
			break;

		case "status":
			showStatus();
			break;

		default:
			console.error(`Unknown command: ${command}`);
			printUsage();
			process.exit(1);
	}
}

function startServer(config: ClientConfig): void {
	const server = createServer(config);
	console.log(`Chat Export Client v${PROTOCOL_VERSION}`);
	console.log(`WebSocket server listening on ws://localhost:${server.port}/ws`);
	console.log(`Health check: http://localhost:${server.port}/health`);
	console.log(`Output directory: ${config.outputDir}`);
	console.log(`Default format: ${config.format}`);
	console.log("");
	console.log("Waiting for extension to connect...");
}

function requestSpaces(config: ClientConfig): void {
	if (!isExtensionConnected()) {
		console.error("No extension connected. Start the server first and connect the extension.");
		process.exit(1);
	}

	const msg: SpacesListRequestMessage = { type: "spaces:list" };
	sendMessage(msg);
	console.log("Requested space listing from extension...");
}

function triggerExport(
	config: ClientConfig,
	spaceIds: string[],
	sinceStr?: string,
	untilStr?: string,
): void {
	if (!isExtensionConnected()) {
		console.error("No extension connected. Start the server first and connect the extension.");
		process.exit(1);
	}

	if (spaceIds.length === 0) {
		console.error("No space IDs provided. Usage: export <spaceId1> [spaceId2 ...]");
		process.exit(1);
	}

	// Convert date strings to microseconds
	const sinceUsec = sinceStr ? Date.parse(sinceStr) * 1000 : undefined;
	const untilUsec = untilStr ? Date.parse(untilStr) * 1000 : undefined;

	if (sinceStr && Number.isNaN(sinceUsec)) {
		console.error(`Invalid --since date: ${sinceStr}`);
		process.exit(1);
	}
	if (untilStr && Number.isNaN(untilUsec)) {
		console.error(`Invalid --until date: ${untilStr}`);
		process.exit(1);
	}

	const msg: TriggerExportMessage = {
		type: "trigger:export",
		config: {
			spaces: spaceIds,
			format: config.format,
			raw: config.raw,
			outputDir: config.outputDir,
			sinceUsec,
			untilUsec,
		},
	};

	sendMessage(msg);
	console.log(`Triggered export for ${spaceIds.length} space(s)`);
	if (sinceStr) console.log(`  Since: ${sinceStr}`);
	if (untilStr) console.log(`  Until: ${untilStr}`);
	console.log(`  Format: ${config.format}`);
	console.log(`  Output: ${config.outputDir}`);
}

function showStatus(): void {
	console.log(`Connected: ${isExtensionConnected() ? "yes" : "no"}`);
}

main();
