#!/usr/bin/env sh
# macOS/Linux 설치 진입점 — 실제 로직은 install.mjs (Node.js 필요)
exec node "$(dirname "$0")/install.mjs"
