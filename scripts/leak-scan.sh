#!/usr/bin/env bash
# leak-scan.sh: keeps secrets and private addresses out of this repository.
# Run by the git hooks (scripts/install-hooks.sh) and in CI.
#
#   scripts/leak-scan.sh --staged            # what is staged (pre-commit)
#   scripts/leak-scan.sh --range <A>..<B>    # a range of commits (pre-push, CI)
#   scripts/leak-scan.sh --text <file|->     # text about to be posted somewhere
#   scripts/leak-scan.sh --tree <dir>        # a whole checkout
#   scripts/leak-scan.sh --selftest          # the gate still catches what it should
#
# Two tiers:
#
#   Generic (here): shapes of secrets and private addresses. Names nobody,
#   so it is public and runs for every pull request.
#
#   Your own identifiers (never here): host names, e-mail addresses,
#   subnets you do not want in the history. They come at run time as
#   extended regexes, one per line, from $LEAK_PATTERNS, $LEAK_PATTERNS_FILE,
#   `git config leakscan.patternsFile`, or the default file below. A line
#   starting `cs:` is matched case-sensitively. Without a list the generic
#   tier runs alone, with a warning; with a list declared but missing, the
#   gate fails.
#
# Fails closed: 0 is clean, and both a hit and an error in the scan block.
set -uo pipefail

SECRET_RE='sk-[A-Za-z0-9_-]{16,}|sk-ant-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{22,}|gho_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|eyJ[A-Za-z0-9_-]{20,}[.][A-Za-z0-9_-]{20,}[.][A-Za-z0-9_-]{10,}'

# Commit trailers that carry a forge's private address.
TRAILER_RE='^(Reviewed-on|Reviewed-by|Co-authored-by):.*(10[.]|172[.](1[6-9]|2[0-9]|3[01])[.]|192[.]168[.]|100[.](6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])[.])'

# Private addresses are refused unless they are one of these: loopback,
# Docker's default bridge, and whole networks written as examples.
ALLOWED_ADDR_RE='^(127[.]0[.]0[.]1|0[.]0[.]0[.]0|172[.]17[.]0[.][0-9]+|172[.]16[.]0[.]0|10[.]0[.]0[.][01]|192[.]168[.]0[.]0|100[.]64[.]0[.]0)$'
PRIVATE_ADDR_RE='(10[.][0-9]+[.][0-9]+[.][0-9]+|172[.](1[6-9]|2[0-9]|3[01])[.][0-9]+[.][0-9]+|192[.]168[.][0-9]+[.][0-9]+|100[.](6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])[.][0-9]+[.][0-9]+)'

# Secret-shaped test values that are known to be made up, listed exactly
# (never by path, so a real key pasted into a test still blocks). Empty: a
# test value carries the marker `leak-scan-allow` on its line instead.
ALLOWED_SECRET_RE='^$'

PATTERNS_DEFAULT="$HOME/.config/nuthatch/leak-patterns.txt"
patterns_file() {
  if [ -n "${LEAK_PATTERNS_FILE:-}" ]; then printf '%s' "$LEAK_PATTERNS_FILE"; return; fi
  local cfg; cfg=$(git config --get leakscan.patternsFile 2>/dev/null || true)
  [ -n "$cfg" ] && { printf '%s' "$cfg"; return; }
  printf '%s' "$PATTERNS_DEFAULT"
}
tier_declared() {
  [ "${LEAK_REQUIRE_OPERATOR_TIER:-0}" = 1 ] && return 0
  [ -n "${LEAK_PATTERNS_FILE:-}" ] && return 0
  [ -n "$(git config --get leakscan.patternsFile 2>/dev/null || true)" ] && return 0
  return 1
}
operator_lines() {
  local f; f=$(patterns_file)
  { [ -f "$f" ] && cat "$f"
    [ -n "${LEAK_PATTERNS:-}" ] && printf '%s\n' "$LEAK_PATTERNS"; } 2>/dev/null \
    | grep -vE '^[[:space:]]*(#|$)'
}
operator_regex_ci() { operator_lines | grep -v '^cs:' | paste -sd'|' - || true; }
operator_regex_cs() { operator_lines | grep '^cs:' | sed 's/^cs://' | paste -sd'|' - || true; }

