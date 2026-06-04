#!/bin/bash
# SessionStart hook for Claude Code on the web.
# Installs JS dependencies so lint / build / tests work in remote sessions.
set -euo pipefail

# Only run in remote (Claude Code on the web) environments; no-op locally.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"

# `npm install` (not `ci`) so the cached container layer is reused on later runs.
npm install --no-audit --no-fund
