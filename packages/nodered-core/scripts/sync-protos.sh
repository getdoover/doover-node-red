#!/usr/bin/env bash
#
# sync-protos.sh — re-vendor the Doover .proto files into @doover/nodered-core.
#
# The JS transport layer loads these protos at runtime via @grpc/proto-loader
# (no codegen). They MUST stay byte-for-byte identical to the platform contract
# in pydoover so the transport can't silently drift. CI runs this and fails on a
# non-empty `git diff` of packages/nodered-core/protos/.
#
# Usage:
#   ./scripts/sync-protos.sh                # copies from the default source
#   PYDOOVER_PROTOS=/path/to/protos ./scripts/sync-protos.sh
#
set -euo pipefail

# Resolve this package's protos/ dir regardless of the caller's cwd.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)/protos"

# Source: override with PYDOOVER_PROTOS; default assumes the pydoover checkout
# sits next to the doover-apps tree (as it does on dev machines / CI).
SRC_DIR="${PYDOOVER_PROTOS:-$HOME/pydoover/protos}"

# Only these three are consumed by the transport layer. device_agent.proto also
# imports google/protobuf/struct.proto, which is a well-known type bundled with
# @grpc/proto-loader — it does NOT need to be vendored here.
PROTOS=(
  device_agent.proto
  platform_iface.proto
  modbus_iface.proto
)

if [ ! -d "${SRC_DIR}" ]; then
  echo "error: source proto dir not found: ${SRC_DIR}" >&2
  echo "       set PYDOOVER_PROTOS to your pydoover/protos path." >&2
  exit 1
fi

mkdir -p "${DEST_DIR}"
for p in "${PROTOS[@]}"; do
  if [ ! -f "${SRC_DIR}/${p}" ]; then
    echo "error: missing source proto: ${SRC_DIR}/${p}" >&2
    exit 1
  fi
  cp "${SRC_DIR}/${p}" "${DEST_DIR}/${p}"
  echo "synced ${p}"
done

echo "protos synced from ${SRC_DIR} -> ${DEST_DIR}"