OPERATOR_TIER=off
fail=0
say() { printf '  %s\n' "$*"; }

require_or_warn_operator_tier() {
  if [ -n "$(operator_lines)" ]; then OPERATOR_TIER=on; return 0; fi
  if tier_declared; then
    say "❌ a list of identifiers is declared but none loaded: failing closed."
    say "   looked for: $(patterns_file)"
    fail=1; return 1
  fi
  printf '\033[1;33m[leak-scan] WARNING: no identifier list loaded; the generic tier runs alone.\033[0m\n' >&2
}

# In CI the log may be public: a hit says how many lines and which pattern
# (by its line number in the list), never what it matched. LEAK_SCAN_SHOW=1
# shows the lines anyway.
withhold() { [ "${LEAK_SCAN_SHOW:-0}" != 1 ] && [ -n "${GITHUB_ACTIONS:-}${CI:-}" ]; }

which_patterns() {  # <text> <i|I>
  local text="$1" ci="$2" n=0 hit="" line re
  while IFS= read -r line; do
    n=$((n+1))
    case "$ci:$line" in i:cs:*) continue ;; I:cs:*) ;; I:*) continue ;; esac
    re="${line#cs:}"
    if [ "$ci" = i ]; then printf '%s\n' "$text" | grep -qiE -- "$re" && hit="$hit #$n"
    else printf '%s\n' "$text" | grep -qE -- "$re" && hit="$hit #$n"; fi
  done < <(operator_lines)
  printf '%s' "${hit# }"
}

# match <regex> <text> <i|I> <label>: a hit and a grep error both set fail.
match() {
  local re="$1" text="$2" ci="$3" label="$4" out rc
  [ -n "$re" ] || return 0
  if [ "$ci" = i ]; then out=$(printf '%s\n' "$text" | grep -inE -- "$re"); rc=$?
  else out=$(printf '%s\n' "$text" | grep -nE -- "$re"); rc=$?; fi
  if [ "$rc" -eq 0 ]; then
    say "❌ $label:"
    if withhold; then
      local n; n=$(printf '%s\n' "$out" | wc -l | tr -d ' ')
      case "$label" in
        identifiers*) say "   $n line(s) matched pattern(s) $(which_patterns "$text" "$ci") (run it locally to see them)" ;;
        *)            say "   $n line(s) matched (run it locally to see them)" ;;
      esac
    else
      printf '     %s\n' "$out" | head -20
    fi
    fail=1
  elif [ "$rc" -ge 2 ]; then say "❌ the scan failed on '$label' (grep $rc): failing closed"; fail=1; fi
}

added_lines() { awk '{ if (substr($0,1,3)=="+++") next; if (substr($0,1,1)=="+") print substr($0,2) }'; }
# A line with the marker `leak-scan-allow` is a deliberate example.
drop_allowed() { grep -vF -- 'leak-scan-allow' || true; }

# new: what a commit adds, against everything. tree: a whole checkout,
# against secret shapes and addresses; identifiers are not looked for there.
scan_content() {  # <text> <label> <new|tree>
  local text; text=$(printf '%s\n' "$1" | drop_allowed) label="$2" mode="${3:-new}"
  if [ "$mode" = new ]; then
    match "$SECRET_RE" "$text" I "secret-shaped strings in $label"
    match "$(operator_regex_ci)" "$text" i "identifiers in $label"
    match "$(operator_regex_cs)" "$text" I "identifiers (case-sensitive) in $label"
  else
    local tok badtok=""
    while IFS= read -r tok; do
      [ -z "$tok" ] && continue
      printf '%s' "$tok" | grep -qE -- "$ALLOWED_SECRET_RE" || badtok="$badtok$tok"$'\n'
    done < <(printf '%s\n' "$text" | grep -oiE -- "$SECRET_RE" 2>/dev/null | sort -u)
    if [ -n "$badtok" ]; then
      say "❌ secret-shaped strings ($label):"
      if withhold; then say "   $(printf '%s' "$badtok" | grep -c .) withheld"; else printf '     %s\n' $badtok; fi
      fail=1
    fi
  fi
  local addr bad=""
  while IFS= read -r addr; do
    [ -z "$addr" ] && continue
    printf '%s' "$addr" | grep -qE -- "$ALLOWED_ADDR_RE" || bad="$bad$addr"$'\n'
  done < <(printf '%s\n' "$text" | grep -oE -- "$PRIVATE_ADDR_RE" 2>/dev/null | sort -u)
  if [ -n "$bad" ]; then
    say "❌ private addresses ($label): use one from RFC 5737 (192.0.2.0/24) instead:"
    if withhold; then say "   $(printf '%s' "$bad" | grep -c .) withheld"; else printf '     %s\n' $bad; fi
    fail=1
  fi
}

