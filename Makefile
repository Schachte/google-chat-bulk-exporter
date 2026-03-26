# Google Chat Bulk Exporter
# ─────────────────────────
# Manages the local Bun server (client/) and extension connectivity.

PORT       ?= 7890
CLIENT_DIR := client
SERVER_URL := http://localhost:$(PORT)
BUN        := bun

.PHONY: help install start dev stop status ext-status spaces logs lint format typecheck build clean

help: ## Show available targets
	@echo ""
	@echo "Google Chat Bulk Exporter"
	@echo "════════════════════════════════════════"
	@echo ""
	@grep -E '^[a-zA-Z_-]+:.*##' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*## "}; {printf "  \033[36m%-15s\033[0m %s\n", $$1, $$2}'
	@echo ""

# ── Dependencies ────────────────────────────────────────────────

install: ## Install server dependencies
	@echo "Installing dependencies..."
	@cd $(CLIENT_DIR) && $(BUN) install
	@echo "Done."

# ── Server ──────────────────────────────────────────────────────

start: install ## Start the server (background, port=$(PORT))
	@if curl -sf $(SERVER_URL)/health > /dev/null 2>&1; then \
		echo "Server already running on port $(PORT)."; \
	else \
		echo "Starting server on port $(PORT)..."; \
		cd $(CLIENT_DIR) && nohup $(BUN) run src/cli.ts start --port $(PORT) > ../server.log 2>&1 & \
		echo $$! > server.pid; \
		sleep 1; \
		if curl -sf $(SERVER_URL)/health > /dev/null 2>&1; then \
			echo "Server started (pid $$(cat server.pid))."; \
		else \
			echo "Server may still be starting — check 'make status' or 'make logs'."; \
		fi; \
	fi

dev: install ## Start the server in watch mode (foreground)
	@echo "Starting dev server on port $(PORT)..."
	cd $(CLIENT_DIR) && $(BUN) run --watch src/cli.ts start --port $(PORT)

stop: ## Stop the background server
	@if [ -f server.pid ]; then \
		PID=$$(cat server.pid); \
		if kill -0 $$PID 2>/dev/null; then \
			kill $$PID; \
			echo "Server (pid $$PID) stopped."; \
		else \
			echo "Process $$PID not running (stale pid file)."; \
		fi; \
		rm -f server.pid; \
	else \
		echo "No server.pid file found. Checking port $(PORT)..."; \
		PID=$$(lsof -ti :$(PORT) 2>/dev/null); \
		if [ -n "$$PID" ]; then \
			kill $$PID; \
			echo "Killed process $$PID on port $(PORT)."; \
		else \
			echo "Nothing running on port $(PORT)."; \
		fi; \
	fi

restart: stop start ## Restart the server

logs: ## Tail the server log
	@if [ -f server.log ]; then \
		tail -f server.log; \
	else \
		echo "No server.log found. Start the server with 'make start' first."; \
	fi

# ── Status & Extension ─────────────────────────────────────────

status: ## Check server health + extension connection
	@echo "── Server ──────────────────────────────"
	@if curl -sf $(SERVER_URL)/health 2>/dev/null; then \
		echo ""; \
	else \
		echo "  Server is NOT reachable on port $(PORT)."; \
	fi
	@echo ""
	@echo "── Extension ───────────────────────────"
	@STATUS=$$(curl -sf $(SERVER_URL)/api/status 2>/dev/null); \
	if [ -z "$$STATUS" ]; then \
		echo "  Cannot reach server — start it first."; \
	else \
		CONNECTED=$$(echo "$$STATUS" | grep -o '"extensionConnected":[a-z]*' | cut -d: -f2); \
		if [ "$$CONNECTED" = "true" ]; then \
			echo "  Extension: CONNECTED"; \
		else \
			echo "  Extension: NOT CONNECTED"; \
			echo ""; \
			echo "  To connect the extension:"; \
			echo "    1. Open chrome://extensions"; \
			echo "    2. Enable Developer Mode"; \
			echo "    3. Load unpacked -> select ./extension/"; \
			echo "    4. Open https://chat.google.com in a tab"; \
		fi; \
		echo ""; \
		echo "  Raw: $$STATUS"; \
	fi

ext-status: ## Check extension connection only
	@STATUS=$$(curl -sf $(SERVER_URL)/api/status 2>/dev/null); \
	if [ -z "$$STATUS" ]; then \
		echo "Server not reachable. Run 'make start' first."; \
		exit 1; \
	fi; \
	CONNECTED=$$(echo "$$STATUS" | grep -o '"extensionConnected":[a-z]*' | cut -d: -f2); \
	if [ "$$CONNECTED" = "true" ]; then \
		echo "Extension: CONNECTED"; \
	else \
		echo "Extension: NOT CONNECTED"; \
		echo ""; \
		echo "To connect:"; \
		echo "  1. Open chrome://extensions"; \
		echo "  2. Enable Developer Mode"; \
		echo "  3. Load unpacked -> select ./extension/"; \
		echo "  4. Open https://chat.google.com in a tab"; \
		exit 1; \
	fi

spaces: ## List available Google Chat spaces (requires extension)
	@STATUS=$$(curl -sf $(SERVER_URL)/api/status 2>/dev/null); \
	if [ -z "$$STATUS" ]; then \
		echo "Server not reachable. Run 'make start' first."; \
		exit 1; \
	fi; \
	echo "Fetching spaces (this may take a few seconds)..."; \
	curl -sf $(SERVER_URL)/api/spaces | python3 -m json.tool 2>/dev/null || \
		echo "Failed — is the extension connected? Run 'make ext-status'."

exports: ## Show active and recent exports
	@curl -sf $(SERVER_URL)/api/exports | python3 -m json.tool 2>/dev/null || \
		echo "Server not reachable. Run 'make start' first."

# ── Code Quality ────────────────────────────────────────────────

lint: ## Run linter
	cd $(CLIENT_DIR) && $(BUN) run lint

lint-fix: ## Run linter with auto-fix
	cd $(CLIENT_DIR) && $(BUN) run lint:fix

format: ## Format source code
	cd $(CLIENT_DIR) && $(BUN) run format

typecheck: ## Run TypeScript type checking
	cd $(CLIENT_DIR) && $(BUN) run typecheck

# ── Build ───────────────────────────────────────────────────────

build: install ## Build for production
	cd $(CLIENT_DIR) && $(BUN) run build

clean: ## Remove build artifacts, logs, and pid file
	rm -f server.pid server.log
	rm -rf $(CLIENT_DIR)/dist
	@echo "Cleaned."
