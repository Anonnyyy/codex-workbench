#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
node_bin="./runtime/node"
if [[ ! -x "$node_bin" ]]; then node_bin="$(command -v node)"; fi
exec "$node_bin" scripts/launch.mjs
