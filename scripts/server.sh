#!/usr/bin/env bash
# Detached start/stop/restart for the ASC MCP HTTP server.
# Usage: ./scripts/server.sh {start|stop|restart|status|logs}

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
STATE_DIR="$REPO_DIR/.state"
PID_FILE="$STATE_DIR/server.pid"
LOG_FILE="$STATE_DIR/server.log"
ENTRY="$REPO_DIR/dist/src/http.js"
ENV_FILE="$REPO_DIR/.env"

mkdir -p "$STATE_DIR"

is_running() {
  [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null
}

start() {
  if is_running; then
    echo "Already running (PID $(cat "$PID_FILE"))."
    return 0
  fi
  if [[ ! -f "$ENTRY" ]]; then
    echo "Build output not found at $ENTRY — run: bun run build"
    exit 1
  fi
  if [[ -f "$ENV_FILE" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "$ENV_FILE"
    set +a
  else
    echo "Warning: $ENV_FILE missing — server will fail to auth."
  fi
  nohup node "$ENTRY" >>"$LOG_FILE" 2>&1 &
  echo $! >"$PID_FILE"
  sleep 0.3
  if is_running; then
    echo "Started (PID $(cat "$PID_FILE")). Logs: $LOG_FILE"
  else
    echo "Failed to start. Tail of $LOG_FILE:"
    tail -n 20 "$LOG_FILE" || true
    rm -f "$PID_FILE"
    exit 1
  fi
}

stop() {
  if ! is_running; then
    echo "Not running."
    rm -f "$PID_FILE"
    return 0
  fi
  local pid
  pid=$(cat "$PID_FILE")
  kill "$pid"
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if ! kill -0 "$pid" 2>/dev/null; then
      rm -f "$PID_FILE"
      echo "Stopped (PID $pid)."
      return 0
    fi
    sleep 0.2
  done
  kill -9 "$pid" 2>/dev/null || true
  rm -f "$PID_FILE"
  echo "Force-stopped (PID $pid)."
}

status() {
  if is_running; then
    echo "Running (PID $(cat "$PID_FILE")). Port: ${PORT:-8090}"
  else
    echo "Not running."
  fi
}

logs() {
  exec tail -f "$LOG_FILE"
}

case "${1:-}" in
  start) start ;;
  stop) stop ;;
  restart) stop; start ;;
  status) status ;;
  logs) logs ;;
  *)
    echo "Usage: $0 {start|stop|restart|status|logs}"
    exit 1
    ;;
esac
