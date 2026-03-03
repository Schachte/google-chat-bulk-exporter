/**
 * Background service worker for Google Chat Exporter.
 *
 * Responsibilities:
 *   1. Maintain a WebSocket connection to the local Bun server (:7890)
 *   2. Store the XSRF token relayed from content.js
 *   3. List spaces via paginated_world (PBLite JSON API)
 *   4. Export conversations via list_topics with pagination
 *   5. Normalize PBLite arrays into ExportedMessage/ExportedTopic
 *   6. Stream pages of data to the Bun server over WebSocket
 */

// ─── Constants ───────────────────────────────────────────────────────────────

const WS_URL = "ws://localhost:7890/ws";
const API_BASE = "https://chat.google.com/u/0/api";
const XSSI_PREFIX = ")]}'\n";
const PROTOCOL_VERSION = "1.0.0";
const RECONNECT_DELAY_MS = 3000;
const MAX_RECONNECT_ATTEMPTS = 20;

// ─── State ───────────────────────────────────────────────────────────────────

let ws = null;
let xsrfToken = null;
let requestCounter = 1;
let reconnectAttempts = 0;
let reconnectTimer = null;

// Cached spaces from intercepted paginated_world responses
let cachedSpaces = null;
let cachedSpacesTimestamp = 0;

// Space name map from mole_world HTML data (spaceId → displayName)
// This supplements paginated_world data with names from the initial page load.
const spaceNameMap = new Map();

// Captured paginated_world request template (URL + body bytes) for replay
let worldRequestTemplate = null;

// No pending request map needed — we use sendResponse from content.js directly.

// ─── WebSocket Client ────────────────────────────────────────────────────────

function connectWebSocket() {
	if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
		return;
	}

	try {
		ws = new WebSocket(WS_URL);
	} catch (err) {
		console.error("[ChatExport] WebSocket creation failed:", err.message);
		scheduleReconnect();
		return;
	}

	ws.onopen = () => {
		console.log("[ChatExport] Connected to Bun server");
		reconnectAttempts = 0;

		wsSend({
			type: "hello",
			version: PROTOCOL_VERSION,
			clientName: "chat-export-extension",
		});
	};

	ws.onmessage = (event) => {
		try {
			const msg = JSON.parse(event.data);
			handleServerMessage(msg);
		} catch (err) {
			console.error("[ChatExport] Failed to parse server message:", err.message);
		}
	};

	ws.onclose = () => {
		console.log("[ChatExport] WebSocket closed");
		ws = null;
		scheduleReconnect();
	};

	ws.onerror = (err) => {
		console.error("[ChatExport] WebSocket error");
		// onclose will fire after this
	};
}

function scheduleReconnect() {
	if (reconnectTimer) return;
	if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
		console.log("[ChatExport] Max reconnection attempts reached. Use popup to reconnect.");
		return;
	}
	reconnectAttempts++;
	const delay = Math.min(RECONNECT_DELAY_MS * Math.pow(1.5, reconnectAttempts - 1), 30000);
	console.log(`[ChatExport] Reconnecting in ${(delay / 1000).toFixed(1)}s (attempt ${reconnectAttempts})`);
	reconnectTimer = setTimeout(() => {
		reconnectTimer = null;
		connectWebSocket();
	}, delay);
}

function wsSend(msg) {
	if (ws && ws.readyState === WebSocket.OPEN) {
		ws.send(JSON.stringify(msg));
		return true;
	}
	return false;
}

// ─── Server Message Handler ──────────────────────────────────────────────────

function handleServerMessage(msg) {
	switch (msg.type) {
		case "hello:ack":
			console.log(`[ChatExport] Server handshake: ${msg.serverName} v${msg.version}`);
			break;

		case "spaces:list":
			handleSpacesListRequest();
			break;

		case "trigger:export":
			handleTriggerExport(msg.config);
			break;

		case "progress":
			// Bun server sends progress back — could update badge
			break;

		default:
			console.log("[ChatExport] Unknown server message:", msg.type);
	}
}

// ─── Chrome Message Listener (from content.js) ──────────────────────────────

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
	if (request.type === "XSRF_TOKEN") {
		xsrfToken = request.token;
		console.log("[ChatExport] XSRF token captured");
		sendResponse({ ok: true });
		return false;
	}

	// API_RESPONSE messages from content.js are handled by sendResponse
	// in the content script directly, not via a separate message.
	if (request.type === "API_RESPONSE") {
		// Stale relay from content.js — ignore (response already handled)
		return false;
	}

	// Popup can request state
	if (request.type === "GET_STATE") {
		sendResponse({
			connected: ws && ws.readyState === WebSocket.OPEN,
			hasXsrf: !!xsrfToken,
			reconnectAttempts,
			spacesCount: cachedSpaces ? cachedSpaces.length : 0,
			hasWorldTemplate: !!worldRequestTemplate,
		});
		return false;
	}

	// Popup/CLI triggers
	if (request.type === "LIST_SPACES") {
		handleSpacesListRequest()
			.then((spaces) => sendResponse({ ok: true, spaces }))
			.catch((err) => sendResponse({ ok: false, error: err.message }));
		return true;
	}

	if (request.type === "START_EXPORT") {
		handleTriggerExport(request.config)
			.then(() => sendResponse({ ok: true }))
			.catch((err) => sendResponse({ ok: false, error: err.message }));
		return true;
	}

	// Return persisted spaces without re-enriching (fast popup auto-load)
	if (request.type === "GET_CACHED_SPACES") {
		chrome.storage.local.get(["cachedSpaces", "cachedSpacesTimestamp"]).then((data) => {
			if (data.cachedSpaces && Array.isArray(data.cachedSpaces) && data.cachedSpaces.length > 0) {
				sendResponse({ ok: true, spaces: data.cachedSpaces, timestamp: data.cachedSpacesTimestamp });
			} else {
				sendResponse({ ok: false });
			}
		}).catch(() => sendResponse({ ok: false }));
		return true;
	}

	if (request.type === "RECONNECT_WS") {
		reconnectAttempts = 0;
		connectWebSocket();
		sendResponse({ ok: true });
		return false;
	}

	// Intercepted paginated_world response from page context
	if (request.type === "WORLD_DATA") {
		try {
			const data = parseXssiJson(request.body);
			const spaces = parseSpacesFromWorld(data);
			if (spaces.length > 0) {
				// Merge new spaces into existing cache (accumulate across multiple responses)
				cachedSpaces = mergeSpaces(cachedSpaces, spaces);
				// Apply any names we already have from mole_world HTML
				enrichSpaceNamesFromMap(cachedSpaces);
				cachedSpacesTimestamp = Date.now();
				persistSpacesToStorage(cachedSpaces);
				console.log(`[ChatExport] Intercepted ${spaces.length} spaces from page (total cached: ${cachedSpaces.length})`);
			}
		} catch (err) {
			console.error("[ChatExport] Failed to parse intercepted world data:", err.message);
		}
		sendResponse({ ok: true });
		return false;
	}

	// Intercepted mole_world HTML data (initial page load with ds:1 blob)
	if (request.type === "MOLE_WORLD_DATA") {
		try {
			const names = parseSpaceNamesFromHtml(request.body);
			let newNames = 0;
			for (const [id, name] of names) {
				if (name && !spaceNameMap.has(id)) {
					spaceNameMap.set(id, name);
					newNames++;
				} else if (name && spaceNameMap.get(id) !== name) {
					spaceNameMap.set(id, name);
					newNames++;
				}
			}

			// Also create space entries for IDs we discovered but don't have yet
			if (cachedSpaces) {
				const newSpaces = [];
				for (const [id, name] of names) {
					if (!cachedSpaces.find(s => s.id === id)) {
						newSpaces.push({
							id,
							name: name || undefined,
							type: isDmId(id) ? "dm" : "space",
						});
					}
				}
				if (newSpaces.length > 0) {
					cachedSpaces = mergeSpaces(cachedSpaces, newSpaces);
					cachedSpacesTimestamp = Date.now();
				}
				enrichSpaceNamesFromMap(cachedSpaces);
				persistSpacesToStorage(cachedSpaces);
			}

			console.log(`[ChatExport] Parsed mole_world HTML: ${names.size} space IDs, ${newNames} new names (name map total: ${spaceNameMap.size})`);
		} catch (err) {
			console.error("[ChatExport] Failed to parse mole_world HTML data:", err.message);
		}
		sendResponse({ ok: true });
		return false;
	}

	// Intercepted paginated_world request template (URL + body bytes)
	if (request.type === "WORLD_REQUEST") {
		worldRequestTemplate = {
			url: request.url,
			body: request.body, // Array of byte values
		};
		console.log("[ChatExport] Captured paginated_world request template for replay");
		sendResponse({ ok: true });
		return false;
	}
});

