#!/usr/bin/env bash
# Runner с закрытым списком операций. Гейты контроллера и shell ролей идут только через него.
# Использование: ./tools/agentflow/run.sh <lint|unit|e2e>
set -euo pipefail

op="${1:-}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

# Worktree конвейера лежит внутри основного репозитория: node_modules ищем вверх по дереву.
find_bin() {
  local dir="$ROOT"
  while [ "$dir" != "/" ]; do
    if [ -x "$dir/node_modules/.bin/$1" ]; then echo "$dir/node_modules/.bin/$1"; return 0; fi
    dir="$(dirname "$dir")"
  done
  command -v "$1" || { echo "run.sh: не найден $1 (npm install?)" >&2; return 127; }
}

# node --test без файлов не считается провалом: тестов ещё может не быть.
run_node_tests() {
  local pattern="$1"
  if ! compgen -G "$pattern" > /dev/null; then
    echo "run.sh: нет файлов $pattern — пропуск"
    return 0
  fi
  node --test --test-reporter=spec "$pattern"
}

case "$op" in
  lint)
    exec "$(find_bin eslint)" --max-warnings=0 .
    ;;
  unit)
    run_node_tests "test/*.test.js"
    ;;
  e2e)
    mkdir -p e2e/evidence
    run_node_tests "e2e/*.test.js" 2>&1 | tee e2e/evidence/e2e-run.txt
    exit "${PIPESTATUS[0]}"
    ;;
  *)
    echo "run.sh: неизвестная операция '$op'. Разрешены: lint, unit, e2e" >&2
    exit 2
    ;;
esac
