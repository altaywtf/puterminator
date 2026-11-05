#!/usr/bin/env bash
set -euo pipefail

ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
RUNS="$ROOT/.verify"
CURRENT="$RUNS/current"
DO_DIR="$ROOT/.alchemy/local/puterminator-Puterminator"
PLAYWRIGHT_CLI="@playwright/cli@0.1.22"

die() { echo "verify: $*" >&2; exit 1; }
run_dir() { [[ -L "$CURRENT" ]] || die "no run; start one with: $0 up"; readlink "$CURRENT"; }
field() { cat "$(run_dir)/$1"; }
alive() { kill -0 "$1" 2>/dev/null; }
port_free() { ! lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }

checkout_fakes() {
  local pid
  for pid in $(pgrep -f 'src/server/testing/dev-fake.ts' || true); do
    [[ "$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')" == "$ROOT" ]] && echo "$pid"
  done
  return 0
}

cmd_up() {
  if [[ -L "$CURRENT" ]] && alive "$(field pid)"; then die "run $(basename "$(run_dir)") is still up at $(field url); run: $0 down"; fi
  [[ -z "$(checkout_fakes)" ]] || die "a dev:fake you did not start runs from this checkout (pid $(checkout_fakes | tr '\n' ' ')); leave it alone"

  local id dir fake_port=18788 worker_port=11337 url ready=0
  id="$(date +%Y%m%d-%H%M%S)"
  dir="$RUNS/$id"
  mkdir -p "$dir/evidence"
  ln -sfn "$dir" "$CURRENT"
  while ! port_free "$fake_port"; do fake_port=$((fake_port + 1)); done
  while ! port_free "$worker_port"; do worker_port=$((worker_port + 1)); done
  url="http://localhost:$worker_port"
  echo "$fake_port" >"$dir/fake-port"
  echo "$url" >"$dir/url"

  rm -rf "$DO_DIR"
  set -m
  (cd "$ROOT" && FAKE_PORT="$fake_port" DEV_PORT="$worker_port" exec pnpm dev:fake) >"$dir/server.log" 2>&1 &
  echo $! >"$dir/pid"
  set +m

  for _ in $(seq 1 120); do
    alive "$(field pid)" || { tail -20 "$dir/server.log" >&2; die "dev:fake exited; log: $dir/server.log"; }
    if grep -q "ready at $url" "$dir/server.log" && curl -fsS "$url/api/me" 2>/dev/null | grep -q '"configured":true'; then ready=1; break; fi
    sleep 1
  done
  [[ "$ready" == 1 ]] || die "not ready after 120s; log: $dir/server.log"
  echo "run $id up at $url (fake on :$fake_port, evidence in $dir/evidence)"
}

cmd_doctor() {
  local dir pid url fake_port ok=1
  dir="$(run_dir)"; pid="$(field pid)"; url="$(field url 2>/dev/null || true)"; fake_port="$(field fake-port)"
  echo "run:      $(basename "$dir")"
  if alive "$pid"; then echo "process:  $pid alive"; else echo "process:  $pid DEAD"; ok=0; fi
  echo "checkout: $ROOT ($(git -C "$ROOT" rev-parse --short HEAD))"
  if [[ -n "$url" ]] && curl -fsS "$url/api/me" 2>/dev/null | grep -q '"configured":true'; then echo "worker:   $url answers /api/me"; else echo "worker:   ${url:-none} NOT answering"; ok=0; fi
  if curl -sS "http://localhost:$fake_port/v2/oauth2/access_token" -o /dev/null -w '%{http_code}' -X POST 2>/dev/null | grep -q 400; then echo "fake:     :$fake_port answers"; else echo "fake:     :$fake_port NOT answering"; ok=0; fi
  if grep -q "put.io + Anthropic fake on http://localhost:$fake_port" "$dir/server.log"; then echo "owner:    the fake on :$fake_port is this run's"; else echo "owner:    :$fake_port is NOT this run's fake"; ok=0; fi
  [[ "$ok" == 1 ]] || die "instance not worth driving"
}

cmd_pw() {
  local dir
  dir="$(run_dir)"
  cd "$dir/evidence"
  pnpm -s dlx "$PLAYWRIGHT_CLI" -s="puterminator-$(basename "$dir")" "$@" 2>&1 | grep -v -E 'Update available|╔|║|╚' || true
}

cmd_writes() {
  grep -E '^\[fake\] (/v2/(files/(delete|rename|move|create-folder)|trash/restore)|uploaded |POST /v2/download_links/create)' "$(run_dir)/server.log" || true
}

cmd_log() { grep -F '[fake]' "$(run_dir)/server.log" || true; }

cmd_db() {
  [[ $# -eq 1 ]] || die "usage: $0 db '<read-only SQL>'"
  local f
  for f in "$DO_DIR"/[0-9a-f]*.sqlite; do
    if [[ "$(sqlite3 "file:$f?mode=ro" "SELECT count(*) FROM secrets WHERE key = 'putio_token'" 2>/dev/null)" == 1 ]]; then
      sqlite3 -header "file:$f?mode=ro" "$1"
      return
    fi
  done
  die "no signed-in user Durable Object yet; sign in first"
}

cmd_down() {
  local dir pid url fake_port
  dir="$(run_dir)"; pid="$(field pid)"; url="$(field url 2>/dev/null || true)"; fake_port="$(field fake-port)"
  cmd_pw close >/dev/null || true
  if alive "$pid"; then
    kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid"
    for _ in $(seq 1 20); do alive "$pid" || break; sleep 0.5; done
    alive "$pid" && kill -KILL -- "-$pid" 2>/dev/null || true
  fi
  rm -f "$CURRENT"
  port_free "$fake_port" || echo "verify: :$fake_port still listening" >&2
  [[ -z "$url" ]] || port_free "${url##*:}" || echo "verify: ${url##*:} still listening" >&2
  echo "run $(basename "$dir") down; evidence kept in $dir"
}

case "${1:-}" in
  up | doctor | pw | writes | log | db | down) c="$1"; shift; "cmd_$c" "$@" ;;
  *) die "usage: $0 up|doctor|pw <playwright-cli args>|writes|log|db '<sql>'|down" ;;
esac
