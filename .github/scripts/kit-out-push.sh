#!/usr/bin/env bash
# Adds one folder to branch kit-draft-out (Kit draft, Kit visual QA) and keeps the rest: usage kit-out-push.sh <src-dir> <dest-folder> <message> <token>
set -euo pipefail
SRC=$1; DEST=$2; MSG=$3; TOKEN=$4; URL="https://x-access-token:${TOKEN}@github.com/${GITHUB_REPOSITORY}.git"
W=$(mktemp -d); git -C "$W" init -q -b kit-draft-out
if git -C "$W" fetch -q --depth=1 "$URL" kit-draft-out 2>/dev/null; then git -C "$W" checkout -q FETCH_HEAD -B kit-draft-out; fi
rm -rf "$W/$DEST"; mkdir -p "$W/$DEST"; cp -r "$SRC"/. "$W/$DEST/"; rm -f "$W/$DEST/ideas.json"
git -C "$W" add -A
git -C "$W" -c user.name="kit-bots" -c user.email="kit-bots@users.noreply.github.com" commit -q -m "$MSG" || { echo "nothing new"; exit 0; }
for i in 1 2 3 4; do git -C "$W" push -q "$URL" kit-draft-out && exit 0; sleep $((2 ** i)); done
exit 1
