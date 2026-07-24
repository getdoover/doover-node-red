#!/usr/bin/env bash
#
# Docker smoke test for the Doover x Node-RED app image.
#
# Simulates a real production state: a device whose dda-agent is DOWN. Nothing
# listens on the DDA gRPC (localhost:50051) or web (localhost:49100) ports inside
# a bare container, so a default `docker run` with no linked agent already
# reproduces "agent unreachable". A named volume is mounted at /data to prove the
# pre-installed palette survives the volume mount (volume-shadowing check).
#
# Assertions:
#   1. Container stays up (no crash / crash-loop).
#   2. Node-RED comes up and serves its admin API (GET /settings).
#   3. Our 8 Doover node types are registered (GET /nodes).
#   4. The palette packages are present in the userDir DESPITE the /data volume.
#   5. Supervisor degrades gracefully (retries DDA) rather than crash-looping.
#   6. No zombie (defunct) processes accumulate while running (ps via exec).
#   7. HEALTHCHECK reaches "healthy".
#   8. docker stop performs a graceful shutdown within the stop timeout.
#
# Usage:  IMAGE=doover-node-red:smoke tools/docker-smoke/run-smoke.sh
#
# Exit code 0 = all assertions passed; non-zero = at least one failed.

set -u

IMAGE="${IMAGE:-doover-node-red:smoke}"
CONTAINER="${CONTAINER:-dnr-smoke}"
VOLUME="${VOLUME:-dnr-smoke-data}"
# Node-RED start can be gated behind the supervisor's DDA-readiness wait
# (pydoover dda_startup_timeout, default 300s) when the agent is unreachable, so
# the readiness timeout must be generous. Override for a fixed/fast image.
NODE_RED_TIMEOUT="${NODE_RED_TIMEOUT:-360}"
# docker stop grace window; SIGTERM handling should shut down well within this.
STOP_TIMEOUT="${STOP_TIMEOUT:-30}"

EXPECTED_NODES=(
  doover-connection
  doover-tag-in doover-tag-get doover-tag-out
  doover-channel-in doover-channel-out doover-aggregate-get
  doover-notify
)

pass=0; fail=0
ok()   { echo "PASS: $*"; pass=$((pass+1)); }
bad()  { echo "FAIL: $*"; fail=$((fail+1)); }
info() { echo "  ... $*"; }

cleanup() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  docker volume rm "$VOLUME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "=== Doover x Node-RED docker smoke test ==="
echo "image=$IMAGE  node_red_timeout=${NODE_RED_TIMEOUT}s  stop_timeout=${STOP_TIMEOUT}s"

# Image metadata ------------------------------------------------------------
if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "FATAL: image $IMAGE not found. Build it first (docker build -t $IMAGE .)."
  exit 2
fi
SIZE=$(docker image inspect "$IMAGE" --format '{{.Size}}')
ARCH=$(docker image inspect "$IMAGE" --format '{{.Architecture}}')
echo "image size: $(( SIZE / 1024 / 1024 )) MB   arch: $ARCH"

# Fresh state ---------------------------------------------------------------
cleanup
docker volume create "$VOLUME" >/dev/null

# Start: named volume on /data, NO reachable DDA -----------------------------
START_EPOCH=$(date +%s)
docker run -d --name "$CONTAINER" -v "$VOLUME":/data "$IMAGE" >/dev/null

# 1 + 2: container stays up, Node-RED serves admin API -----------------------
nr_up=0
while :; do
  el=$(( $(date +%s) - START_EPOCH ))
  running=$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null || echo false)
  restarts=$(docker inspect -f '{{.RestartCount}}' "$CONTAINER" 2>/dev/null || echo 0)
  if [ "$running" != "true" ]; then
    bad "container is not running (crashed) at ${el}s; last logs:"
    docker logs --tail 30 "$CONTAINER" 2>&1 | sed 's/^/      /'
    break
  fi
  if [ "${restarts:-0}" -gt 0 ]; then
    bad "container is crash-looping (RestartCount=$restarts) at ${el}s"
    break
  fi
  if docker exec "$CONTAINER" sh -c 'curl -fsS -m 2 http://127.0.0.1:1880/settings -o /dev/null' 2>/dev/null; then
    NR_READY_EPOCH=$(date +%s)
    ok "Node-RED admin API serving after $(( NR_READY_EPOCH - START_EPOCH ))s"
    ok "container stayed up (RestartCount=$restarts) until Node-RED ready"
    nr_up=1
    break
  fi
  if [ "$el" -ge "$NODE_RED_TIMEOUT" ]; then
    bad "Node-RED admin API not serving within ${NODE_RED_TIMEOUT}s"
    docker logs --tail 30 "$CONTAINER" 2>&1 | sed 's/^/      /'
    break
  fi
  sleep 3
