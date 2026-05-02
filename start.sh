#!/usr/bin/env bash
set -euo pipefail

GATEWAY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE_SERVER="${GATEWAY_DIR}/index.js"

CADDY_CONFIG_DIR="${GATEWAY_DIR}/.runtime/caddy"
CADDYFILE="${CADDY_CONFIG_DIR}/Caddyfile"

CERT_DIR="${GATEWAY_DIR}/.runtime/certs"
CERT_FILE="${CERT_DIR}/gateway.pem"
KEY_FILE="${CERT_DIR}/gateway-key.pem"

CADDY_PORT=8443

NODE_PORT=""
MODEL_ID=""

MODEL_DISCOVERY_URL="https://127.0.0.1:${CADDY_PORT}/anthropic/v1/models"
GATEWAY_BASE_URL="https://127.0.0.1:${CADDY_PORT}/anthropic"

CLEANUP_DONE=0
SUPERVISOR_INTERVAL=5
HEALTH_FAIL_LIMIT=3
NODE_RESTARTS=0
CADDY_RESTARTS=0
NODE_HEALTH_FAILURES=0
CADDY_HEALTH_FAILURES=0

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"
}

die() {
  echo "ERROR: $*" >&2
  exit 1
}

check_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    die "command not found: $1"
  fi
}

normalize_pids() {
  tr ' ' '\n' | awk 'NF && !seen[$1]++'
}

build_excluded_pids() {
  local pid="$$"

  while [[ -n "$pid" && "$pid" != "0" ]]; do
    echo "$pid"
    pid=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')
  done | normalize_pids | paste -sd, -
}

find_pids_by_pattern() {
  local pattern="$1"

  ps -axo pid=,command= | awk -v pattern="$pattern" -v excluded="$EXCLUDED_PIDS" '
    BEGIN {
      split(excluded, pids, ",");
      for (i in pids) {
        skip[pids[i]] = 1;
      }
    }
    index($0, "awk -v pattern=") > 0 { next }
    index($0, "ps -axo") > 0 { next }
    !skip[$1] && index($0, pattern) > 0 { print $1 }
  ' | normalize_pids
}

terminate_pids() {
  local name="$1"
  local pids
  pids=$(normalize_pids)

  if [[ -z "$pids" ]]; then
    return 0
  fi

  log "Stopping existing $name process(es) (PID: $(echo "$pids" | tr '\n' ' '))"
  echo "$pids" | xargs kill -TERM 2>/dev/null || true

  for _ in $(seq 1 20); do
    local alive=""
    local pid
    for pid in $pids; do
      if kill -0 "$pid" >/dev/null 2>&1; then
        alive="$alive $pid"
      fi
    done

    if [[ -z "$alive" ]]; then
      return 0
    fi

    sleep 0.2
  done

  log "Force killing existing $name process(es) that did not exit cleanly"
  echo "$pids" | xargs kill -KILL 2>/dev/null || true
}

wait_for_port_free() {
  local port="$1"
  local name="$2"
  local max_retries=20

  for _ in $(seq 1 "$max_retries"); do
    if ! lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
      return 0
    fi

    sleep 0.2
  done

  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    log "Port $port is already listening:"
    lsof -nP -iTCP:"$port" -sTCP:LISTEN
    die "Port $port is still occupied after stopping old $name process(es)."
  fi
}

check_port_free() {
  local port="$1"
  local name="$2"

  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    log "Port $port is already listening:"
    lsof -nP -iTCP:"$port" -sTCP:LISTEN
    die "Port $port is still occupied after stopping old $name process(es)."
  fi
}

wait_for_ready() {
  local port="$1"
  local label="$2"
  local max_retries=10
  local scheme="http"

  if [[ "$port" == "$CADDY_PORT" ]]; then
    scheme="https"
  fi

  if [[ "$scheme" == "https" ]] && [[ -z "${CADDY_CA_CERT:-}" ]]; then
    CADDY_CA_CERT=$(mkcert -CAROOT 2>/dev/null)/rootCA.pem
  fi

  for i in $(seq 1 "$max_retries"); do
    local curl_opts=(-sS --max-time 1)
    if [[ "$scheme" == "https" && -f "${CADDY_CA_CERT:-}" ]]; then
      curl_opts+=(--cacert "$CADDY_CA_CERT")
    else
      curl_opts+=(-k)
    fi
    if curl "${curl_opts[@]}" "${scheme}://127.0.0.1:${port}/" >/dev/null 2>&1; then
      log "$label is ready"
      return 0
    fi
    sleep 1
  done

  log "$label did not start within ${max_retries}s"
  return 1
}