// ─── API Proxy (via content script in page context) ──────────────────────────
// We route API calls through a Google Chat tab's content script so the browser
// attaches first-party cookies automatically.

async function findChatTab() {
	const tabs = await chrome.tabs.query({
		url: ["https://chat.google.com/*", "https://mail.google.com/chat/*"],
	});
	return tabs[0] || null;
}

/**
 * Re-inject the content script (and interceptor) into a Google Chat tab.
 * Used when the content script context is invalidated (e.g., after extension reload).
 */
async function reinjectContentScripts(tabId) {
	console.log(`[ChatExport] Re-injecting content scripts into tab ${tabId}...`);
	try {
		// Inject interceptor first (MAIN world — needs cookies/fetch access)
		await chrome.scripting.executeScript({
			target: { tabId, allFrames: true },
			files: ["scripts/interceptor.js"],
			world: "MAIN",
		});
		// Then content script (ISOLATED world — bridges to background)
		await chrome.scripting.executeScript({
			target: { tabId, allFrames: true },
			files: ["scripts/content.js"],
		});
		console.log(`[ChatExport] Content scripts re-injected into tab ${tabId}`);
		// Give the scripts a moment to initialize their listeners
		await sleep(300);
	} catch (err) {
		console.error(`[ChatExport] Failed to re-inject content scripts:`, err.message);
		throw new Error(`Failed to re-inject content scripts: ${err.message}`);
	}
}

/**
 * Send an API request through the content script → interceptor (page context).
 * This ensures cookies are attached by the browser.
 *
 * If the content script is unreachable (context invalidated), we re-inject
 * the scripts and retry once.
 */
async function proxyApiRequest(url, method, headers, body, bodyType) {
	const tab = await findChatTab();
	if (!tab) {
		throw new Error("No Google Chat tab found. Please open chat.google.com first.");
	}

	const message = { type: "API_REQUEST", url, method, headers, body, bodyType };

	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const result = await chrome.tabs.sendMessage(tab.id, message);

			if (!result) {
				throw new Error("No response from content script — is the page loaded?");
			}

			return result;
		} catch (err) {
			const isDisconnected =
				err.message?.includes("Receiving end does not exist") ||
				err.message?.includes("Could not establish connection") ||
				err.message?.includes("Extension context invalidated");

			if (isDisconnected && attempt === 0) {
				console.warn(`[ChatExport] Content script unreachable, re-injecting... (${err.message})`);
				await reinjectContentScripts(tab.id);
				continue; // retry
			}

			throw new Error(
				`API proxy failed (attempt ${attempt + 1}): ${err.message}. ` +
				"Try reloading the Google Chat tab."
			);
		}
	}
}

// ─── PBLite Helpers ──────────────────────────────────────────────────────────

function buildPbliteRequestHeader() {
	return [
		"0", 7, 1, "en",
		[
			null, null, null, null, 2, 2, null, 2, 2, 2, 2, null, null, null, null,
			2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, null, null, 2, 2, null, null,
			null, 2, 2, null, null, null, null, 2, 2, 2, 2, null, 2, null, null, 2,
			null, 2, 2, 2, 2, null, 2,
		],
	];
}

function parseXssiJson(rawText) {
	let text = rawText;
	if (text.startsWith(XSSI_PREFIX)) {
		text = text.slice(XSSI_PREFIX.length);
	} else if (text.startsWith(")]}'")) {
		text = text.slice(4);
	}
	return JSON.parse(text.trim());
}

function isDmId(groupId) {
	return !groupId.startsWith("AAAA");
}

function buildGroupIdPayload(groupId) {
	return isDmId(groupId)
		? [null, null, [groupId]]
		: [[groupId]];
}

// ─── API Methods ─────────────────────────────────────────────────────────────

/**
 * Make a PBLite (JSON array) API call through the content script proxy.
 * Used for endpoints like list_topics that accept PBLite format.
 */
async function apiCallPblite(endpoint, payload, spaceId) {
	if (!xsrfToken) {
		throw new Error("No XSRF token available. Navigate to Google Chat first.");
	}

	const url = `${API_BASE}/${endpoint}?c=${requestCounter++}`;
	const headers = {
		"Content-Type": "application/json",
		"x-framework-xsrf-token": xsrfToken,
		"Origin": "https://chat.google.com",
		"Referer": "https://chat.google.com/",
	};
	if (spaceId) {
		headers["x-goog-chat-space-id"] = spaceId;
	}

	const result = await proxyApiRequest(url, "POST", headers, JSON.stringify(payload), "json");

	if (!result.ok) {
		throw new Error(`API ${endpoint} failed: ${result.status} — ${(result.error || result.body || "").slice(0, 200)}`);
	}

	return parseXssiJson(result.body);
}