done

# 5: supervisor degrades gracefully (retries DDA), no crash-loop -------------
if docker logs "$CONTAINER" 2>&1 | grep -q "DDA is not available. Retrying"; then
  ok "supervisor degraded gracefully: observed DDA retry logging"
else
  info "no explicit 'DDA retry' log line found (agent may have been reachable)"
fi

if [ "$nr_up" = "1" ]; then
  # 4: palette present in userDir despite the /data volume mount --------------
  for pkg in "node_modules/node-red-contrib-doover" "node_modules/@doover/nodered-core"; do
    if docker exec "$CONTAINER" test -d "/data/$pkg"; then
      ok "palette present on mounted volume: /data/$pkg"
    else
      bad "palette MISSING on mounted volume: /data/$pkg (volume shadowing)"
    fi
  done

  # 3: our 8 node types registered (GET /nodes) ------------------------------
  NODES_JSON=$(docker exec "$CONTAINER" sh -c 'curl -fsS -m 5 http://127.0.0.1:1880/nodes -H "Accept: application/json"' 2>/dev/null)
  for nt in "${EXPECTED_NODES[@]}"; do
    if printf '%s' "$NODES_JSON" | grep -q "\"$nt\""; then
      ok "node type registered: $nt"
    else
      bad "node type NOT registered: $nt"
    fi
  done

  # 6: no zombie/defunct processes -------------------------------------------
  ZCOUNT=$(docker exec "$CONTAINER" sh -c "ps -o stat,args | awk '\$1 ~ /^Z/ {n++} END{print n+0}'" 2>/dev/null)
  if [ "${ZCOUNT:-0}" = "0" ]; then
    ok "no zombie processes (defunct count=0); tini reaping works"
  else
    bad "zombie processes present (defunct count=$ZCOUNT)"
    docker exec "$CONTAINER" ps -o pid,ppid,stat,args 2>/dev/null | sed 's/^/      /'
  fi

  # 7: HEALTHCHECK goes healthy ----------------------------------------------
  hc_ok=0
  for _ in $(seq 1 20); do
    hs=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$CONTAINER" 2>/dev/null)
    if [ "$hs" = "healthy" ]; then hc_ok=1; break; fi
    sleep 3
  done
  if [ "$hc_ok" = "1" ]; then
    ok "HEALTHCHECK reached 'healthy'"
  else
    bad "HEALTHCHECK did not reach 'healthy' (last=$hs)"
  fi
fi

# 8: graceful shutdown within the stop timeout -------------------------------
STOP_START=$(date +%s)
docker stop -t "$STOP_TIMEOUT" "$CONTAINER" >/dev/null 2>&1
STOP_ELAPSED=$(( $(date +%s) - STOP_START ))
EXITCODE=$(docker inspect -f '{{.State.ExitCode}}' "$CONTAINER" 2>/dev/null || echo "?")
if [ "$STOP_ELAPSED" -lt "$STOP_TIMEOUT" ]; then
  ok "graceful shutdown in ${STOP_ELAPSED}s (< ${STOP_TIMEOUT}s), exit code $EXITCODE"
else
  bad "shutdown took ${STOP_ELAPSED}s (>= ${STOP_TIMEOUT}s) => SIGKILL, SIGTERM not honoured"
fi
if docker logs "$CONTAINER" 2>&1 | grep -qi "SIGTERM received"; then
  ok "supervisor logged SIGTERM handling"
else
  info "no 'SIGTERM received' log line (check graceful-shutdown wiring)"
fi

echo "=== summary: ${pass} passed, ${fail} failed ==="
[ "$fail" -eq 0 ]
