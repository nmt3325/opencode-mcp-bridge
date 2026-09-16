#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# Requires Node.js and ripgrep, not an OpenCode install. Tools run on real files.
npm test
