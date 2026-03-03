/**
 * File writer module — handles writing exported data in JSON, JSONL, or batched JSON format.
 *
 * Each format has different streaming characteristics:
 * - JSONL: append each message as a line (true streaming, partial files are valid)
 * - JSON: buffer entire space, write atomically on completion
 * - JSON-batched: write one file per page/batch
 */

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ExportedTopic, OutputFormat } from "./protocol.js";

export interface WriteResult {
	bytesWritten: number;
	filePath: string;
}

/**
 * Sanitize a space name for use in a filename.
 */
function sanitizeFilename(name: string): string {
	return name
		.replace(/[^a-zA-Z0-9_-]/g, "_")
		.replace(/_+/g, "_")
		.replace(/^_|_$/g, "")
		.slice(0, 100);
}

/**
 * Ensure the output directory exists.
 */
function ensureDir(dir: string): void {
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
}

/**
 * Build a filename for a given space and format.
 */
function buildFilename(
	spaceId: string,
	spaceName: string | undefined,
	format: OutputFormat,
	page?: number,
): string {
	const safeName = spaceName ? sanitizeFilename(spaceName) : spaceId;
	const ext = format === "jsonl" ? "jsonl" : "json";

	if (format === "json-batched" && page !== undefined) {
		return `${safeName}_page${String(page).padStart(4, "0")}.${ext}`;
	}

	return `${safeName}.${ext}`;
}

// ─── JSONL Writer ────────────────────────────────────────────────────────────

/**
 * Append topics as JSONL lines. Each message is one line.
 * Returns bytes written.
 */
export async function appendJsonl(
	outputDir: string,
	spaceId: string,
	spaceName: string | undefined,
	topics: ExportedTopic[],
	raw?: unknown[],
): Promise<WriteResult> {
	ensureDir(outputDir);
	const filename = buildFilename(spaceId, spaceName, "jsonl");
	const filePath = join(outputDir, filename);

	const lines: string[] = [];
	for (const topic of topics) {
		for (const msg of topic.messages) {
			const line = JSON.stringify(raw ? { ...msg, _raw: raw } : msg);
			lines.push(line);
		}
	}

	const content = lines.length > 0 ? `${lines.join("\n")}\n` : "";
	const bytes = Buffer.byteLength(content, "utf-8");

	if (bytes > 0) {
		// Append for JSONL — each page's messages are added to the same file
		appendFileSync(filePath, content, "utf-8");
	}

	return { bytesWritten: bytes, filePath };
}

// ─── JSON Buffered Writer ────────────────────────────────────────────────────

/** In-memory buffer for JSON format: accumulate topics until export:complete. */
const jsonBuffers = new Map<string, ExportedTopic[]>();

/**
 * Buffer topics for JSON format.
 */
export function bufferJsonTopics(spaceId: string, topics: ExportedTopic[]): void {
	const existing = jsonBuffers.get(spaceId) ?? [];
	existing.push(...topics);
	jsonBuffers.set(spaceId, existing);
}

/**
 * Flush buffered topics to a single JSON file.
 */
export async function flushJson(
	outputDir: string,
	spaceId: string,
	spaceName: string | undefined,
): Promise<WriteResult> {
	ensureDir(outputDir);
	const topics = jsonBuffers.get(spaceId) ?? [];
	jsonBuffers.delete(spaceId);

	const filename = buildFilename(spaceId, spaceName, "json");
	const filePath = join(outputDir, filename);

	const content = JSON.stringify(
		{ spaceId, spaceName, exportedAt: new Date().toISOString(), topics },
		null,
		2,
	);
	const bytes = Buffer.byteLength(content, "utf-8");

	await Bun.write(filePath, content);

	return { bytesWritten: bytes, filePath };
}

// ─── JSON Batched Writer ─────────────────────────────────────────────────────

/**
 * Write a single batch/page as its own JSON file.
 */
export async function writeBatch(
	outputDir: string,
	spaceId: string,
	spaceName: string | undefined,
	topics: ExportedTopic[],
	page: number,
): Promise<WriteResult> {
	const spaceDir = join(outputDir, sanitizeFilename(spaceName ?? spaceId));
	ensureDir(spaceDir);

	const filename = buildFilename(spaceId, spaceName, "json-batched", page);
	const filePath = join(spaceDir, filename);

	const content = JSON.stringify({ spaceId, spaceName, page, topics }, null, 2);
	const bytes = Buffer.byteLength(content, "utf-8");

	await Bun.write(filePath, content);

	return { bytesWritten: bytes, filePath };
}
