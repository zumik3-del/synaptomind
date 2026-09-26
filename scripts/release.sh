#!/bin/bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
	echo "Usage: bash scripts/release.sh <version>"
	echo "       bun run release <version>"
	exit 1
fi

VERSION="$1"

# ── Semver-ish validation ────────────────────────────────────────────────────
# Accepts: MAJOR.MINOR.PATCH[-PRERELEASE][+BUILD]
# Rejects bare words, empty strings, obviously wrong shapes.
if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-+][A-Za-z0-9._-]+)?$ ]]; then
	echo "ERROR: '$VERSION' does not look like a semver version."
	echo "       Examples: 0.8.1  1.0.0-beta.0  0.9.0-rc.1"
	exit 1
fi

# ── Clean tree guard ─────────────────────────────────────────────────────────
if [[ -n "$(git status --porcelain)" ]]; then
	echo "ERROR: Working tree has uncommitted changes:"
	git status --short
	exit 1
fi

# ── Bump package.json ────────────────────────────────────────────────────────
sed -i "s/\"version\": *\"[^\"]*\"/\"version\": \"$VERSION\"/" package.json
NEW_VERSION=$(grep -o '"version": *"[^"]*"' package.json | head -1 | sed 's/"version": *"//;s/"//')
if [[ "$NEW_VERSION" != "$VERSION" ]]; then
	echo "ERROR: package.json version did not update to $VERSION"
	exit 1
fi

echo "Bumped package.json to $VERSION."

# ── Regenerate CHANGELOG (pending section only) ─────────────────────────────
bun run scripts/changelog.ts

# ── Next steps ───────────────────────────────────────────────────────────────
echo ""
echo "Next steps:"
echo "  git add package.json CHANGELOG.md"
echo "  git commit -m \"chore: bump version to $VERSION\""
echo "  git push"
echo "  open PR dev → main"
