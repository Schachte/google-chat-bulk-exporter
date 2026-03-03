/**
 * Popup UI controller for Google Chat Exporter.
 *
 * Communicates with the background service worker to:
 *   - Show connection status (WS + XSRF)
 *   - Load and display available spaces
 *   - Configure and trigger exports
 *   - Show export progress
 */

// ─── DOM References ──────────────────────────────────────────────────────────

const dotWs = document.getElementById("dot-ws");
const dotXsrf = document.getElementById("dot-xsrf");
const labelWs = document.getElementById("label-ws");
const labelXsrf = document.getElementById("label-xsrf");
const btnReconnect = document.getElementById("btn-reconnect");
const btnLoadSpaces = document.getElementById("btn-load-spaces");
const btnSelectAll = document.getElementById("btn-select-all");
const btnExport = document.getElementById("btn-export");
const spaceListEl = document.getElementById("space-list");
const spaceFilterInput = document.getElementById("space-filter");
const sinceInput = document.getElementById("since");
const untilInput = document.getElementById("until");
const formatSelect = document.getElementById("format");
const rawCheckbox = document.getElementById("raw");
const outputDirInput = document.getElementById("output-dir");
const progressArea = document.getElementById("progress-area");
const progressText = document.getElementById("progress-text");
const progressBar = document.getElementById("progress-bar");

// ─── State ───────────────────────────────────────────────────────────────────

let spaces = [];
let selectAllState = false;

// Restore output directory from storage
chrome.storage.local.get(["outputDir"]).then((data) => {
	if (data.outputDir) {
		outputDirInput.value = data.outputDir;
	}
}).catch(() => {});

// Save output directory on change
outputDirInput.addEventListener("change", () => {
	const val = outputDirInput.value.trim();
	if (val) {
		chrome.storage.local.set({ outputDir: val });
	} else {
		chrome.storage.local.remove("outputDir");
	}
});

// ─── Status Polling ──────────────────────────────────────────────────────────

async function refreshStatus() {
	try {
		const state = await chrome.runtime.sendMessage({ type: "GET_STATE" });
		if (!state) return;

		dotWs.className = `dot ${state.connected ? "green" : "red"}`;
		labelWs.textContent = state.connected ? "Connected" : "Disconnected";

		dotXsrf.className = `dot ${state.hasXsrf ? "green" : "yellow"}`;
		labelXsrf.textContent = state.hasXsrf ? "Auth OK" : "No auth";

		// Enable/disable buttons based on state
		btnLoadSpaces.disabled = !state.connected || !state.hasXsrf;
		updateExportButton();
	} catch (_) {
		dotWs.className = "dot red";
		labelWs.textContent = "Error";
	}
}

// Poll status every 2 seconds
refreshStatus();
setInterval(refreshStatus, 2000);

// ─── Space Loading ───────────────────────────────────────────────────────────

// Listen for enrichment progress from background during space loading
let isLoadingSpaces = false;
chrome.runtime.onMessage.addListener((msg) => {
	if (msg.type === "ENRICHMENT_PROGRESS" && isLoadingSpaces) {
		if (msg.done) {
			btnLoadSpaces.textContent = "Finishing...";
		} else {
			btnLoadSpaces.textContent = `Enriching ${msg.current}/${msg.total} names...`;
		}
	}
	if (msg.type === "EXPORT_PROGRESS") {
		handleExportProgress(msg);
	}
});

// Auto-load cached spaces on popup open (instant, no API calls)
(async function autoLoadCachedSpaces() {
	try {
		const result = await chrome.runtime.sendMessage({ type: "GET_CACHED_SPACES" });
		if (result?.ok && result.spaces && result.spaces.length > 0) {
			spaces = result.spaces;
			renderSpaces();
			btnSelectAll.disabled = spaces.length === 0;
			const age = result.timestamp ? Math.round((Date.now() - result.timestamp) / 1000) : "?";
			console.log(`[ChatExport] Auto-loaded ${spaces.length} cached spaces (age: ${age}s)`);
		}
	} catch (_) {
		// No cached data — user will click Refresh Spaces
	}
})();

