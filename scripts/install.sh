#!/usr/bin/env bash
# Installs the orchestrate skill, the /quick and /build commands, and the delegate-setup roles patch.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
skills="${HOME}/.agents/skills"; claude_skills="${HOME}/.claude/skills"; cmds="${HOME}/.claude/commands"
mkdir -p "$skills" "$claude_skills" "$cmds"
rm -rf "$skills/orchestrate"; cp -R "$here/skills/orchestrate" "$skills/orchestrate"
ln -sfn "../../.agents/skills/orchestrate" "$claude_skills/orchestrate"
cp "$here/commands/quick.md" "$here/commands/build.md" "$cmds/"
node "$here/scripts/patch-delegate-setup.mjs"
node "$skills/orchestrate/scripts/fleet.mjs" list --cwd "$PWD" >/dev/null && echo "fleet readable"
echo "installed: $skills/orchestrate, /quick, /build"