terminate_pid() {
  local name="$1"
  local pid="$2"

  if [[ -z "$pid" ]]; then
    return 0
  fi

  if ! kill -0 "$pid" >/dev/null 2>&1; then
    wait "$pid" 2>/dev/null || true
    return 0
  fi

  log "Stopping $name (PID: $pid)"
  kill -TERM "$pid" 2>/dev/null || true

  for _ in $(seq 1 20); do
    if ! kill -0 "$pid" >/dev/null 2>&1; then
      wait "$pid" 2>/dev/null || true
      return 0
    fi

    sleep 0.2
  done

  log "Force killing $name (PID: $pid)"
  kill -KILL "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
}

cleanup() {
  if [[ "${CLEANUP_DONE:-0}" == "1" ]]; then
    return
  fi
  CLEANUP_DONE=1

  log "Stopping services..."

  terminate_pid "Caddy" "${CADDY_PID:-}"
  terminate_pid "Node Gateway" "${NODE_PID:-}"
}

process_is_running() {
  local pid="$1"
  local state

  state=$(ps -o state= -p "$pid" 2>/dev/null | tr -d ' ' || true)
  [[ -n "$state" && "$state" != Z* ]]
}

is_node_healthy() {
  curl -sS --max-time 2 -k "http://127.0.0.1:${NODE_PORT}/" >/dev/null 2>&1
}

is_caddy_healthy() {
  curl -sS --max-time 2 -k "https://127.0.0.1:${CADDY_PORT}/" >/dev/null 2>&1
}

start_node_gateway() {
  log "Starting Node Gateway..."

  cd "$GATEWAY_DIR" || die "Cannot cd to $GATEWAY_DIR"

  node "$NODE_SERVER" &
  NODE_PID=$!
  NODE_HEALTH_FAILURES=0

  if wait_for_ready "$NODE_PORT" "Node Gateway"; then
    log "Node Gateway PID: $NODE_PID"
    return 0
  fi

  terminate_pid "Node Gateway" "$NODE_PID"
  NODE_PID=""
  return 1
}

write_caddyfile() {
  mkdir -p "$CADDY_CONFIG_DIR"
  cat > "$CADDYFILE" <<CADDYEOF
https://127.0.0.1:${CADDY_PORT} {
    tls ${CERT_FILE} ${KEY_FILE}

    reverse_proxy http://127.0.0.1:${NODE_PORT}
}
CADDYEOF
}

start_caddy_gateway() {
  log "Starting Caddy..."
  write_caddyfile

  caddy run --config "$CADDYFILE" &
  CADDY_PID=$!
  CADDY_HEALTH_FAILURES=0

  if wait_for_ready "$CADDY_PORT" "Caddy"; then
    log "Caddy PID: $CADDY_PID"
    return 0
  fi

  terminate_pid "Caddy" "$CADDY_PID"
  CADDY_PID=""
  return 1
}

kill_existing() {
  local port="$1"
  local name="$2"
  local pids
  pids=$(lsof -t -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null | normalize_pids || true)
  if [[ -n "$pids" ]]; then
    echo "$pids" | terminate_pids "$name on port $port"
  fi

  wait_for_port_free "$port" "$name"
}

restart_node_gateway() {
  NODE_RESTARTS=$((NODE_RESTARTS + 1))
  log "Restarting Node Gateway (restart #$NODE_RESTARTS)..."
  terminate_pid "Node Gateway" "${NODE_PID:-}"
  NODE_PID=""
  kill_existing "$NODE_PORT" "Node Gateway"

  until start_node_gateway; do
    log "Node Gateway restart failed; retrying in ${SUPERVISOR_INTERVAL}s..."
    sleep "$SUPERVISOR_INTERVAL"
  done
}

