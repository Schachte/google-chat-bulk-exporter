/**
 * Content script for Google Chat Exporter (isolated world).
 *
 * Bridges between:
 *   - Page context (interceptor.js) — XSRF token, API proxy
 *   - Background service worker     — export logic, WebSocket
 *
 * Also detects the current space ID and name from the page URL/title.
 */

// ─── Extension Context Guard ─────────────────────────────────────────────────
// On re-injection, reset the invalidated flag so the fresh context works.

let contextInvalidated = false;

function checkContext() {
  if (contextInvalidated) return false;
  try {
    void chrome.runtime.id;
    return true;
  } catch (_) {
    contextInvalidated = true;
    console.warn("[ChatExport] Extension context invalidated — reload the page");
    return false;
  }
}

// ─── XSRF Token Relay ────────────────────────────────────────────────────────

window.addEventListener("message", (event) => {
  if (event.source !== window) return;

  if (event.data?.type === "CE_XSRF_TOKEN" && event.data.token) {
    if (!checkContext()) return;
    chrome.runtime.sendMessage({
      type: "XSRF_TOKEN",
      token: event.data.token,
    });
  }

  // Relay intercepted paginated_world response data to background
  if (event.data?.type === "CE_WORLD_DATA" && event.data.body) {
    if (!checkContext()) return;
    chrome.runtime.sendMessage({
      type: "WORLD_DATA",
      body: event.data.body,
    });
  }

  // Relay intercepted paginated_world request template for replay
  if (event.data?.type === "CE_WORLD_REQUEST" && event.data.body) {
    if (!checkContext()) return;
    chrome.runtime.sendMessage({
      type: "WORLD_REQUEST",
      url: event.data.url,
      body: event.data.body,
    });
  }

  // Relay mole_world HTML data (initial page load with space names)
  if (event.data?.type === "CE_MOLE_WORLD_DATA" && event.data.body) {
    if (!checkContext()) return;
    chrome.runtime.sendMessage({
      type: "MOLE_WORLD_DATA",
      body: event.data.body,
    });
  }

  // API responses are handled by the per-request listener in the
  // API_REQUEST handler below (via sendResponse). No relay needed here.
});

// ─── API Request Proxy ───────────────────────────────────────────────────────
// Background sends API requests; we forward them to the page context
// where cookies are automatically included.

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (!checkContext()) return;

  if (request.type === "API_REQUEST") {
    const requestId =
      "api_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);

    // Set up a one-time listener for the response
    const responseHandler = (event) => {
      if (event.source !== window) return;
      if (event.data?.type !== "CE_API_RESPONSE") return;
      if (event.data.requestId !== requestId) return;

      window.removeEventListener("message", responseHandler);

      sendResponse({
        ok: event.data.ok,
        status: event.data.status,
        body: event.data.body,
        error: event.data.error,
      });
    };

    window.addEventListener("message", responseHandler);

    // Forward to page context
    window.postMessage(
      {
        type: "CE_API_REQUEST",
        requestId,
        url: request.url,
        method: request.method || "POST",
        headers: request.headers || {},
        body: request.body,
        bodyType: request.bodyType,
      },
      "*",
    );

    // Keep the message channel open for async response
    return true;
  }

  if (request.type === "GET_CURRENT_SPACE") {
    sendResponse(detectCurrentSpace());
    return false;
  }
});

// ─── Space Detection ─────────────────────────────────────────────────────────

function detectCurrentSpace() {
  const url = window.location.href;
  let spaceId = null;

  // New format: /app/chat/SPACE_ID
  const appChatMatch = url.match(/\/app\/chat\/([A-Za-z0-9_-]+)/);
  if (appChatMatch) spaceId = appChatMatch[1];

  // Legacy: /room/SPACE_ID
  if (!spaceId) {
    const roomMatch = url.match(/\/room\/([A-Za-z0-9_-]+)/);
    if (roomMatch) spaceId = roomMatch[1];
  }

  // Legacy mail.google.com format
  if (!spaceId) {
    const spaceMatch = url.match(/\/chat\/.*#chat\/space\/([A-Za-z0-9_-]+)/);
    if (spaceMatch) spaceId = spaceMatch[1];
  }

  // Hash fragment fallback
  if (!spaceId) {
    const hashMatch = window.location.hash.match(/space\/([A-Za-z0-9_-]+)/);
    if (hashMatch) spaceId = hashMatch[1];
  }

  // Room name from title
  let spaceName = null;
  if (document.title) {
    const titleMatch = document.title.match(
      /^(.+?)\s*[-–—]\s*(Chat|Google Chat|Gmail)$/,
    );
    if (titleMatch && titleMatch[1].trim()) {
      spaceName = titleMatch[1].trim();
    } else if (
      document.title.trim() &&
      document.title.trim() !== "Google Chat"
    ) {
      spaceName = document.title.trim();
    }
  }

  return { spaceId, spaceName };
}
