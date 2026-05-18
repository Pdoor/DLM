#!/usr/bin/env sh
set -eu

MESSAGE="${1:-Deploy Destiny Lore Masters web app}"
REPO_URL="https://github.com/Pdoor/DLM.git"
BRANCH="main"

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$SCRIPT_DIR"

if ! command -v git >/dev/null 2>&1; then
  echo "Git non trovato. Installa Git oppure usa un terminale dove git e disponibile." >&2
  exit 1
fi

if [ ! -d ".git" ]; then
  git init
fi

CURRENT_BRANCH=$(git branch --show-current 2>/dev/null || true)
if [ -z "$CURRENT_BRANCH" ]; then
  git checkout -b "$BRANCH"
elif [ "$CURRENT_BRANCH" != "$BRANCH" ]; then
  git branch -M "$BRANCH"
fi

if git remote get-url origin >/dev/null 2>&1; then
  CURRENT_REMOTE=$(git remote get-url origin)
  if [ "$CURRENT_REMOTE" != "$REPO_URL" ]; then
    git remote set-url origin "$REPO_URL"
  fi
else
  git remote add origin "$REPO_URL"
fi

git add index.html manifest.webmanifest sw.js DLM.jpg dlm.ico README.md .github/workflows/pages.yml scripts/fetch-data.js data/clan-status.json worker deploy.ps1 deploy.sh

if [ -z "$(git status --porcelain)" ]; then
  echo "Nessuna modifica da committare."
else
  git commit -m "$MESSAGE"
fi

git push -u origin "$BRANCH"

echo
echo "Deploy inviato su $REPO_URL"
echo "GitHub Pages: Settings > Pages > Build and deployment > GitHub Actions"
