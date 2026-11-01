#!/usr/bin/env bash
# Data truth: adds this job's files to the data-truth branch without touching the other job's files (both jobs publish there).
# PUBLISH_BRANCH names another data branch the same way (recall-explain: Recall explanations).
# usage: data-truth-publish.sh <job> <file>...   (files hold totals, case ids and plate-free values only)
set -euo pipefail
job="$1"; shift
branch="${PUBLISH_BRANCH:-data-truth}"
repo="https://x-access-token:${GITHUB_TOKEN}@github.com/${GITHUB_REPOSITORY}.git"
dir="$(mktemp -d)"
for f in "$@"; do cp "$f" "$dir/"; done
cd "$(mktemp -d)" && git init -q && git remote add origin "$repo"
for try in 1 2 3; do
  if git fetch -q --depth 1 origin "$branch" 2>/dev/null; then git checkout -q -B "$branch" FETCH_HEAD; else git checkout -q --orphan "$branch"; fi
  cp "$dir"/* .
  git add -A
  git -c user.name=github-actions -c user.email=github-actions@users.noreply.github.com commit -qm "$job $(date -u +%F)" || { echo "nothing new"; exit 0; }
  if git push -q origin "$branch"; then echo "published: $*"; exit 0; fi
  sleep $((try * 5))   # the other job published in between: start again from its commit
done
echo "could not publish to $branch"; exit 1
