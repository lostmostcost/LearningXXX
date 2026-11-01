#!/bin/sh
set -eu
case "${1:-}" in ""|--require-ready) ;; *) echo 'Usage: sh tests/acceptance/run.sh [--require-ready]' >&2; exit 2;; esac
cd "$(dirname "$0")/../.."
pnpm --filter @learningxxx/desktop-host exec tsc -p ../../../tests/acceptance/tsconfig.json
result=$(mktemp)
trap 'rm -f "$result"' EXIT
code=0
node --test --test-reporter=tap tests/acceptance/a-flow.test.ts > "$result" 2>&1 || code=$?
cat "$result"
if [ "$code" -ne 0 ]; then exit "$code"; fi
if [ "${1:-}" = --require-ready ] && grep -Eq '^# (todo|skipped) [1-9]' "$result"; then
  echo 'BLOCKED: A acceptance has unimplemented or unrun requirements; do not advance WBS-019/020.' >&2
  exit 1
fi
