#!/bin/sh
# Application files are immutable. Only the database and log directories are writable.
set -eu

# DB_PATH 是文件路径，dirname 才是目录。允许通过 DB_PATH_DIR 直接覆盖以便自定义。
if [ -n "${DB_PATH_DIR:-}" ]; then
  DATA_DIR="$DB_PATH_DIR"
elif [ -n "${DB_PATH:-}" ]; then
  DATA_DIR=$(dirname "$DB_PATH")
else
  DATA_DIR="/app/data"
fi

LOG_DIR=${LOG_DIR:-"$DATA_DIR/logs"}
export LOG_DIR

fatal_dir() {
  echo "[entrypoint] $1 is not writable by UID $(id -u). Prepare the host volume ownership before starting the container." >&2
  exit 1
}

if [ "$(id -u)" = 0 ]; then
  # An explicit root start may repair a data volume, then run this same preflight as node.
  # Never permit a misconfigured DB_PATH/LOG_DIR to turn the application directory writable.
  for dir in "$DATA_DIR" "$LOG_DIR"; do
    mkdir -p "$dir" || fatal_dir "$dir"
    resolved_dir=$(readlink -f "$dir")
    case "$resolved_dir" in
      /|/app|/app/|/app/dist*|/app/node_modules*|/app/public*)
        echo "[entrypoint] Refusing writable application directory: $dir" >&2; exit 1 ;;
    esac
    chown -R node:node "$dir" || fatal_dir "$dir"
    [ "${FILE_LOGGING:-true}" != false ] || break
  done
  exec su-exec node /usr/local/bin/entrypoint.sh "$@"
fi

for dir in "$DATA_DIR" "$LOG_DIR"; do
  mkdir -p "$dir" 2>/dev/null || fatal_dir "$dir"
  [ -w "$dir" ] || fatal_dir "$dir"
  [ "${FILE_LOGGING:-true}" != false ] || break
done
if [ -n "${DB_PATH:-}" ]; then
  for file in "$DB_PATH" "$DB_PATH-wal" "$DB_PATH-shm"; do
    if [ -e "$file" ]; then
      [ -r "$file" ] && [ -w "$file" ] || fatal_dir "$file"
    fi
  done
fi
# Non-root never calls chown, setuid, setgid, or su-exec.
exec "$@"
