#!/bin/bash
# UserPromptSubmit hook — injects fresh CLAUDE.md content into context ONLY
# when the file has changed since last injection. Cheap when nothing changed,
# automatic when web edits land.
#
# Hook output format: anything printed to stdout is appended to the user's
# prompt as additional context for that turn.

CWD="${CLAUDE_PROJECT_DIR:-$PWD}"
CLAUDE_MD="$CWD/CLAUDE.md"
STATE_FILE="$CWD/.claude/.delma-last-injected-mtime"

# No CLAUDE.md → nothing to inject
[ ! -f "$CLAUDE_MD" ] && exit 0

# Get current mtime of CLAUDE.md
CURRENT_MTIME=$(stat -f "%m" "$CLAUDE_MD" 2>/dev/null || stat -c "%Y" "$CLAUDE_MD" 2>/dev/null)
[ -z "$CURRENT_MTIME" ] && exit 0

# Read last injected mtime
LAST_MTIME=""
[ -f "$STATE_FILE" ] && LAST_MTIME=$(cat "$STATE_FILE")

# If unchanged, inject nothing (cheap path — most messages)
if [ "$CURRENT_MTIME" = "$LAST_MTIME" ]; then
  exit 0
fi

# Changed — inject fresh content + a one-line note about the freshness
mkdir -p "$(dirname "$STATE_FILE")"
echo "$CURRENT_MTIME" > "$STATE_FILE"

# Compute seconds since the file changed
NOW=$(date +%s)
AGE=$((NOW - CURRENT_MTIME))

cat <<EOF
<delma-fresh-context>
Delma workspace state was updated ${AGE}s ago (web app edit, MCP write, or
auto-sync). Latest summary follows. If you suspect drift mid-conversation,
call \`get_workspace_state\` for fresh data.

$(cat "$CLAUDE_MD")
</delma-fresh-context>
EOF