/**
 * Replay a captured paginated_world request through the content script proxy.
 * Uses the exact binary protobuf body that Google Chat's own JS sent,
 * ensuring the server accepts it.
 */
async function replayWorldRequest() {
	if (!worldRequestTemplate) {
		throw new Error("No paginated_world request template captured. Refresh the Google Chat tab.");
	}

	if (!xsrfToken) {
		throw new Error("No XSRF token available. Navigate to Google Chat first.");
	}

	const headers = {
		"x-framework-xsrf-token": xsrfToken,
		"Origin": "https://chat.google.com",
		"Referer": "https://chat.google.com/",
	};

	// Send the captured binary protobuf body (bodyType "protobuf" tells
	// the interceptor to reconstruct a Uint8Array and set Content-Type).
	const result = await proxyApiRequest(
		worldRequestTemplate.url,
		"POST",
		headers,
		worldRequestTemplate.body,
		"protobuf",
	);

	if (!result.ok) {
		throw new Error(`paginated_world replay failed: ${result.status} — ${(result.error || result.body || "").slice(0, 200)}`);
	}

	return parseXssiJson(result.body);
}

// ─── Space Listing (paginated_world via interception + replay) ───────────────
// The paginated_world endpoint requires binary protobuf encoding, which we
// cannot generate in a service worker. Instead, we:
//   1. Intercept paginated_world responses from Google Chat's own API calls
//      (the page's JS sends the correct binary protobuf automatically)
//   2. Cache the parsed space data
//   3. If the user requests spaces and we have no cache, replay the
//      captured request template (URL + binary body) through the proxy

/**
 * PBLite field accessor — mirrors the reference client's getPbliteField.
 *
 * PBLite convention:
 *   - If the first element is a string tag, offset = 1 (field N → arr[N])
 *   - Otherwise offset = 0 (field N → arr[N-1])
 */
function getPbliteField(payload, fieldNumber) {
	if (!Array.isArray(payload)) return undefined;
	const offset = typeof payload[0] === "string" && payload.length > 1 ? 1 : 0;
	return payload[fieldNumber - 1 + offset];
}

function getNestedPbliteString(payload, fieldNumber, innerFieldNumber) {
	const nested = getPbliteField(payload, fieldNumber);
	return getPbliteField(nested, innerFieldNumber);
}

// ─── Space Merge & Name Resolution Utilities ─────────────────────────────────

/**
 * Merge two space arrays, preferring entries that have names over those without.
 * When both have names, the newer (incoming) entry wins.
 */
function mergeSpaces(existing, incoming) {
	const map = new Map();
	for (const s of (existing || [])) {
		map.set(s.id, s);
	}
	for (const s of incoming) {
		const prev = map.get(s.id);
		if (!prev) {
			map.set(s.id, s);
		} else if (s.name && !prev.name) {
			// Incoming has a name, existing doesn't — take the incoming entry
			map.set(s.id, { ...prev, name: s.name });
		} else if (s.sortTimestamp && !prev.sortTimestamp) {
			// Incoming has a timestamp, existing doesn't — merge it in
			map.set(s.id, { ...prev, sortTimestamp: s.sortTimestamp });
		}
	}
	return Array.from(map.values());
}

/**
 * Apply the spaceNameMap (from mole_world HTML) to a list of spaces,
 * filling in any missing names.
 */
function enrichSpaceNamesFromMap(spaces) {
	for (const space of spaces) {
		if (!space.name && spaceNameMap.has(space.id)) {
			space.name = spaceNameMap.get(space.id);
		}
	}
	return spaces;
}

/**
 * Parse space names from the mole_world HTML page (ds:1 data blob).
 *
 * Google Chat embeds space metadata in the initial HTML via AF_initDataCallback.
 * Two extraction strategies (from reference client):
 *   1. Regex for named space pattern: ["space/AAAA...", "AAAA...", 2], null, "Name"
 *   2. Parse ds:1 JSON data and walk nested arrays for space entries
 */
function parseSpaceNamesFromHtml(htmlBody) {
	const names = new Map();

	// Decode escaped Unicode sequences in names
	function decodeName(value) {
		return value
			.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
			.replace(/\\n/g, "\n")
			.replace(/\\"/g, '"')
			.replace(/\\\\/g, "\\");
	}

	// Strategy 1: Regex for named spaces — fast, catches most spaces with names
	const namedSpaceRegex = /"space\/(AAAA[A-Za-z0-9_-]{7,20})",\s*"(AAAA[A-Za-z0-9_-]{7,20})",2\],null,"([^"]{1,200})"/g;
	let match;
	while ((match = namedSpaceRegex.exec(htmlBody)) !== null) {
		const [, firstId, secondId, rawName] = match;
		if (firstId === secondId && rawName) {
			names.set(firstId, decodeName(rawName));
		}
	}

	// Strategy 2: Parse AF_initDataCallback ds:1 blob for deeper extraction
	const ds1Regex = /AF_initDataCallback\(\{key:\s*'ds:1',\s*hash:\s*'[^']+',\s*data:(\[[\s\S]*?\])\s*,\s*sideChannel/;
	const ds1Match = ds1Regex.exec(htmlBody);
	if (ds1Match) {
		try {
			const data = JSON.parse(ds1Match[1]);
			findSpaceItemsInDs1(data, names, 0);
		} catch (_) {
			// JSON parse failure — rely on regex results
		}
	}

	// Strategy 3: Also scan ALL AF_initDataCallback blocks (not just ds:1)
	const callbackRegex = /AF_initDataCallback\s*\(\s*\{[^}]*data:\s*(\[[\s\S]*?\])\s*\}\s*\)\s*;/g;
	while ((match = callbackRegex.exec(htmlBody)) !== null) {
		try {
			const data = JSON.parse(match[1]);
			findSpaceItemsInDs1(data, names, 0);
		} catch (_) {}
	}

	// Strategy 4: Bare space ID regex — find ALL space IDs in the page (no name)
	// This helps us discover spaces even when names aren't embedded
	const spaceIdRegex = /"(AAAA[A-Za-z0-9_-]{7,20})"/g;
	while ((match = spaceIdRegex.exec(htmlBody)) !== null) {
		const spaceId = match[1];
		if (!names.has(spaceId)) {
			names.set(spaceId, null); // null = we know the ID but not the name
		}
	}

	return names;
}

/**
 * Recursively walk ds:1 JSON data to find space and DM entries.
 * Space entries match: data[0] starts with ["space/AAAA...", "AAAA...", 2]
 * DM entries match: data[0] starts with ["dm/...", "...", ...]
 */
