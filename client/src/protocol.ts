/**
 * WebSocket protocol types shared between the Chrome extension and the local Bun client.
 *
 * All messages are JSON-encoded and sent as WebSocket text frames.
 * Each message has a `type` field that determines the payload shape.
 */

// ─── Export Configuration ────────────────────────────────────────────────────

export type OutputFormat = "json" | "jsonl" | "json-batched";

export interface ExportConfig {
	/** Space IDs to export. */
	spaces: string[];
	/** Start of time range (microseconds). Omit for "all time". */
	sinceUsec?: number;
	/** End of time range (microseconds). Omit for "now". */
	untilUsec?: number;
	/** Output format. */
	format: OutputFormat;
	/** Include raw PBLite arrays alongside normalized data. */
	raw?: boolean;
	/** Output directory (resolved by the local client). */
	outputDir?: string;
}

// ─── Normalized Message Types ────────────────────────────────────────────────

export interface ExportedMessage {
	messageId?: string;
	topicId?: string;
	spaceId?: string;
	text: string;
	timestamp?: string;
	timestampUsec?: number;
	sender?: string;
	senderId?: string;
	senderEmail?: string;
	senderAvatarUrl?: string;
	isThreadReply?: boolean;
	replyIndex?: number;
}

export interface ExportedTopic {
	topicId: string;
	spaceId: string;
	sortTime?: number;
	messageCount: number;
	messages: ExportedMessage[];
}

// ─── Extension → Client Messages ─────────────────────────────────────────────

export interface ExportStartMessage {
	type: "export:start";
	config: ExportConfig;
	spaceId: string;
	spaceName?: string;
}

export interface ExportDataMessage {
	type: "export:data";
	spaceId: string;
	topics: ExportedTopic[];
	page: number;
	totalEstimate?: number;
	/** Raw PBLite array, included when config.raw is true. */
	raw?: unknown[];
}

export interface ExportCompleteMessage {
	type: "export:complete";
	spaceId: string;
	totalTopics: number;
	totalMessages: number;
}

export interface ExportErrorMessage {
	type: "export:error";
	spaceId: string;
	error: string;
}

export interface SpacesDataMessage {
	type: "spaces:data";
	spaces: SpaceInfo[];
}

// ─── Client → Extension Messages ─────────────────────────────────────────────

export interface ProgressMessage {
	type: "progress";
	spaceId: string;
	writtenTopics: number;
	writtenMessages: number;
	bytesWritten: number;
}

export interface TriggerExportMessage {
	type: "trigger:export";
	config: ExportConfig;
}

export interface SpacesListRequestMessage {
	type: "spaces:list";
}

// ─── Handshake ───────────────────────────────────────────────────────────────

export interface HelloMessage {
	type: "hello";
	version: string;
	clientName: string;
}

export interface HelloAckMessage {
	type: "hello:ack";
	version: string;
	serverName: string;
}

// ─── Union Types ─────────────────────────────────────────────────────────────

export type ExtensionMessage =
	| ExportStartMessage
	| ExportDataMessage
	| ExportCompleteMessage
	| ExportErrorMessage
	| SpacesDataMessage
	| HelloMessage;

export type ClientMessage =
	| ProgressMessage
	| TriggerExportMessage
	| SpacesListRequestMessage
	| HelloAckMessage;

export type ProtocolMessage = ExtensionMessage | ClientMessage;

// ─── Space Info ──────────────────────────────────────────────────────────────

export interface SpaceInfo {
	id: string;
	name?: string;
	type: "space" | "dm";
	sortTimestamp?: number;
}

// ─── Constants ───────────────────────────────────────────────────────────────

export const DEFAULT_PORT = 7890;
export const PROTOCOL_VERSION = "1.0.0";
