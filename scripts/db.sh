#!/bin/bash
# Local PostgreSQL for development: a database cluster that lives in this project
# (.postgres/), listens only on 127.0.0.1:54329, and runs only while you start it.
# Nothing system-wide is configured. Usage: scripts/db.sh init|start|stop|status|psql
set -euo pipefail
export LC_ALL="${LC_ALL:-en_US.UTF-8}"  # postgres refuses to start on macOS without it
cd "$(dirname "$0")/.."
PG_BIN="${PG_BIN:-/opt/homebrew/opt/postgresql@17/bin}"
DATA=".postgres"
PORT="${SETSCOPE_PG_PORT:-54329}"

case "${1:-}" in
  init)
    if [[ -d "$DATA" ]]; then echo "Already initialized ($DATA)."; exit 0; fi
    "$PG_BIN/initdb" -D "$DATA" -U setscope --auth=trust -E UTF8 --locale=en_US.UTF-8 >/dev/null
    {
      echo "listen_addresses = '127.0.0.1'"
      echo "port = $PORT"
      echo "unix_socket_directories = ''"
    } >> "$DATA/postgresql.conf"
    "$PG_BIN/pg_ctl" -D "$DATA" -l "$DATA/server.log" -w start >/dev/null
    "$PG_BIN/createdb" -h 127.0.0.1 -p "$PORT" -U setscope setscope
    "$PG_BIN/createdb" -h 127.0.0.1 -p "$PORT" -U setscope setscope_test
    echo "Created databases setscope and setscope_test on 127.0.0.1:$PORT (running)."
    ;;
  start)
    "$PG_BIN/pg_ctl" -D "$DATA" -l "$DATA/server.log" -w start ;;
  stop)
    "$PG_BIN/pg_ctl" -D "$DATA" -w stop ;;
  status)
    "$PG_BIN/pg_ctl" -D "$DATA" status ;;
  psql)
    shift; "$PG_BIN/psql" -h 127.0.0.1 -p "$PORT" -U setscope "${@:-setscope}" ;;
  *)
    echo "usage: scripts/db.sh init|start|stop|status|psql" >&2; exit 1 ;;
esac