function findSpaceItemsInDs1(data, names, depth) {
	if (depth > 15 || !Array.isArray(data)) return;

	// Space entry: ["space/AAAA...", "AAAA...", 2] at data[0], name at data[2]
	if (
		data.length >= 14 &&
		Array.isArray(data[0]) &&
		data[0].length >= 3 &&
		typeof data[0][0] === "string" &&
		data[0][0].startsWith("space/AAAA")
	) {
		const spaceId = data[0][1];
		const name = typeof data[2] === "string" && data[2].length > 0 ? data[2] : null;
		if (typeof spaceId === "string" && (name || !names.has(spaceId))) {
			names.set(spaceId, name);
		}
		return;
	}

	// DM entry: data[0] starts with "dm/"
	if (
		data.length >= 7 &&
		Array.isArray(data[0]) &&
		data[0].length >= 2 &&
		typeof data[0][0] === "string" &&
		data[0][0].startsWith("dm/")
	) {
		const dmId = data[0][1];
		const name = typeof data[2] === "string" && data[2].length > 0 ? data[2] : null;
		if (typeof dmId === "string" && (name || !names.has(dmId))) {
			names.set(dmId, name);
		}
		return;
	}

	// DM variant: data[0][2][0] starts with "dm/"
	if (
		data.length >= 14 &&
		Array.isArray(data[0]) &&
		data[0].length >= 3 &&
		Array.isArray(data[0][2]) &&
		typeof data[0][2][0] === "string" &&
		data[0][2][0].startsWith("dm/")
	) {
		const dmId = data[0][2][0].replace("dm/", "");
		if (typeof dmId === "string" && !names.has(dmId)) {
			names.set(dmId, null);
		}
		return;
	}

	// Recurse into child arrays
	for (const item of data) {
		if (Array.isArray(item)) {
			findSpaceItemsInDs1(item, names, depth + 1);
		}
	}
}

/**
 * Fetch the display name for a single space via the get_group PBLite endpoint.
 * For DMs, falls back to get_members API to resolve participant names.
 */
async function fetchSpaceName(spaceId) {
	try {
		const groupId = isDmId(spaceId) ? [null, null, [spaceId]] : [[spaceId]];
		const payload = [groupId, buildPbliteRequestHeader()];

		const data = await apiCallPblite("get_group", payload, spaceId);

		// Try multiple field positions for the display name
		if (Array.isArray(data)) {
			// Response may be wrapped: data[0] is the actual group object
			const group = Array.isArray(data[0]) ? data[0] : data;

			// Try field 5 (name), field 2, field 3, field 4, field 6
			for (const fieldNum of [5, 2, 3, 4, 6]) {
				const candidate = getPbliteField(group, fieldNum);
				if (typeof candidate === "string" && candidate.length > 0 && candidate.length < 200 && !/^\d+$/.test(candidate)) {
					return candidate;
				}
			}

			// Deep scan: look for the first plausible name string in the first 20 elements
			const arr = Array.isArray(data[0]) ? data[0] : data;
			for (let i = 0; i < Math.min(arr.length, 20); i++) {
				const val = arr[i];
				if (typeof val === "string" && val.length > 0 && val.length < 200 && !/^\d+$/.test(val) && !val.startsWith("AAAA") && !val.startsWith("space/") && !val.startsWith("dm/")) {
					return val;
				}
			}
		}

		// JSON object response
		if (data && typeof data === "object" && !Array.isArray(data)) {
			const name = data.name || data.displayName;
			if (name) return name;
		}
	} catch (err) {
		// get_group may not accept PBLite JSON — this is expected
		console.log(`[ChatExport] fetchSpaceName(${spaceId}) get_group failed: ${err.message}`);
	}

	// For DMs, try resolving via get_members (extracts member user IDs, then looks up names)
	if (isDmId(spaceId)) {
		const dmName = await fetchDmNameViaMemberLookup(spaceId);
		if (dmName) return dmName;
	}

	return undefined;
}

/**
 * Fetch the display name for a DM by resolving member user IDs.
 *
 * Strategy:
 *   1. Call get_group to retrieve the group info (which contains member IDs)
 *   2. Extract numeric user IDs from the response
 *   3. Call get_members with those user IDs to get display names
 *   4. Return the other participant's name (skip "self" heuristically)
 */
async function fetchDmNameViaMemberLookup(dmId) {
	try {
		// Step 1: get_group to extract member user IDs from the DM group
		const groupPayload = [[null, null, [dmId]], buildPbliteRequestHeader()];
		const groupData = await apiCallPblite("get_group", groupPayload, dmId);

		if (!Array.isArray(groupData)) return undefined;

		// Extract numeric user IDs from the group response.
		// The group response contains member info at various nested positions.
		// We scan for arrays that look like user ID containers: [[numericId], ...]
		const userIds = new Set();
		function findUserIds(arr, depth) {
			if (depth > 12 || !Array.isArray(arr)) return;
			for (let i = 0; i < arr.length; i++) {
				const val = arr[i];
				// Numeric user ID: a string of digits, typically 10-20 chars
				if (typeof val === "string" && /^\d{5,25}$/.test(val) && !val.startsWith("0")) {
					userIds.add(val);
				}
				if (Array.isArray(val)) {
					findUserIds(val, depth + 1);
				}
			}
		}
		findUserIds(groupData, 0);

		if (userIds.size === 0) {
			return undefined;
		}

		// Step 2: Call get_members with extracted user IDs
		// PBLite format for get_members:
		//   [ [ [memberIdEntry, ...] ], requestHeader ]
		// Each memberIdEntry: [ null, [ null, userId ], null, null, 1 ]
		//   (1 = HUMAN user type)
		const memberIdEntries = Array.from(userIds).slice(0, 10).map(uid => [
			null, [null, uid], null, null, 1
		]);
		const membersPayload = [memberIdEntries, buildPbliteRequestHeader()];
		const membersData = await apiCallPblite("get_members", membersPayload);

		if (!Array.isArray(membersData)) return undefined;

		// Step 3: Parse member names from response
		// Response structure (from reference client parseMemberNames):
		//   payload = data[0] if wrapped
		//   getPbliteField(payload, 1) = members array
		//   Each member: getPbliteField(member, 1) = user info
		//     getNestedPbliteString(user, 1, 1) = userId
		//     getPbliteField(user, 2) = display name
		const payload = Array.isArray(membersData[0]) ? membersData[0] : membersData;
		const members = getPbliteField(payload, 1);
		const names = [];

		if (Array.isArray(members)) {
			for (const member of members) {
				const user = getPbliteField(member, 1);
				if (!user) continue;
				const userId = getNestedPbliteString(user, 1, 1);
				const name = getPbliteField(user, 2);
				if (userId && typeof name === "string" && name.length > 0) {
					names.push({ userId, name });
				}
			}
		} else if (Array.isArray(payload)) {
			// Fallback: flat structure where entries are at top level
			for (const entry of payload) {
				if (!Array.isArray(entry)) continue;
				const user = getPbliteField(entry, 1);
				if (!user) continue;
				const userId = getNestedPbliteString(user, 1, 1);
				const name = getPbliteField(user, 2);
				if (userId && typeof name === "string" && name.length > 0) {
					names.push({ userId, name });
				}
			}
		}

		if (names.length === 0) return undefined;

		// For a DM, we want the OTHER person's name.
		// If there are 2 members, pick the one that isn't "self".
		// Heuristic: if we only have 1 name, use it.
		// If we have 2+, join them (group DMs) or pick the non-self one.
		if (names.length === 1) {
			return names[0].name;
		}

		// For 1:1 DMs with 2 members, try to exclude self.
		// We don't know our own userId reliably, so just join all names.
		return names.map(n => n.name).join(", ");

	} catch (err) {
		console.log(`[ChatExport] fetchDmNameViaMemberLookup(${dmId}) failed: ${err.message}`);
		return undefined;
	}
}

