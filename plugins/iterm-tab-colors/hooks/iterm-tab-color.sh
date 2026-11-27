#!/bin/bash
# Gives each Claude Code session its own iTerm2 progress-ring colour by switching
# the tab to a free "Claude <Colour>" dynamic profile. The profiles ship next to this
# script and are copied to iTerm2's DynamicProfiles folder on first run.
# Usage: SessionStart hook (hook JSON on stdin), or `iterm-tab-color.sh ttysNNN [transcript.jsonl]`
# for an existing tab. Switching the profile resets the tab title, so the session title
# (custom-title, else ai-title from the transcript) is re-sent afterwards.
# Prints nothing to stdout: SessionStart stdout would land in Claude's context.

PALETTE=(Blue Orange Purple Cyan Yellow Red Green Rainbow)
STATE_DIR="$HOME/.claude/state/iterm-tab-colors"
PROFILES_SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/profiles/claude-progress-colors.json"
PROFILES_DST="$HOME/Library/Application Support/iTerm2/DynamicProfiles/claude-progress-colors.json"

# Install the profiles once; an existing file is left alone so local edits survive.
install_profiles() {
    [[ -f "$PROFILES_DST" || ! -f "$PROFILES_SRC" ]] && return
    mkdir -p "$(dirname "$PROFILES_DST")" && cp "$PROFILES_SRC" "$PROFILES_DST" || return
    sleep 1  # give iTerm2 a moment to load them before SetProfile
}

find_tty() {
    local pid=$PPID t
    for _ in 1 2 3 4 5 6 7 8; do
        t=$(ps -o tty= -p "$pid" 2>/dev/null | tr -d ' ')
        if [[ -n "$t" && "$t" != "??" ]]; then echo "$t"; return; fi
        pid=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')
        [[ -z "$pid" || "$pid" -le 1 ]] && return
    done
}

session_title() {
    [[ -f "$1" ]] || return
    /usr/bin/python3 -I - "$1" <<'PY' 2>/dev/null
import json, sys
ai = custom = None
for line in open(sys.argv[1], encoding="utf-8"):
    if '"ai-title"' not in line and '"custom-title"' not in line:
        continue
    try:
        d = json.loads(line)
    except ValueError:
        continue
    if d.get("type") == "custom-title":
        custom = d.get("customTitle") or custom
    elif d.get("type") == "ai-title":
        ai = d.get("aiTitle") or ai
title = (custom or ai or "").replace("\x07", "").replace("\x1b", "").strip()
print(title)
PY
}

if [[ -n "$1" ]]; then
    tty="$1"
    transcript="$2"
else
    transcript=$(/usr/bin/python3 -I -c 'import json,sys; print(json.load(sys.stdin).get("transcript_path",""))' 2>/dev/null)
    [[ "$TERM_PROGRAM" == "iTerm.app" ]] || exit 0
    # Leave tabs with a custom profile (hotkey window, ssh hosts, ...) alone.
    case "${ITERM_PROFILE:-Default}" in Default|Claude\ *) ;; *) exit 0 ;; esac
    tty=$(find_tty)
fi
[[ -n "$tty" && -w "/dev/$tty" ]] || exit 0

install_profiles
mkdir -p "$STATE_DIR"
lock="$STATE_DIR/.lock"
for _ in $(seq 50); do mkdir "$lock" 2>/dev/null && break; sleep 0.05; done
trap 'rmdir "$lock" 2>/dev/null' EXIT

# Colours held by other tabs that still run Claude; drop stale entries.
used=" "
for f in "$STATE_DIR"/ttys*; do
    [[ -e "$f" ]] || continue
    t=${f##*/}
    [[ "$t" == "$tty" ]] && continue
    if ps -t "$t" -o comm= 2>/dev/null | grep -q 'claude'; then
        used+="$(cat "$f") "
    else
        rm -f "$f"
    fi
done

color=$(cat "$STATE_DIR/$tty" 2>/dev/null)
if [[ -z "$color" || "$used" == *" $color "* ]]; then
    color=""
    for c in "${PALETTE[@]}"; do
        [[ "$used" == *" $c "* ]] || { color=$c; break; }
    done
    [[ -n "$color" ]] || color=${PALETTE[$(( 10#${tty//[!0-9]/} % ${#PALETTE[@]} ))]}
fi
echo "$color" > "$STATE_DIR/$tty"

printf '\033]1337;SetProfile=Claude %s\a' "$color" > "/dev/$tty"
title=$(session_title "$transcript")
[[ -n "$title" ]] && printf '\033]0;%s\a' "$title" > "/dev/$tty"
exit 0
