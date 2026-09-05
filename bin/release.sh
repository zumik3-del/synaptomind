#!/bin/bash
set -euo pipefail

HOMEDIR="$(dirname "$(cd -- "$(dirname "$0")" && (pwd -P 2>/dev/null || pwd))")"
cd "$HOMEDIR"

if [[ -n "$(git status --porcelain)" ]]; then
	echo "ERROR: Working tree has uncommitted changes:"
	git status --short
	exit 1
fi

PACKAGE_VERSION=$(node -p "require('./package.json').version")
TAG="v$PACKAGE_VERSION"
LONGVER="Version $PACKAGE_VERSION"

echo "$LONGVER"
git tag -a "$TAG" -m "$LONGVER"
git push --tags

node bin/changelog.cjs
