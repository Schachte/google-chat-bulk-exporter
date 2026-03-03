# Google Chat Exporter

Bulk export Google Chat conversations (spaces and DMs) as JSON/JSONL files. A Chrome extension captures auth from your browser session and makes API calls, streaming results via WebSocket to a local Bun client that writes files to disk.


## Prerequisites

- [Bun](https://bun.sh) v1.0+
- Chrome or Chromium-based browser
- An active Google Chat session (you must be logged in)

## Quick Start

### 1. Install dependencies

```bash
cd client
bun install
```

### 2. Start the local server

```bash
bun run src/cli.ts start
```

You should see:

```
Chat Export Client v1.0.0
WebSocket server listening on ws://localhost:7890/ws
Health check: http://localhost:7890/health
Output directory: /Users/you/chat-exports
Default format: jsonl

Waiting for extension to connect...
```

### 3. Load the extension

1. Open `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked** → select the `extension/` directory
4. The extension icon appears in the toolbar

### 4. Capture authentication

1. Navigate to [chat.google.com](https://chat.google.com)
2. Click on any conversation or send a message — this triggers the XSRF token capture
3. The Bun server terminal should print `Extension connected`

### 5. Export conversations

**Via the popup:**

1. Click the extension icon
2. Verify both status dots are green (Server connected, Auth OK)
3. Click **Load Spaces** to discover your spaces and DMs
4. Check the spaces you want to export
5. Optionally set a date range and output format
6. Click **Export Selected**
7. Watch progress in the popup and the Bun terminal

**Via the CLI:**

```bash
# List spaces (server must be running, extension connected)
bun run src/cli.ts spaces

# Export specific spaces
bun run src/cli.ts export SPACE_ID_1 SPACE_ID_2

# Export with date range
bun run src/cli.ts export SPACE_ID --since 2024-01-01 --until 2024-12-31

# Export as single JSON file
bun run src/cli.ts export SPACE_ID --format json

# Include raw PBLite arrays in output
bun run src/cli.ts export SPACE_ID --raw
```

## Output Formats

### JSONL (default)

One message per line. Files are append-friendly — partial exports produce valid output.

```
{"messageId":"msg1","topicId":"topic1","spaceId":"AAAA...","text":"Hello","timestamp":"2024-03-15T10:30:00.000Z","timestampUsec":1710495000000000,"sender":"Alice","senderId":"123","isThreadReply":false,"replyIndex":0}
{"messageId":"msg2","topicId":"topic1","spaceId":"AAAA...","text":"Hi!","timestamp":"2024-03-15T10:31:00.000Z","timestampUsec":1710495060000000,"sender":"Bob","senderId":"456","isThreadReply":true,"replyIndex":1}
```

### JSON

Single file per space. Written atomically when export completes.

```json
{
  "spaceId": "AAAA...",
  "spaceName": "My Team",
  "exportedAt": "2024-03-15T12:00:00.000Z",
  "topics": [
    {
      "topicId": "topic1",
      "spaceId": "AAAA...",
      "sortTime": 1710495000000000,
      "messageCount": 3,
      "messages": [...]
    }
  ]
}
```

### JSON Batched

One file per API page, organized in a subdirectory per space. Useful for very large exports.

```
~/chat-exports/
  My_Team/
    My_Team_page0001.json
    My_Team_page0002.json
    ...
```

## CLI Reference

```
bun run src/cli.ts <command> [options]

Commands:
  start                Start the WebSocket server
  spaces               Request space listing from the extension
  export <spaceId...>  Export one or more spaces
  status               Show connection status

Options:
  --port <number>      WebSocket server port (default: 7890)
  --output <dir>       Output directory (default: ~/chat-exports)
  --format <fmt>       json, jsonl, or json-batched (default: jsonl)
  --since <date>       Start date (ISO 8601, e.g. 2024-01-01)
  --until <date>       End date (ISO 8601, e.g. 2024-12-31)
  --raw                Include raw PBLite arrays in output
  --help               Show help
```

## Configuration File

Create `chat-export.config.json` in the current directory or home directory:

```json
{
  "port": 7890,
  "outputDir": "/path/to/exports",
  "format": "jsonl",
  "raw": false,
  "throttleMs": 200
}
```

CLI flags override config file values.

## Troubleshooting

### Server dot is red (disconnected)

- Make sure the Bun server is running (`bun run src/cli.ts start`)
- Click **Reconnect** in the popup
- Check that port 7890 is not in use by another process

### Auth dot is yellow (no XSRF token)

- Navigate to chat.google.com and interact with the page (click a conversation, send a message)
- The XSRF token is captured from outgoing Google Chat requests
- If you just loaded the extension, reload the Google Chat tab

### "No Google Chat tab found"

- You need at least one tab open on `chat.google.com` or `mail.google.com/chat`
- The extension routes API calls through this tab's page context for cookie access

### Empty space list

- The `paginated_world` endpoint may return data in varying structures
- Check the background service worker console for errors: `chrome://extensions` → extension → "Inspect views: service worker"
- Try reloading the Google Chat tab and loading spaces again

### Export produces no files

- Check that `~/chat-exports/` (or your configured output dir) is writable
- Check the Bun server terminal for error messages
- Verify the space ID is correct (use the popup's Load Spaces feature)

## How It Works

1. **XSRF capture**: `interceptor.js` runs in the page context (MAIN world) and monkey-patches `XMLHttpRequest.setRequestHeader` and `window.fetch` to intercept the `x-framework-xsrf-token` header from Google Chat's own requests.

2. **API proxy**: When the extension needs to call a Chat API, `background.js` sends the request to `content.js`, which forwards it to `interceptor.js` via `window.postMessage`. The interceptor calls `fetch()` with `credentials: 'include'` so the browser attaches first-party cookies. The response flows back the same path.

3. **PBLite format**: Google Chat's internal API accepts both protobuf binary and PBLite JSON (arrays where field numbers are array indices). Since Chrome service workers can't use protobufjs, all requests use PBLite JSON with `Content-Type: application/json`.

4. **Pagination**: The `list_topics` endpoint returns topics newest-first with a cursor. The extension fetches pages sequentially, applying client-side date filtering, and streams each page to the Bun server over WebSocket.

5. **File writing**: The Bun server receives `export:data` messages and writes them immediately (JSONL/batched) or buffers them (JSON) until `export:complete`.

## Project Structure

```
chat-export/
├── extension/
│   ├── manifest.json
│   ├── popup.html
│   ├── scripts/
│   │   ├── interceptor.js   # XSRF capture + API proxy (MAIN world)
│   │   ├── content.js       # Bridge: page ↔ background
│   │   ├── background.js    # Service worker: API engine + WS client
│   │   └── popup.js         # Popup UI controller
│   └── icons/
│       ├── icon16.png
│       ├── icon48.png
│       └── icon128.png
├── client/
│   ├── package.json
│   ├── tsconfig.json
│   ├── biome.json
│   └── src/
│       ├── protocol.ts      # Shared WebSocket protocol types
│       ├── config.ts         # Configuration management
│       ├── writer.ts         # JSON/JSONL/batched file writers
│       ├── server.ts         # WebSocket server + message handlers
│       └── cli.ts            # CLI entry point
└── README.md
```

## Security Notes

- No credentials are stored or transmitted outside the browser
- The XSRF token is held in service worker memory only (lost on extension reload)
- API calls are made from the page context using the browser's existing session cookies
- The WebSocket connection is local-only (`localhost:7890`)
- No data is sent to any external server