/**
 * Parse spaces from paginated_world response data (PBLite format).
 *
 * Structure (from reference client parseSpacesWithTimestamp):
 *   data[0] = payload (outer wrapper, may have a string tag)
 *   getPbliteField(payload, 4) = worldItems array
 *   Each worldItem:
 *     getPbliteField(item, 1) = groupId
 *       getNestedPbliteString(groupId, 1, 1) = spaceId  (spaces start with "AAAA")
 *       getNestedPbliteString(groupId, 3, 1) = dmId      (DMs)
 *     item[1] (raw index) = spaceEntry — scan indices 8..19 for microsecond timestamps
 *     getPbliteField(item, 3) = fallback sortTimestamp
 *     getPbliteField(item, 5) = display name
 */
function parseSpacesFromWorld(data) {
	const spaces = [];
	const seenIds = new Set();

	function addSpace(id, name, type, sortTimestamp) {
		if (!id || seenIds.has(id)) return;
		seenIds.add(id);
		spaces.push({ id, name: name || undefined, type: type || (isDmId(id) ? "dm" : "space"), sortTimestamp });
	}

	// --- Strategy 1: Targeted PBLite extraction (matches reference client) ---
	function extractTargeted(data) {
		// Unwrap: data[0] is the payload
		const payload =
			Array.isArray(data) && data.length > 0 && Array.isArray(data[0])
				? data[0]
				: data;

		const items = getPbliteField(payload, 4);
		if (!Array.isArray(items)) return false;

		let found = 0;
		for (const item of items) {
			if (!Array.isArray(item)) continue;

			const groupId = getPbliteField(item, 1);
			const spaceId = getNestedPbliteString(groupId, 1, 1);
			const dmId = getNestedPbliteString(groupId, 3, 1);
			const id = spaceId ?? dmId;

			if (!id || typeof id !== "string") continue;

			// Extract sortTimestamp from spaceEntry (raw index 1)
			let sortTimestamp;
			const spaceEntry = item[1];
			if (Array.isArray(spaceEntry)) {
				for (let i = 8; i < Math.min(spaceEntry.length, 20); i++) {
					const val = spaceEntry[i];
					if (typeof val === "string" && /^\d{13,}$/.test(val)) {
						sortTimestamp = parseInt(val, 10);
						break;
					}
				}
			}
			// Fallback: getPbliteField(item, 3)
			if (!sortTimestamp) {
				const fallback = getPbliteField(item, 3);
				if (typeof fallback === "string" && /^\d+$/.test(fallback)) {
					sortTimestamp = parseInt(fallback, 10) || undefined;
				} else if (typeof fallback === "number" && fallback > 0) {
					sortTimestamp = fallback;
				}
			}

			// Display name
			let name = getPbliteField(item, 5);
			if (typeof name !== "string" || name.length === 0) name = undefined;

			// For DMs without a name, try field 3 as a short display name
			const type = dmId ? "dm" : "space";
			if (type === "dm" && !name) {
				const field3 = getPbliteField(item, 3);
				if (typeof field3 === "string" && field3.length > 0 && field3.length < 100) {
					name = field3;
				}
			}

			addSpace(id, name, type, sortTimestamp);
			found++;
		}

		return found > 0;
	}

	// --- Strategy 2: Multi-section scan ---
	// Some paginated_world responses have multiple sections at different payload positions.
	// Walk top-level arrays looking for any that contain world items.
	function extractMultiSection(data) {
		const payload =
			Array.isArray(data) && data.length > 0 && Array.isArray(data[0])
				? data[0]
				: data;

		if (!Array.isArray(payload)) return false;

		let found = 0;
		// Try each top-level slot that could be an items array
		for (let idx = 0; idx < Math.min(payload.length, 30); idx++) {
			const candidate = payload[idx];
			if (!Array.isArray(candidate) || candidate.length === 0) continue;
			// Check if first element looks like a world item (array with groupId-like structure)
			const first = candidate[0];
			if (!Array.isArray(first)) continue;
			// A world item has at least a groupId at position getPbliteField(first, 1)
			const possibleGroupId = getPbliteField(first, 1);
			if (!Array.isArray(possibleGroupId)) continue;

			// This looks like an items array — parse each item
			for (const item of candidate) {
				if (!Array.isArray(item)) continue;

				const groupId = getPbliteField(item, 1);
				const spaceId = getNestedPbliteString(groupId, 1, 1);
				const dmId = getNestedPbliteString(groupId, 3, 1);
				const id = spaceId ?? dmId;
				if (!id || typeof id !== "string") continue;

				let sortTimestamp;
				const spaceEntry = item[1];
				if (Array.isArray(spaceEntry)) {
					for (let i = 8; i < Math.min(spaceEntry.length, 20); i++) {
						const val = spaceEntry[i];
						if (typeof val === "string" && /^\d{13,}$/.test(val)) {
							sortTimestamp = parseInt(val, 10);
							break;
						}
					}
				}
				if (!sortTimestamp) {
					const fallback = getPbliteField(item, 3);
					if (typeof fallback === "string" && /^\d+$/.test(fallback)) {
						sortTimestamp = parseInt(fallback, 10) || undefined;
					} else if (typeof fallback === "number" && fallback > 0) {
						sortTimestamp = fallback;
					}
				}

				let name = getPbliteField(item, 5);
				if (typeof name !== "string" || name.length === 0) name = undefined;

				const type = dmId ? "dm" : "space";
				if (type === "dm" && !name) {
					const field3 = getPbliteField(item, 3);
					if (typeof field3 === "string" && field3.length > 0 && field3.length < 100) {
						name = field3;
					}
				}

				addSpace(id, name, type, sortTimestamp);
				found++;
			}
		}

		return found > 0;
	}

	// --- Strategy 3: JSON object fallback (for non-PBLite responses) ---
	function extractFromObjects(obj, depth = 0) {
		if (depth > 20 || !obj) return;

		if (Array.isArray(obj)) {
			for (const item of obj) {
				extractFromObjects(item, depth + 1);
			}
			return;
		}

		if (typeof obj !== "object") return;

		if (obj.groupId) {
			const gid = obj.groupId;
			const spaceId = gid.spaceId?.spaceId || gid.spaceId;
			const dmId = gid.dmId?.dmId || gid.dmId;
			const id = typeof spaceId === "string" ? spaceId : typeof dmId === "string" ? dmId : null;
			if (id) {
				const name = obj.name || obj.displayName || undefined;
				const sortTimestamp = obj.sortTimestamp || obj.sortTimestampUsec
					? parseInt(String(obj.sortTimestamp || obj.sortTimestampUsec), 10)
					: undefined;
				addSpace(id, name, undefined, sortTimestamp);
			}
		}

		for (const val of Object.values(obj)) {
			if (typeof val === "object" && val !== null) {
				extractFromObjects(val, depth + 1);
			}
		}
	}

	// Execute strategies in order of specificity
	if (Array.isArray(data)) {
		if (!extractTargeted(data)) {
			extractMultiSection(data);
		}
	}

	// JSON object fallback if PBLite extraction found nothing
	if (spaces.length === 0 && data) {
		extractFromObjects(data);
	}

	console.log(`[ChatExport] parseSpacesFromWorld: found ${spaces.length} spaces, ${spaces.filter(s => s.name).length} with names`);
	return spaces;
}

