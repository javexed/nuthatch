#!/usr/bin/env bash
# Points this clone at the hooks kept in .githooks (the leak gate before a
# commit and before a push). Once for each clone: git does not clone hooks.
#
#   scripts/install-hooks.sh
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
git config core.hooksPath .githooks
echo "core.hooksPath -> .githooks (pre-commit and pre-push are on)"

# A clone that has a private list of names says so here. From then on a list
# that cannot be read stops the gate, where it would otherwise fall back to
# the general checks without a word. Someone without a list declares none.
if [ -n "${LEAK_PATTERNS_FILE:-}" ] && [ -f "${LEAK_PATTERNS_FILE}" ]; then
  git config leakscan.patternsFile "$LEAK_PATTERNS_FILE"
  echo "leakscan.patternsFile -> $LEAK_PATTERNS_FILE"
elif [ -n "$(git config --get leakscan.patternsFile || true)" ]; then
  echo "leakscan.patternsFile -> $(git config --get leakscan.patternsFile) (as it was)"
else
  echo "No private list is declared: the gate checks for secrets and private"
  echo "addresses only, which is right for anyone but the maintainer. With a list:"
  echo "    git config leakscan.patternsFile /path/to/leak-patterns.txt"
fi

echo "the gate's own test:"; bash scripts/leak-scan.sh --selftest
