/**
 * Configuration management for the local Bun client.
 * Reads from a config file and/or CLI arguments.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { DEFAULT_PORT, type OutputFormat } from "./protocol.js";

export interface ClientConfig {
	/** WebSocket server port. */
	port: number;
	/** Default output directory for exported files. */
	outputDir: string;
	/** Default output format. */
	format: OutputFormat;
	/** Whether to include raw PBLite data by default. */
	raw: boolean;
	/** Inter-request delay in ms to avoid rate limiting. */
	throttleMs: number;
}

const DEFAULT_OUTPUT_DIR = join(homedir(), "chat-exports");

const DEFAULT_CONFIG: ClientConfig = {
	port: DEFAULT_PORT,
	outputDir: DEFAULT_OUTPUT_DIR,
	format: "jsonl",
	raw: false,
	throttleMs: 200,
};

const CONFIG_FILENAME = "chat-export.config.json";

/**
 * Search for config file in current directory, then home directory.
 */
function findConfigFile(): string | null {
	const candidates = [join(process.cwd(), CONFIG_FILENAME), join(homedir(), CONFIG_FILENAME)];

	for (const candidate of candidates) {
		if (existsSync(candidate)) {
			return candidate;
		}
	}
	return null;
}

/**
 * Load configuration from file, merging with defaults.
 */
export function loadConfig(overrides?: Partial<ClientConfig>): ClientConfig {
	let fileConfig: Partial<ClientConfig> = {};

	const configPath = findConfigFile();
	if (configPath) {
		try {
			const raw = Bun.file(configPath);
			// We read synchronously for startup config
			const text = require("node:fs").readFileSync(configPath, "utf-8");
			fileConfig = JSON.parse(text) as Partial<ClientConfig>;
			console.log(`Loaded config from ${configPath}`);
		} catch (err) {
			console.warn(`Failed to parse config file ${configPath}: ${(err as Error).message}`);
		}
	}

	const merged: ClientConfig = {
		...DEFAULT_CONFIG,
		...fileConfig,
		...overrides,
	};

	// Expand ~ to home directory and resolve to absolute path
	merged.outputDir = expandTilde(merged.outputDir);
	merged.outputDir = resolve(merged.outputDir);

	return merged;
}

/**
 * Expand leading ~ or ~/ to the user's home directory.
 */
export function expandTilde(filepath: string): string {
	if (filepath === "~") return homedir();
	if (filepath.startsWith("~/") || filepath.startsWith("~\\")) {
		return join(homedir(), filepath.slice(2));
	}
	return filepath;
}