mode_staged() { scan_content "$(git diff --cached --no-color | added_lines)" "staged changes" new; }

mode_range() {
  local range="$1"
  # A range git cannot read would scan as empty, and so as clean.
  git rev-list --max-count=0 "$range" -- >/dev/null 2>&1 || {
    echo "leak-scan: cannot resolve range '$range'" >&2
    exit 2
  }
  scan_content "$(git diff --no-color "$range" | added_lines)" "range $range" new
  local msgs; msgs=$(git log --format='%H %B' "$range" 2>/dev/null | drop_allowed)
  match "$TRAILER_RE" "$msgs" i "trailers with a private address"
  match "$(operator_regex_ci)" "$msgs" i "identifiers in commit messages"
  match "$(operator_regex_cs)" "$msgs" I "identifiers (case-sensitive) in commit messages"
}

mode_tree() {
  local dir="$1"; [ -d "$dir" ] || { echo "not a directory: $dir" >&2; exit 2; }
  local text
  # In a git checkout, what git tracks: not what is ignored, such as keys a
  # dev run made.
  if git -C "$dir" rev-parse --git-dir >/dev/null 2>&1; then
    text=$(cd "$dir" && git ls-files -z | xargs -0 grep -hI "" -- 2>/dev/null)
  else
    text=$(grep -rhI "" --exclude-dir=.git --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=target "$dir" 2>/dev/null)
  fi
  scan_content "$text" "tree $dir" tree
}

mode_text() {
  local src="${1:--}" text
  if [ "$src" = - ]; then text=$(cat); else
    [ -f "$src" ] || { echo "leak-scan: no such file: $src" >&2; exit 2; }
    text=$(cat -- "$src")
  fi
  scan_content "$text" "text" new
}

finish() {
  local tiers="generic"
  [ "$OPERATOR_TIER" = on ] && tiers="generic + identifiers"
  if [ "$fail" -ne 0 ]; then say "leak gate BLOCKED: fix the above before committing or pushing."; exit 1; fi
  say "✅ leak gate clean ($tiers)"
}