btnLoadSpaces.addEventListener("click", async () => {
	btnLoadSpaces.disabled = true;
	btnLoadSpaces.textContent = "Loading...";
	isLoadingSpaces = true;

	try {
		const result = await chrome.runtime.sendMessage({ type: "LIST_SPACES" });

		if (result?.ok && result.spaces) {
			spaces = result.spaces;
			renderSpaces();
			btnSelectAll.disabled = spaces.length === 0;
		} else {
			showError(`Failed to load spaces: ${result?.error || "unknown error"}`);
		}
	} catch (err) {
		showError(`Failed to load spaces: ${err.message}`);
	} finally {
		isLoadingSpaces = false;
		btnLoadSpaces.disabled = false;
		btnLoadSpaces.textContent = "Refresh Spaces";
	}
});

/**
 * Simple fuzzy match: all characters of the query must appear in order in the target.
 * Returns true if query fuzzy-matches target (case-insensitive).
 */
function fuzzyMatch(query, target) {
	const q = query.toLowerCase();
	const t = target.toLowerCase();
	let qi = 0;
	for (let ti = 0; ti < t.length && qi < q.length; ti++) {
		if (t[ti] === q[qi]) qi++;
	}
	return qi === q.length;
}

function renderSpaces() {
	// Remember which spaces were checked before re-render
	const previouslyChecked = new Set(
		Array.from(spaceListEl.querySelectorAll('input[type="checkbox"]:checked'))
			.map(cb => cb.dataset.spaceId)
	);

	spaceListEl.innerHTML = "";

	const filterQuery = (spaceFilterInput.value || "").trim();

	// Sort: spaces first (alphabetical), then DMs
	const sorted = [...spaces].sort((a, b) => {
		if (a.type !== b.type) return a.type === "space" ? -1 : 1;
		const nameA = (a.name || a.id).toLowerCase();
		const nameB = (b.name || b.id).toLowerCase();
		return nameA.localeCompare(nameB);
	});

	let visibleCount = 0;
	for (const space of sorted) {
		// Apply fuzzy filter against name, id, and type
		if (filterQuery) {
			const searchText = `${space.name || ""} ${space.id} ${space.type}`;
			if (!fuzzyMatch(filterQuery, searchText)) continue;
		}
		visibleCount++;

		const item = document.createElement("div");
		item.className = "space-item";

		const cb = document.createElement("input");
		cb.type = "checkbox";
		cb.dataset.spaceId = space.id;
		cb.checked = previouslyChecked.has(space.id);
		cb.addEventListener("change", updateExportButton);

		// Name column: show display name + ID underneath
		const nameCol = document.createElement("div");
		nameCol.className = "space-name-col";

		const nameEl = document.createElement("div");
		nameEl.className = "space-name";
		nameEl.textContent = space.name || space.id;
		nameEl.title = `${space.name || "(unnamed)"} — ${space.id}`;
		nameCol.appendChild(nameEl);

		// Show the raw ID underneath the name (when we have a name)
		if (space.name) {
			const idEl = document.createElement("div");
			idEl.className = "space-id";
			idEl.textContent = space.id;
			nameCol.appendChild(idEl);
		}

		const badge = document.createElement("span");
		badge.className = "space-type";
		badge.textContent = space.type === "dm" ? "DM" : "Space";

		item.appendChild(cb);
		item.appendChild(nameCol);
		item.appendChild(badge);

		// Click anywhere on the row to toggle checkbox
		item.addEventListener("click", (e) => {
			if (e.target !== cb) {
				cb.checked = !cb.checked;
				cb.dispatchEvent(new Event("change"));
			}
		});

		spaceListEl.appendChild(item);
	}

	// Show summary count
	const namedCount = sorted.filter(s => s.name).length;
	const total = sorted.length;
	if (total > 0 && namedCount < total) {
		console.log(`[ChatExport] Rendered ${visibleCount}/${total} spaces (${namedCount} with names, ${total - namedCount} ID-only)`);
	}

	updateExportButton();
}

// Realtime fuzzy filter
spaceFilterInput.addEventListener("input", () => {
	renderSpaces();
});

// ─── Select All ──────────────────────────────────────────────────────────────

btnSelectAll.addEventListener("click", () => {
	selectAllState = !selectAllState;
	const checkboxes = spaceListEl.querySelectorAll('input[type="checkbox"]');
	for (const cb of checkboxes) {
		cb.checked = selectAllState;
	}
	btnSelectAll.textContent = selectAllState ? "Deselect All" : "Select All";
	updateExportButton();
});

// ─── Export Button State ─────────────────────────────────────────────────────

function updateExportButton() {
	const selected = getSelectedSpaceIds();
	btnExport.disabled = selected.length === 0;
	btnExport.textContent = selected.length > 0
		? `Export ${selected.length} Space${selected.length > 1 ? "s" : ""}`
		: "Export Selected";
}