restart_caddy_gateway() {
  CADDY_RESTARTS=$((CADDY_RESTARTS + 1))
  log "Restarting Caddy (restart #$CADDY_RESTARTS)..."
  terminate_pid "Caddy" "${CADDY_PID:-}"
  CADDY_PID=""
  kill_existing "$CADDY_PORT" "Caddy"

  until start_caddy_gateway; do
    log "Caddy restart failed; retrying in ${SUPERVISOR_INTERVAL}s..."
    sleep "$SUPERVISOR_INTERVAL"
  done
}

supervise_services() {
  log "Supervisor is monitoring services every ${SUPERVISOR_INTERVAL}s."

  while true; do
    if [[ -n "${NODE_PID:-}" ]] && ! process_is_running "$NODE_PID"; then
      wait "$NODE_PID" 2>/dev/null || true
      log "Node Gateway exited unexpectedly."
      restart_node_gateway
    elif ! is_node_healthy; then
      NODE_HEALTH_FAILURES=$((NODE_HEALTH_FAILURES + 1))
      log "Node Gateway health check failed (${NODE_HEALTH_FAILURES}/${HEALTH_FAIL_LIMIT})."
      if [[ "$NODE_HEALTH_FAILURES" -ge "$HEALTH_FAIL_LIMIT" ]]; then
        restart_node_gateway
      fi
    else
      if [[ "$NODE_HEALTH_FAILURES" -gt 0 ]]; then
        log "Node Gateway health recovered."
      fi
      NODE_HEALTH_FAILURES=0
    fi

    if [[ -n "${CADDY_PID:-}" ]] && ! process_is_running "$CADDY_PID"; then
      wait "$CADDY_PID" 2>/dev/null || true
      log "Caddy exited unexpectedly."
      restart_caddy_gateway
    elif ! is_caddy_healthy; then
      CADDY_HEALTH_FAILURES=$((CADDY_HEALTH_FAILURES + 1))
      log "Caddy health check failed (${CADDY_HEALTH_FAILURES}/${HEALTH_FAIL_LIMIT})."
      if [[ "$CADDY_HEALTH_FAILURES" -ge "$HEALTH_FAIL_LIMIT" ]]; then
        restart_caddy_gateway
      fi
    else
      if [[ "$CADDY_HEALTH_FAILURES" -gt 0 ]]; then
        log "Caddy health recovered."
      fi
      CADDY_HEALTH_FAILURES=0
    fi

    sleep "$SUPERVISOR_INTERVAL"
  done
}

kill_existing_gateway_processes() {
  find_pids_by_pattern "$NODE_SERVER" | terminate_pids "Node Gateway"
  find_pids_by_pattern "caddy run --config $CADDYFILE" | terminate_pids "Caddy Gateway"
}

