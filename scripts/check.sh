#!/bin/sh
set -eu

script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH='' cd -- "$script_dir/.." && pwd)
python=${PYTHON:-python3}
blocked_one='co''dex'
blocked_two='clau''de'
blocked_path='/''Users/'
blocked_token_one='gh''o_'
blocked_token_two='sk-''[A-Za-z0-9]'
blocked_pattern="$blocked_one|$blocked_two|$blocked_path|$blocked_token_one|$blocked_token_two"

cd "$repo_root"
npm run check
npm run lint
npm test
npm audit --omit=dev
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH="$repo_root/src/iterm_pane" \
  "$python" -m unittest discover -s tests/python -p 'test_*.py'
"$python" -m ruff check src tests/python
"$python" -m ruff format --check src tests/python
shellcheck scripts/*.sh

if grep -RniE \
  --exclude-dir=.git --exclude-dir=node_modules --exclude-dir=.ruff_cache \
  --exclude=package-lock.json "$blocked_pattern" .; then
  printf 'check: blocked attribution, path, or credential pattern found\n' >&2
  exit 1
fi