function getSelectedSpaceIds() {
	const checkboxes = spaceListEl.querySelectorAll('input[type="checkbox"]:checked');
	return Array.from(checkboxes).map((cb) => cb.dataset.spaceId);
}

// ─── Export Trigger ──────────────────────────────────────────────────────────

btnExport.addEventListener("click", async () => {
	const spaceIds = getSelectedSpaceIds();
	if (spaceIds.length === 0) return;

	const sinceDate = sinceInput.value;
	const untilDate = untilInput.value;
	const format = formatSelect.value;
	const raw = rawCheckbox.checked;

	// Convert dates to microseconds
	const sinceUsec = sinceDate ? new Date(sinceDate).getTime() * 1000 : undefined;
	const untilUsec = untilDate
		? new Date(untilDate + "T23:59:59.999Z").getTime() * 1000
		: undefined;

	const outputDir = outputDirInput.value.trim() || undefined;
	const config = {
		spaces: spaceIds,
		format,
		raw,
		sinceUsec,
		untilUsec,
		outputDir,
	};

	btnExport.disabled = true;
	btnExport.textContent = "Exporting...";
	showProgress("Starting export...", 0);

	try {
		const result = await chrome.runtime.sendMessage({
			type: "START_EXPORT",
			config,
		});

		if (!result?.ok) {
			showError(`Export failed: ${result?.error || "unknown error"}`);
			hideProgress();
			btnExport.disabled = false;
			updateExportButton();
		}
		// Button re-enabled by handleExportProgress when allDone
	} catch (err) {
		showError(`Export failed: ${err.message}`);
		hideProgress();
		btnExport.disabled = false;
		updateExportButton();
	}
});

// ─── Reconnect ───────────────────────────────────────────────────────────────

btnReconnect.addEventListener("click", async () => {
	try {
		await chrome.runtime.sendMessage({ type: "RECONNECT_WS" });
		// Status will update on next poll
	} catch (_) {
		// Ignore
	}
});

// ─── Export Progress Handler ─────────────────────────────────────────────────

function handleExportProgress(msg) {
	if (msg.allDone) {
		showProgress("Export complete!", 100);
		btnExport.disabled = false;
		updateExportButton();
		setTimeout(hideProgress, 4000);
		return;
	}

	if (msg.error) {
		showError(`Export failed for ${msg.spaceName || msg.spaceId}: ${msg.error}`);
		btnExport.disabled = false;
		updateExportButton();
		return;
	}

	// Build progress text: "Exporting SpaceName (2/5) — 150 messages, page 3"
	const spaceLabel = msg.spaceName || msg.spaceId;
	const spaceProgress = msg.totalSpaces > 1
		? ` (${msg.spaceIndex}/${msg.totalSpaces})`
		: "";
	const detail = msg.totalMessages > 0
		? ` — ${msg.totalMessages} messages, page ${msg.page}`
		: msg.page > 0 ? ` — page ${msg.page}` : "";

	const text = msg.done
		? `Finished ${spaceLabel}${spaceProgress}: ${msg.totalMessages} messages`
		: `Exporting ${spaceLabel}${spaceProgress}${detail}`;

	// Estimate progress: we can't know total pages ahead of time,
	// but we can show progress across spaces
	let percent = 0;
	if (msg.totalSpaces > 0) {
		const spaceBase = ((msg.spaceIndex - 1) / msg.totalSpaces) * 100;
		// Within a space, use a log curve that approaches but never reaches 100%
		const withinSpace = msg.done ? 100 : Math.min(95, msg.page * 8);
		percent = spaceBase + (withinSpace / msg.totalSpaces);
	}

	showProgress(text, percent);
	btnExport.textContent = `Exporting... (${msg.totalMessages} msgs)`;
}

// ─── Progress Display ────────────────────────────────────────────────────────

function showProgress(text, percent) {
	progressArea.classList.add("active");
	progressText.textContent = text;
	progressBar.style.width = `${Math.min(100, Math.max(0, percent))}%`;
}

function hideProgress() {
	progressArea.classList.remove("active");
}

function showError(message) {
	progressArea.classList.add("active");
	progressText.textContent = message;
	progressText.style.color = "var(--error)";
	progressBar.style.width = "0%";

	setTimeout(() => {
		hideProgress();
		progressText.style.color = "";
	}, 5000);
}