async function handleSpacesListRequest() {
	console.log("[ChatExport] Listing spaces...");

	try {
		let spaces = null;

		// Strategy 1: Return cached spaces from intercepted paginated_world response
		const CACHE_MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes
		if (cachedSpaces && cachedSpaces.length > 0 && (Date.now() - cachedSpacesTimestamp) < CACHE_MAX_AGE_MS) {
			console.log(`[ChatExport] Using ${cachedSpaces.length} cached spaces (age: ${((Date.now() - cachedSpacesTimestamp) / 1000).toFixed(0)}s)`);
			spaces = cachedSpaces;
		}

		// Strategy 2: Replay captured request template and merge
		if (!spaces && worldRequestTemplate) {
			console.log("[ChatExport] Replaying captured paginated_world request...");
			const data = await replayWorldRequest();
			const replaySpaces = parseSpacesFromWorld(data);

			if (replaySpaces.length > 0) {
				cachedSpaces = mergeSpaces(cachedSpaces, replaySpaces);
				cachedSpacesTimestamp = Date.now();
				console.log(`[ChatExport] Replay returned ${replaySpaces.length} spaces (total cached: ${cachedSpaces.length})`);
				spaces = cachedSpaces;
			} else {
				console.log("[ChatExport] Replay returned 0 spaces, falling through...");
			}
		}

		// Strategy 3: If we have stale cached spaces, use them
		if (!spaces && cachedSpaces && cachedSpaces.length > 0) {
			console.log(`[ChatExport] Using ${cachedSpaces.length} stale cached spaces`);
			spaces = cachedSpaces;
		}

		if (!spaces || spaces.length === 0) {
			throw new Error(
				"No spaces captured yet. Please refresh the Google Chat tab " +
				"(the extension intercepts the page's own API calls to discover spaces), " +
				"then try Load Spaces again."
			);
		}

		// ── Name enrichment ──────────────────────────────────────────────────
		// Apply names from mole_world HTML (instant, no API calls)
		enrichSpaceNamesFromMap(spaces);

		// Count unnamed spaces and DMs for name enrichment via get_group
		const unnamed = spaces.filter(s => !s.name);
		if (unnamed.length > 0) {
			console.log(`[ChatExport] ${unnamed.length} spaces/DMs missing names, attempting get_group enrichment...`);

		// Only enrich up to 50 spaces to avoid rate limiting
		const toEnrich = unnamed.slice(0, 50);
		let enriched = 0;

		// Broadcast progress to popup (best-effort, popup may not be open)
		function sendProgress(current, total) {
			try {
				chrome.runtime.sendMessage({
					type: "ENRICHMENT_PROGRESS",
					current,
					total,
					done: current >= total,
				}).catch(() => {});
			} catch (_) {}
		}

		sendProgress(0, toEnrich.length);

		for (let i = 0; i < toEnrich.length; i++) {
			const space = toEnrich[i];
			try {
				const name = await fetchSpaceName(space.id);
				if (name) {
					space.name = name;
					spaceNameMap.set(space.id, name);
					enriched++;
				}
			} catch (_) {
				// Non-fatal — space will just show its ID
			}
			sendProgress(i + 1, toEnrich.length);
			// Small delay between requests to avoid rate limiting
			await sleep(100);
		}

		if (enriched > 0) {
			console.log(`[ChatExport] Enriched ${enriched}/${toEnrich.length} space names via get_group`);
		}
		}

		// Update cache with enriched names
		cachedSpaces = spaces;
		cachedSpacesTimestamp = Date.now();

		// Persist to chrome.storage.local so popup can auto-load on open
		persistSpacesToStorage(spaces);

		const namedCount = spaces.filter(s => s.name).length;
		console.log(`[ChatExport] Returning ${spaces.length} spaces (${namedCount} with names)`);

		wsSend({ type: "spaces:data", spaces });
		return spaces;

	} catch (err) {
		console.error("[ChatExport] Failed to list spaces:", err.message);
		wsSend({
			type: "export:error",
			spaceId: "_spaces",
			error: `Failed to list spaces: ${err.message}`,
		});
		throw err;
	}
}

// ─── Topic / Message Listing (list_topics PBLite) ────────────────────────────

function buildListTopicsPayload(groupId, options = {}) {
	const {
		pageSize = 1000,
		topicsPerPage = 30,
		sortTimeCursor = null,
		timestampCursor = null,
		anchorTimestamp = null,
	} = options;

	const isDirectMessage = isDmId(groupId);

	const payload = new Array(91).fill(null);
	payload[1] = 30;
	payload[3] = sortTimeCursor ? [sortTimeCursor] : null;
	payload[4] = isDirectMessage ? [3, 4] : [3, 1, 4];
	payload[5] = pageSize;
	payload[6] = topicsPerPage;
	payload[7] = buildGroupIdPayload(groupId);
	payload[8] = timestampCursor ? [timestampCursor] : null;
	payload[9] = anchorTimestamp ? [anchorTimestamp] : null;
	payload[10] = 2;
	payload[90] = buildPbliteRequestHeader();

	return payload;
}

