#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# Requires npm run setup:native. No fake OpenCode server is used.
npm test
