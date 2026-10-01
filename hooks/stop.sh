#!/bin/sh
# hooks/stop.sh: the fallback wake line at stop for a harness without a per-turn hook. Writes nothing; never refuses. Exit 0.
cat >/dev/null 2>&1 || true
here=$(cd "$(dirname "$0")/.." && pwd)
link="${HOME:-/nonexistent}/.local/bin/sudus"
if command -v sudus >/dev/null 2>&1; then exe=sudus
elif [ -x "$link" ]; then exe=$link
else exe=; fi
# Issue #53: the executable is one quoted word, and this plugin's copy runs through node with its
# path quoted, so a path holding a space stays whole. An empty exe means this plugin's copy.
run() { if [ -n "$exe" ]; then "$exe" "$@"; else node "$here/bin/sudus.mjs" "$@"; fi; }
# The command found runs when it is this plugin's version or newer: the shim bin/sudus.sh runs
# the newest installed Sudus, which a session started before a plugin update sees as newer than
# this hook's own copy, and that is fine. Only an older command, or one that cannot say its
# version, is stranded (a symlink into a versioned plugin cache after a marketplace update):
# then this plugin's copy runs and one line says how to install the shim. Writes nothing.
want=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$here/package.json" | head -n 1)
have=$(run --version 2>/dev/null | head -n 1)
older() { awk -v a="$1" -v b="$2" 'BEGIN{split(a,x,".");split(b,y,".");for(i=1;i<=3;i++){p=x[i]+0;q=y[i]+0;if(p<q)exit 0;if(p>q)exit 1}exit 1}'; }
lines() {
  if [ -n "$want" ] && older "$have" "$want"; then
    # The shim runs $SUDUS_ROOT, else $CAIRN_ROOT, first when it holds a bin/sudus.mjs. When that pin
    # is the version found, it is the cause, and copying the shim again changes nothing (issue #9).
    pin=SUDUS_ROOT; pinned=${SUDUS_ROOT:-}; [ -n "$pinned" ] || { pin=CAIRN_ROOT; pinned=${CAIRN_ROOT:-}; }
    if [ -n "$pinned" ] && [ -f "$pinned/bin/sudus.mjs" ] && [ "$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$pinned/package.json" 2>/dev/null | head -n 1)" = "$have" ]; then
      printf 'sudus: %s=%s pins Sudus %s, this plugin is %s; using the plugin copy. The sudus command runs %s first: unset it so it runs the newest installed Sudus, or point it at %s.\n' "$pin" "$pinned" "$have" "$want" "$pin" "$here"
    else
      printf 'sudus: the sudus command found runs %s, this plugin is %s; using the plugin copy. Install the shim so this never recurs: cp %s/bin/sudus.sh ~/.local/bin/sudus && chmod +x ~/.local/bin/sudus\n' "${have:-an older version}" "$want" "$here"
    fi
    exe=
  fi
  out=$(run wake 2>&1); code=$?
  printf '%s\n' "$out"
  [ "$code" -eq 0 ] || [ "$code" -eq 3 ] || printf 'sudus: wake exited %s\n' "$code"
}
# Issue #61: Codex reads a Stop hook's stdout as JSON and fails the hook on plain text. Codex sets
# PLUGIN_ROOT for a plugin's hooks, which Claude Code does not (it sets CLAUDE_PLUGIN_ROOT), and a
# Stop hook registered by hand in Codex passes `codex`. Under Codex the same lines go out as one
# {"systemMessage": ...} object: Codex shows it to the person, and it never blocks the stop.
# Every byte below 32, the backslash and the double quote are escaped; other bytes pass through.
json() {
  LC_ALL=C awk '
    BEGIN { for (i = 1; i < 32; i++) esc[sprintf("%c", i)] = sprintf("\\u%04x", i)
            esc["\\"] = "\\\\"; esc["\""] = "\\\"" }
    { s = ""; for (i = 1; i <= length($0); i++) { c = substr($0, i, 1); s = s ((c in esc) ? esc[c] : c) }
      text = (NR > 1 ? text "\\n" : "") s }
    END { if (text != "") printf "{\"systemMessage\":\"%s\"}\n", text }'
}
if [ "${1:-}" = codex ] || [ -n "${PLUGIN_ROOT:-}" ]; then lines | json; else lines; fi
exit 0