selftest() {
  local tmp pass=0 tf=0
  tmp=$(mktemp -d); trap 'rm -rf "$tmp"' RETURN
  # Made-up identifiers: the real ones never go in this file.
  export LEAK_PATTERNS=$'acme-tailnet\nacme-forge[.]internal\noperator@example[.]test'
  ok() { echo "  ok   $1"; pass=$((pass+1)); }
  no() { echo "  FAIL $1"; tf=$((tf+1)); }
  run_tree() { ( fail=0; mode_tree "$1" >/dev/null 2>&1; [ "$fail" -eq 0 ] ); }
  check() { rm -rf "$tmp/t"; mkdir -p "$tmp/t"
    printf 'clean\nhttp://127.0.0.1:11434\n172.17.0.1\n' > "$tmp/t/ok.txt"
    "$3" "$tmp/t"; run_tree "$tmp/t"; local rc=$?
    if [ "$rc" -eq "$2" ]; then ok "$1"; else no "$1 (rc=$rc want $2)"; fi
  }
  s_clean(){ :; }
  s_lan(){ echo 'http://192.168.5.90:11434'>"$1/c.ts"; }  # leak-scan-allow
  s_op(){ echo 'host acme-forge.acme-tailnet.internal'>"$1/d.md"; }
  s_secret(){ echo "k='ghp_0123456789abcdef0123456789abcdefABCD'">"$1/s.ts"; }  # leak-scan-allow
  echo "leak-scan self-test"
  check "a clean tree passes"                      0 s_clean
  check "a private LAN address blocks"             1 s_lan
  check "identifiers are not looked for in a tree" 0 s_op
  check "a secret in a tree blocks"                1 s_secret

  local gt="$tmp/g"; mkdir -p "$gt"
  ( cd "$gt"; git init -q; git config user.email a@b.c; git config user.name t; echo clean > f.txt; git add f.txt; git commit -qm init )
  staged_blocks() {
    ( cd "$gt"; rm -f probe.ts; printf '%s\n' "$2" > probe.ts; git add probe.ts 2>/dev/null
      fail=0; mode_staged >/dev/null 2>&1; git reset -q probe.ts 2>/dev/null; rm -f probe.ts; [ "$fail" -ne 0 ] ) && ok "$1" || no "$1"
  }
  staged_blocks "sk-ant secret (staged) blocks"  'k="sk-ant-abcdef0123456789ABCDEF"'  # leak-scan-allow
  staged_blocks "ghp_ token (staged) blocks"     'ghp_0123456789abcdef0123456789abcdefABCD'  # leak-scan-allow
  staged_blocks "PEM (staged) blocks"            '-----BEGIN OPENSSH PRIVATE KEY-----'  # leak-scan-allow
  staged_blocks "AWS key (staged) blocks"        'AKIA1234567890ABCDEF'  # leak-scan-allow
  staged_blocks "identifier (staged) blocks"     'host acme-tailnet.example.net'
  ( cd "$gt" && printf 'ghp_0123456789abcdef0123456789abcdefABCD\n' > r.ts && git add r.ts && git commit -qm leak --no-verify  # leak-scan-allow
    fail=0; mode_range HEAD~1..HEAD >/dev/null 2>&1; [ "$fail" -ne 0 ] ) && ok "a secret in a range blocks" || no "a secret in a range blocks"

  tier_case() {
    local name="$1" want="$2"; shift 2
    ( cd "$gt"; unset LEAK_PATTERNS LEAK_PATTERNS_FILE LEAK_REQUIRE_OPERATOR_TIER
      "$@"; fail=0; OPERATOR_TIER=off
      require_or_warn_operator_tier >/dev/null 2>&1
      [ "$fail" -eq "$want" ] ) && ok "$name" || no "$name"
  }
  d_none() { :; }
  d_env_missing()  { export LEAK_PATTERNS_FILE="$tmp/nope.txt"; }
  d_flag_missing() { export LEAK_REQUIRE_OPERATOR_TIER=1; }
  d_env_present()  { printf 'acme-tailnet\n' > "$tmp/p.txt"; export LEAK_PATTERNS_FILE="$tmp/p.txt"; }
  tier_case "no list and none declared warns"    0 d_none
  tier_case "a declared list missing fails"      1 d_env_missing
  tier_case "a list required and none fails"     1 d_flag_missing
  tier_case "a declared list present passes"     0 d_env_present

  printf 'acme-tailnet\ncs:AcmeOrg/secret-path\n' > "$tmp/w.txt"
  printf 'visit acme-tailnet\nsee AcmeOrg/secret-path\n' > "$tmp/w.in"
  out=$(CI=1 LEAK_PATTERNS_FILE="$tmp/w.txt" bash "$0" --text "$tmp/w.in" 2>&1 || true)
  if printf '%s' "$out" | grep -q 'pattern(s) #1 ' && printf '%s' "$out" | grep -q 'pattern(s) #2 ' \
     && ! printf '%s' "$out" | grep -qE 'acme-tailnet|AcmeOrg'; then
    ok "CI says which pattern, never what it matched"
  else no "CI says which pattern, never what it matched"; printf '%s\n' "$out"; fi

  echo "  $pass passed, $tf failed"
  [ "$tf" -eq 0 ]
}

case "${1:-}" in
  --staged)   require_or_warn_operator_tier; mode_staged; finish ;;
  --range)    require_or_warn_operator_tier; mode_range "${2:?range required}"; finish ;;
  --text)     require_or_warn_operator_tier; mode_text "${2:--}"; finish ;;
  --tree)     mode_tree "${2:?dir required}"; finish ;;
  --selftest) selftest ;;
  *) echo "usage: leak-scan.sh --staged | --range <A..B> | --text <file|-> | --tree <dir> | --selftest" >&2; exit 2 ;;
esac
