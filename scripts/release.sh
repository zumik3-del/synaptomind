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

# ── Bump server.json (MCP Registry record) ──────────────────────────────────
# The registry record pins both the version and the OCI image tag, so it has to
# move with package.json or the published entry keeps pointing at a stale image.
if [[ -f server.json ]]; then
	# Preserve a variant suffix the record already carries (`-stdio`), so the
	# published entry keeps pointing at the image shape it chose.
	TAG_SUFFIX=""
	if grep -qE '"identifier": "[^"]*-stdio"' server.json; then
		TAG_SUFFIX="-stdio"
	fi
	sed -i -E "s/^  \"version\": \"[^\"]*\"/  \"version\": \"$VERSION\"/" server.json
	sed -i -E "s#^([[:space:]]*\"identifier\": \"[^\"]*):[^\"]*\"#\\1:$VERSION$TAG_SUFFIX\"#" server.json
	SRV_VERSION=$(grep -o '"version": *"[^"]*"' server.json | head -1 | sed 's/"version": *"//;s/"//')
	if [[ "$SRV_VERSION" != "$VERSION" ]]; then
		echo "ERROR: server.json version did not update to $VERSION"
		exit 1
	fi
	if ! grep -q ":$VERSION$TAG_SUFFIX\"" server.json; then
		if grep -q '"identifier"' server.json; then
			echo "ERROR: server.json image tag did not update to $VERSION$TAG_SUFFIX"
			exit 1
		fi
	fi
	echo "Bumped server.json to $VERSION$TAG_SUFFIX."
fi

# ── Bump the stdio variant's pinned base image ──────────────────────────────
# deploy/mcp/Dockerfile pins BASE to a release so a plain `docker build deploy/mcp`
# is reproducible; CI passes the image it just built instead.
# No digest rides across the bump: with both a tag and a digest the digest wins, and the new digest does not exist until CI builds the image.
STDIO_DOCKERFILE="deploy/mcp/Dockerfile"
if [[ -f "$STDIO_DOCKERFILE" ]]; then
	sed -i -E "s#^(ARG BASE=ghcr\.io/zumik3-del/synaptomind:)[^[:space:]]*#\\1$VERSION#" "$STDIO_DOCKERFILE"
	STDIO_BASE_PIN="ARG BASE=ghcr.io/zumik3-del/synaptomind:$VERSION"
	STDIO_BASE_LINES="$(grep '^ARG BASE=' "$STDIO_DOCKERFILE" || true)"
	if [[ "$STDIO_BASE_LINES" != "$STDIO_BASE_PIN" ]]; then
		echo "ERROR: $STDIO_DOCKERFILE must carry exactly one line '$STDIO_BASE_PIN'."
		echo "       Found: ${STDIO_BASE_LINES:-<no ARG BASE line>}"
		echo "       A leftover digest, or any character after the tag, is refused rather than carried."
		exit 1
	fi
	echo "Bumped $STDIO_DOCKERFILE base tag to $VERSION."
fi

# ── Regenerate CHANGELOG (pending section only) ─────────────────────────────
bun run scripts/changelog.ts

# ── Next steps ───────────────────────────────────────────────────────────────
echo ""
echo "Next steps:"
echo "  git add package.json CHANGELOG.md server.json deploy/mcp/Dockerfile"
echo "  git commit -m \"chore: bump version to $VERSION\""
echo "  git push"
echo "  open PR dev → main"
