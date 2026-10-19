#!/usr/bin/env bash
# Реализация гейтов по умолчанию (gates.ops в policy kit) для JS-проектов: eslint и node --test.
# Работает в текущем каталоге — worktree целевого репозитория. Другой проект задаёт свои
# команды в .agentflow/policy.yaml, и этот файл ему не нужен.
# Использование: bash run.sh <lint|unit|e2e>
set -euo pipefail

op="${1:-}"
KIT="${AGENTFLOW_KIT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"

# Бинарник из node_modules проекта (вверх от cwd), иначе из kit.
find_bin() {
  local dir="$PWD"
  while [ "$dir" != "/" ]; do
    if [ -x "$dir/node_modules/.bin/$1" ]; then echo "$dir/node_modules/.bin/$1"; return 0; fi
    dir="$(dirname "$dir")"
  done
  if [ -x "$KIT/node_modules/.bin/$1" ]; then echo "$KIT/node_modules/.bin/$1"; return 0; fi
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
