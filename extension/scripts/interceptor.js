/**
 * Injected into the PAGE context (world: "MAIN") at document_start.
 *
 * Captures the XSRF token from outgoing Google Chat requests by
 * monkey-patching XMLHttpRequest and fetch before any Chat JS executes.
 *
 * Also:
 * - Provides a page-context fetch proxy so the content script can
 *   make API calls using the browser's full cookie jar.
 * - Intercepts paginated_world responses to capture space listings
 *   (since this endpoint requires binary protobuf we can't generate).
 * - Saves paginated_world request templates (URL + body bytes) for replay.
 */
(function () {
  // Guard against double-injection (e.g., when background re-injects scripts)
  if (window.__chatExportInterceptorLoaded) {
    return;
  }
  window.__chatExportInterceptorLoaded = true;

  let xsrfCaptured = false;

  // ─── Helpers ─────────────────────────────────────────────────────────────

  function urlMatchesEndpoint(url, endpoint) {
    return typeof url === "string" && url.includes("/api/" + endpoint);
  }

  function bodyToArray(body) {
    try {
      if (body instanceof Uint8Array) return Array.from(body);
      if (body instanceof ArrayBuffer) return Array.from(new Uint8Array(body));
      if (ArrayBuffer.isView(body)) return Array.from(new Uint8Array(body.buffer, body.byteOffset, body.byteLength));
    } catch (_) {}
    return null;
  }

  // ─── XHR intercept ───────────────────────────────────────────────────────

  const origOpen = XMLHttpRequest.prototype.open;
  const origSetHeader = XMLHttpRequest.prototype.setRequestHeader;
  const origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this._ceUrl = typeof url === "string" ? url : url?.toString() || "";
    return origOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    if (
      !xsrfCaptured &&
      name.toLowerCase() === "x-framework-xsrf-token" &&
      value
    ) {
      xsrfCaptured = true;
      window.postMessage({ type: "CE_XSRF_TOKEN", token: value }, "*");
    }
    return origSetHeader.call(this, name, value);
  };

  XMLHttpRequest.prototype.send = function (body) {
    // Capture paginated_world request body + response via XHR
    if (urlMatchesEndpoint(this._ceUrl, "paginated_world")) {
      const bodyArr = bodyToArray(body);
      if (bodyArr) {
        window.postMessage({
          type: "CE_WORLD_REQUEST",
          url: this._ceUrl,
          body: bodyArr,
        }, "*");
      }

      this.addEventListener("load", function () {
        if (this.status >= 200 && this.status < 300 && this.responseText) {
          window.postMessage({
            type: "CE_WORLD_DATA",
            body: this.responseText,
          }, "*");
        }
      });
    }

    return origSend.call(this, body);
  };

  // ─── Fetch intercept ─────────────────────────────────────────────────────

  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    const url = typeof input === "string" ? input : input?.url || "";

    // Capture XSRF token from outgoing headers
    try {
      const headers = init?.headers;
      if (headers && !xsrfCaptured) {
        let token = null;
        if (headers instanceof Headers) {
          token = headers.get("x-framework-xsrf-token");
        } else if (typeof headers === "object") {
          for (const [k, v] of Object.entries(headers)) {
            if (k.toLowerCase() === "x-framework-xsrf-token") {
              token = v;
              break;
            }
          }
        }
        if (token) {
          xsrfCaptured = true;
          window.postMessage({ type: "CE_XSRF_TOKEN", token }, "*");
        }
      }
    } catch (_) {}

    // Capture paginated_world request body for replay
    if (urlMatchesEndpoint(url, "paginated_world") && init?.body) {
      const bodyArr = bodyToArray(init.body);
      if (bodyArr) {
        window.postMessage({
          type: "CE_WORLD_REQUEST",
          url,
          body: bodyArr,
        }, "*");
      }
    }

    const result = origFetch.apply(this, arguments);

    // Capture paginated_world response body
    if (urlMatchesEndpoint(url, "paginated_world")) {
      result.then((response) => {
        if (response.ok) {
          response.clone().text().then((text) => {
            window.postMessage({
              type: "CE_WORLD_DATA",
              body: text,
            }, "*");
          }).catch(() => {});
        }
      }).catch(() => {});
    }

    return result;
  };

  // ─── Mole World HTML Capture ──────────────────────────────────────────────
  // Google Chat embeds space metadata in the initial HTML page load via
  // AF_initDataCallback script tags (ds:1 data blob). We capture this data
  // to extract ALL space names, which supplements the paginated_world API.

  let moleWorldCaptured = false;

  function captureMoleWorldHtml() {
    if (moleWorldCaptured) return;
    // Only capture on Google Chat pages
    const url = window.location.href;
    if (!url.includes("chat.google.com") && !url.includes("mail.google.com/chat")) return;

    const html = document.documentElement?.outerHTML;
    if (!html || html.length < 1000) return;

    // Quick check: does the page contain AF_initDataCallback data?
    if (!html.includes("AF_initDataCallback") && !html.includes("space/AAAA")) return;

    moleWorldCaptured = true;
    window.postMessage({ type: "CE_MOLE_WORLD_DATA", body: html }, "*");
  }

  // Try capturing after DOM is ready (the data is in inline <script> tags)
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      // Small delay to ensure all inline scripts have executed
      setTimeout(captureMoleWorldHtml, 500);
    });
  } else {
    setTimeout(captureMoleWorldHtml, 500);
  }

  // Also try on load as a fallback
  window.addEventListener("load", () => {
    setTimeout(captureMoleWorldHtml, 1000);
  });

  // ─── Page-context API proxy ──────────────────────────────────────────────
  // The content script (isolated world) cannot include cookies in requests
  // to chat.google.com. We proxy API calls through the page context where
  // the browser attaches cookies automatically.

  window.addEventListener("message", async (event) => {
    if (event.source !== window) return;
    if (event.data?.type !== "CE_API_REQUEST") return;

    const { requestId, url, method, headers, body, bodyType } = event.data;

    try {
      const fetchInit = {
        method: method || "POST",
        credentials: "include",
        headers: headers || {},
      };

      // Reconstruct binary body if needed
      if (bodyType === "protobuf" && body) {
        fetchInit.body = new Uint8Array(body);
        fetchInit.headers["Content-Type"] = "application/x-protobuf";
      } else if (body) {
        fetchInit.body = body;
      }

      const response = await origFetch(url, fetchInit);
      const text = await response.text();

      window.postMessage(
        {
          type: "CE_API_RESPONSE",
          requestId,
          ok: response.ok,
          status: response.status,
          body: text,
        },
        "*",
      );
    } catch (err) {
      window.postMessage(
        {
          type: "CE_API_RESPONSE",
          requestId,
          ok: false,
          status: 0,
          error: err.message,
        },
        "*",
      );
    }
  });
})();