load_node_gateway_config() {
  local values

  [[ -f "$NODE_SERVER" ]] || die "Node Gateway source not found: $NODE_SERVER"
  [[ -f "$GATEWAY_DIR/backends.json" ]] || die "Backends config not found: $GATEWAY_DIR/backends.json"

  if ! node --check "$NODE_SERVER" >/dev/null 2>&1; then
    die "Node Gateway syntax check failed: $NODE_SERVER"
  fi

  values=$(node -e '
    const fs = require("fs");
    const path = require("path");
    const file = path.join(path.dirname(process.argv[1]), "src", "config.js");
    const src = fs.readFileSync(file, "utf8");
    const portMatch = src.match(/const PORT = (\d+);/);
    if (!portMatch) {
      process.exit(2);
    }
    process.stdout.write(portMatch[1]);
  ' "$NODE_SERVER") || die "Failed to read Node Gateway config from src/config.js"

  NODE_PORT=$(printf '%s\n' "$values" | sed -n '1p')
  [[ -n "$NODE_PORT" ]] || die "Node Gateway PORT is empty"
}

load_backends_config() {
  local values

  values=$(node -e '
    const backends = require("'"$GATEWAY_DIR"'/backends.json");
    const providers = [...new Set(backends.map(b => b.provider || b.type + " backend"))];
    const allModels = backends.flatMap(b => b.models);
    const modelLines = backends.flatMap(b => {
      const provider = b.provider || b.type + " backend";
      return b.models.map(m => m + "\t" + provider + "\t" + b.type);
    });
    process.stdout.write(
      providers.join("\n") + "\n---\n" +
      allModels.join("\n") + "\n---\n" +
      modelLines.join("\n")
    );
  ') || die "Failed to read backends config"

  BACKEND_NAMES=$(printf '%s\n' "$values" | awk 'BEGIN{s=0} /^---$/{s++; next} s==0{print}')
  ALL_MODELS=$(printf '%s\n' "$values" | awk 'BEGIN{s=0} /^---$/{s++; next} s==1{print}')
  MODEL_ROUTES=$(printf '%s\n' "$values" | awk 'BEGIN{s=0} /^---$/{s++; next} s==2{print}')
  MODEL_ID=$(printf '%s\n' "$ALL_MODELS" | head -1)
}

EXCLUDED_PIDS=$(build_excluded_pids)

trap cleanup EXIT
trap 'cleanup; exit 130' INT TERM

# ============================================================
# 1. Check dependencies
# ============================================================

log "Checking dependencies..."

check_cmd node
check_cmd caddy
check_cmd mkcert
check_cmd curl
check_cmd lsof

# ============================================================
# 2. Validate Node gateway source
# ============================================================

log "Loading Node Gateway source of truth: $NODE_SERVER"
load_node_gateway_config

log "Loading backends config: $GATEWAY_DIR/backends.json"
load_backends_config
log "Providers: $(echo "$BACKEND_NAMES" | tr '\n' ', ' | sed 's/, $//')"
log "Available models: $(echo "$ALL_MODELS" | tr '\n' ', ' | sed 's/, $//')"

# ============================================================
# 3. Clean up stale processes & free ports
# ============================================================

log "Cleaning existing gateway processes and occupied ports..."

kill_existing_gateway_processes
kill_existing "$NODE_PORT" "Node Gateway"
kill_existing "$CADDY_PORT" "Caddy"

# ============================================================
# 4. Create runtime directories
# ============================================================

log "Creating directories..."

mkdir -p "$GATEWAY_DIR"
mkdir -p "$CADDY_CONFIG_DIR"
mkdir -p "$CERT_DIR"

# ============================================================
# 5. Install local mkcert root CA
# ============================================================

log "Ensuring mkcert local CA is installed..."

mkcert -install >/dev/null

# ============================================================
# 6. Generate local HTTPS certificate
# ============================================================

if [[ ! -f "$CERT_FILE" || ! -f "$KEY_FILE" ]]; then
  log "Generating local TLS certificate..."

  mkcert \
    -cert-file "$CERT_FILE" \
    -key-file "$KEY_FILE" \
    127.0.0.1 localhost
else
  log "TLS certificate already exists."
fi

# ============================================================
# 7. Caddyfile is generated by write_caddyfile() inside start_caddy_gateway()
#    (idempotent & self-healing: if the file is removed at runtime,
#     the next restart rebuilds it automatically)
# ============================================================

# ============================================================
# 8. Re-check that ports are free
# ============================================================

kill_existing "$NODE_PORT" "Node Gateway"
kill_existing "$CADDY_PORT" "Caddy"

check_port_free "$NODE_PORT" "Node Gateway"
check_port_free "$CADDY_PORT" "Caddy"

# ============================================================
# 9. Start Node gateway
# ============================================================

start_node_gateway || die "Node Gateway did not start"

# ============================================================
# 10. Start Caddy
# ============================================================

start_caddy_gateway || die "Caddy did not start"

# ============================================================
# 11. Verify model discovery endpoint
# ============================================================

log "Checking model discovery endpoint..."

curl -sS --max-time 10 -k "$MODEL_DISCOVERY_URL" > /tmp/claude-gateway-models.json

log "Gateway is ready."

echo
echo "Gateway base URL:"
echo "  ${GATEWAY_BASE_URL}"
echo
echo "Providers:"
echo "${BACKEND_NAMES}" | while read -r line; do [[ -n "$line" ]] && echo "  - $line"; done
echo
echo "Models ("$(echo "$ALL_MODELS" | wc -l | tr -d ' ') total"):"
printf '%s\n' "$MODEL_ROUTES" | awk -F'\t' '{ printf "  - %-28s [%s \xc2\xb7 %s]\n", $1, $2, $3 }'
echo

log "Services are running. Press Ctrl+C to stop."

supervise_services