function parseListTopicsResponse(data) {
	if (!Array.isArray(data) || !Array.isArray(data[0])) {
		return {
			topics: [],
			nextTimestampCursor: null,
			anchorTimestamp: null,
			containsFirstTopic: false,
			containsLastTopic: false,
		};
	}

	const inner = data[0];
	const topics = Array.isArray(inner[1]) ? inner[1] : [];
	const nextTimestampCursor = inner[2]?.[0] || null;
	const anchorTimestamp = inner[3]?.[0] || null;
	// containsFirstTopic = true means we've reached the OLDEST topic (chronologically first)
	// containsLastTopic = true means page includes the NEWEST topic
	const containsFirstTopic = inner.length > 4 ? inner[4] === true : false;
	const containsLastTopic = inner.length > 5 ? inner[5] === true : false;

	return { topics, nextTimestampCursor, anchorTimestamp, containsFirstTopic, containsLastTopic };
}

/**
 * Extract the sort time (microsecond timestamp string) from a raw topic array.
 * Topic structure: topic[1] = sortTime string.
 */
function getTopicSortTime(topicArr) {
	const sortTime = topicArr?.[1];
	return typeof sortTime === "string" ? sortTime : null;
}

// ─── Message Normalization ───────────────────────────────────────────────────

function parseTimestamp(ts) {
	if (!ts) return {};
	let usec;
	if (typeof ts === "string" && /^\d+$/.test(ts)) {
		usec = parseInt(ts, 10);
	} else if (typeof ts === "number") {
		usec = ts;
	}
	if (usec && usec > 1000000000000) {
		const date = new Date(usec / 1000);
		return { formatted: date.toISOString(), usec };
	}
	return { usec };
}

/**
 * Normalize a PBLite message array into an ExportedMessage.
 */
function normalizeMessage(arr, topicId, spaceId) {
	if (!Array.isArray(arr) || arr.length < 10) return null;

	const text = typeof arr[9] === "string" ? arr[9] : null;
	// Allow messages without text (could be system messages, attachments, etc.)
	// But they must have at least a message ID
	let messageId = undefined;
	if (Array.isArray(arr[0]) && arr[0].length > 1 && typeof arr[0][1] === "string") {
		messageId = arr[0][1];
	}

	if (!text && !messageId) return null;

	const { formatted, usec } = parseTimestamp(arr[2]);

	let sender = undefined;
	let senderId = undefined;
	if (Array.isArray(arr[1])) {
		const creator = arr[1];
		if (Array.isArray(creator[0]) && creator[0].length > 0) {
			senderId = creator[0][0];
		}
		if (typeof creator[1] === "string" && creator[1].length > 0) {
			sender = creator[1];
		} else {
			sender = senderId;
		}
	}

	return {
		messageId,
		topicId,
		spaceId,
		text: text || "",
		timestamp: formatted,
		timestampUsec: usec,
		sender,
		senderId,
		isThreadReply: false,
		replyIndex: 0,
	};
}

/**
 * Normalize a PBLite topic array into an ExportedTopic.
 *
 * Topic structure (from reference client):
 *   topic[0][1] = topicId (string)
 *   topic[1]    = sortTime (string, microseconds)
 *   topic[6]    = messages array
 */
function normalizeTopic(topicArr, spaceId) {
	if (!Array.isArray(topicArr)) return null;

	let topicId = undefined;
	if (Array.isArray(topicArr[0]) && typeof topicArr[0][1] === "string") {
		topicId = topicArr[0][1];
	}
	if (!topicId) return null;

	const { usec: sortTime } = parseTimestamp(topicArr[1]);

	const messages = [];
	if (Array.isArray(topicArr[6])) {
		for (const msgArr of topicArr[6]) {
			const msg = normalizeMessage(msgArr, topicId, spaceId);
			if (msg) messages.push(msg);
		}
	}

	// Sort messages chronologically and set reply indices
	messages.sort((a, b) => (a.timestampUsec || 0) - (b.timestampUsec || 0));
	messages.forEach((msg, i) => {
		msg.isThreadReply = i > 0;
		msg.replyIndex = i;
	});

	if (messages.length === 0) return null;

	return {
		topicId,
		spaceId,
		sortTime,
		messageCount: messages.length,
		messages,
	};
}

// ─── Export Orchestration ────────────────────────────────────────────────────

/**
 * Export all topics for a single space using list_topics with pagination.
 * Streams pages to the Bun server as they're fetched.
 *
 * Pagination model (from reference client):
 *   - Topics come in reverse chronological order (newest first).
 *   - Three cursors drive pagination:
 *       sortTimeCursor   – sort time of the oldest topic on the current page minus 1µs
 *       timestampCursor  – opaque cursor from the response (passed through)
 *       anchorTimestamp   – captured on page 0, passed to ALL subsequent pages
 *   - `containsFirstTopic = true` means we've reached the OLDEST topic.
 *     That's when we stop (NOT `containsLastTopic` which means "has the newest").
 */
async function exportSpace(spaceId, config, spaceIndex, totalSpaces) {
	const spaceName = config._spaceName || spaceId;
	const sinceUsec = config.sinceUsec;
	const untilUsec = config.untilUsec;

	// Signal export start
	wsSend({
		type: "export:start",
		config,
		spaceId,
		spaceName,
	});

	let page = 0;
	let totalTopics = 0;
	let totalMessages = 0;

	// Pagination cursors
	let sortTimeCursor = untilUsec ? String(untilUsec) : null;  // Start from "until" date if set
	let timestampCursor = null;
	let anchorTimestamp = null;

	const MAX_PAGES = 500; // Safety limit

	// Broadcast progress to popup
	function broadcastProgress(done = false, error = null) {
		try {
			chrome.runtime.sendMessage({
				type: "EXPORT_PROGRESS",
				spaceId,
				spaceName,
				spaceIndex,
				totalSpaces,
				page,
				totalTopics,
				totalMessages,
				done,
				error,
			}).catch(() => {});
		} catch (_) {}
	}

	broadcastProgress();

	try {
		for (let pageNum = 0; pageNum < MAX_PAGES; pageNum++) {
			page = pageNum + 1;
			console.log(`[ChatExport] Fetching page ${page} for ${spaceName}...`);

			const payload = buildListTopicsPayload(spaceId, {
				topicsPerPage: 30,
				sortTimeCursor,
				timestampCursor,
				anchorTimestamp,
			});

			const data = await apiCallPblite("list_topics", payload, spaceId);
			const parsed = parseListTopicsResponse(data);

			// Capture anchorTimestamp from the first page, pass to all subsequent
			if (pageNum === 0 && parsed.anchorTimestamp) {
				anchorTimestamp = parsed.anchorTimestamp;
			}

			// Pass through opaque timestamp cursor from the response
			timestampCursor = parsed.nextTimestampCursor;

			// Compute the next sortTimeCursor from the oldest topic on this page
			// (last element, since topics are newest-first)
			const lastRawTopic = parsed.topics[parsed.topics.length - 1];
			const lastSortTimeStr = lastRawTopic ? getTopicSortTime(lastRawTopic) : null;

			let reachedSinceBoundary = false;

			// Normalize topics and apply date filters
			const normalizedTopics = [];
			for (const rawTopic of parsed.topics) {
				const topic = normalizeTopic(rawTopic, spaceId);
				if (!topic) continue;

				// Time-range filtering (client-side)
				if (sinceUsec && topic.sortTime && topic.sortTime < sinceUsec) {
					// Topic is older than our range — flag boundary
					reachedSinceBoundary = true;
					continue;
				}
				if (untilUsec && topic.sortTime && topic.sortTime > untilUsec) {
					// Topic is newer than our range — skip but keep paginating
					continue;
				}

				normalizedTopics.push(topic);
			}

			if (normalizedTopics.length > 0) {
				const pageMessages = normalizedTopics.reduce((sum, t) => sum + t.messages.length, 0);
				totalTopics += normalizedTopics.length;
				totalMessages += pageMessages;

				wsSend({
					type: "export:data",
					spaceId,
					topics: normalizedTopics,
					page,
					raw: config.raw ? parsed.topics : undefined,
				});
			}

			broadcastProgress();

			// Determine if we should continue paginating
			// Stop when: we've reached the oldest topic, or hit the since boundary,
			// or the page was empty, or there's no sort-time cursor to advance with
			const hasMore =
				!parsed.containsFirstTopic &&
				!reachedSinceBoundary &&
				parsed.topics.length > 0;

			if (!hasMore) {
				console.log(`[ChatExport] Pagination complete for ${spaceName}: containsFirst=${parsed.containsFirstTopic}, sinceBoundary=${reachedSinceBoundary}, topicsOnPage=${parsed.topics.length}`);
				break;
			}

			// Advance the sort-time cursor: oldest topic's sort time minus 1µs
			if (lastSortTimeStr) {
				try {
					sortTimeCursor = String(BigInt(lastSortTimeStr) - 1n);
				} catch (_) {
					// Fallback if BigInt fails (shouldn't happen for valid timestamps)
					sortTimeCursor = String(parseInt(lastSortTimeStr, 10) - 1);
				}
			} else {
				// No sort time available — can't paginate further
				console.log(`[ChatExport] No sort time on last topic — stopping pagination`);
				break;
			}

			// Small delay to avoid hammering the API
			await sleep(200);
		}

		wsSend({
			type: "export:complete",
			spaceId,
			totalTopics,
			totalMessages,
		});

		broadcastProgress(true);
		console.log(`[ChatExport] Export finished for ${spaceName}: ${totalTopics} topics, ${totalMessages} messages across ${page} pages`);
	} catch (err) {
		console.error(`[ChatExport] Export failed for ${spaceName}:`, err.message);
		wsSend({
			type: "export:error",
			spaceId,
			error: err.message,
		});
		broadcastProgress(false, err.message);
	}
}

/**
 * Handle an export trigger (from Bun server CLI or popup).
 */
async function handleTriggerExport(config) {
	if (!config || !config.spaces || config.spaces.length === 0) {
		console.error("[ChatExport] No spaces specified in export config");
		return;
	}

	console.log(`[ChatExport] Starting export for ${config.spaces.length} space(s)`);

	// If we don't have an XSRF token yet, wait briefly
	if (!xsrfToken) {
		console.log("[ChatExport] Waiting for XSRF token...");
		await sleep(2000);
		if (!xsrfToken) {
			wsSend({
				type: "export:error",
				spaceId: config.spaces[0],
				error: "No XSRF token. Navigate to Google Chat and interact with the page first.",
			});
			return;
		}
	}

	// Export spaces sequentially to avoid rate limiting
	const totalSpaces = config.spaces.length;
	for (let i = 0; i < totalSpaces; i++) {
		const spaceId = config.spaces[i];
		// Look up display name from cache
		const spaceName = cachedSpaces?.find(s => s.id === spaceId)?.name;
		await exportSpace(spaceId, { ...config, _spaceName: spaceName }, i + 1, totalSpaces);
	}

	// Signal all exports done
	try {
		chrome.runtime.sendMessage({
			type: "EXPORT_PROGRESS",
			allDone: true,
			totalSpaces,
		}).catch(() => {});
	} catch (_) {}
}

// ─── Persistent Storage ──────────────────────────────────────────────────────

/**
 * Save spaces + nameMap to chrome.storage.local so the popup can auto-load
 * them without waiting for a fresh LIST_SPACES round-trip.
 */
function persistSpacesToStorage(spaces) {
	try {
		const nameMapObj = Object.fromEntries(spaceNameMap);
		chrome.storage.local.set({
			cachedSpaces: spaces,
			cachedSpacesTimestamp: Date.now(),
			spaceNameMap: nameMapObj,
		});
	} catch (_) {}
}

/**
 * Restore in-memory state from chrome.storage.local on service worker wake-up.
 */
async function restoreSpacesFromStorage() {
	try {
		const data = await chrome.storage.local.get(["cachedSpaces", "cachedSpacesTimestamp", "spaceNameMap"]);
		if (data.cachedSpaces && Array.isArray(data.cachedSpaces) && data.cachedSpaces.length > 0) {
			cachedSpaces = data.cachedSpaces;
			cachedSpacesTimestamp = data.cachedSpacesTimestamp || 0;
			console.log(`[ChatExport] Restored ${cachedSpaces.length} spaces from storage`);
		}
		if (data.spaceNameMap && typeof data.spaceNameMap === "object") {
			for (const [id, name] of Object.entries(data.spaceNameMap)) {
				if (!spaceNameMap.has(id)) spaceNameMap.set(id, name);
			}
			console.log(`[ChatExport] Restored ${spaceNameMap.size} name mappings from storage`);
		}
	} catch (_) {}
}

// ─── Utilities ───────────────────────────────────────────────────────────────

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Initialization ──────────────────────────────────────────────────────────

connectWebSocket();
restoreSpacesFromStorage();
console.log("[ChatExport] Background service worker initialized");
