#!/usr/bin/env bash
# Regression tests for scripts/release.sh and scripts/changelog.ts
# plus a local simulation of the release.yml detect step.
#
# Run: bash scripts/tests/release-scripts.test.sh
#
# Safety invariants (task #1577):
#   1. EVERY invocation of scripts/release.sh runs with its CWD inside a
#      throwaway scratch clone. release.sh resolves both its dirty-tree guard
#      (`git status --porcelain`) and its `sed -i` bump against the CWD — never
#      against its own directory — so a call issued from the repo under test
#      rewrites the REAL package.json (and only then fails on the changelog
#      guard, which made the old version of this harness "pass" while mutating
#      the checkout). $SCRIPT_DIR is therefore read/copy only.
#   2. $SCRIPT_DIR (the repo under test) is only ever READ: it is cloned and its
#      scripts are copied. Section 8 fingerprints its package.json and
#      CHANGELOG.md before the first test and asserts they are byte-identical at
#      the end, failing loudly (non-zero exit) otherwise.
#   3. The versions under test are DERIVED from the tags of the repo under test
#      (never hardcoded): scripts/changelog.ts refuses to run when package.json
#      is behind the newest tag, so a hardcoded version silently rots as soon as
#      a newer tag is cut.
#   4. The harness never pushes and never touches real refs — `origin` is removed
#      from every scratch clone.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"

PASS=0; FAIL=0
pass() { echo "  PASS: $*"; ((PASS++)) || true; }
fail() { echo "  FAIL: $*"; ((FAIL++)) || true; }

# ── Safety net: fingerprint the repo under test before anything runs ──────────

md5_of() { md5sum "$1" | awk '{print $1}'; }

REAL_PKG="$SCRIPT_DIR/package.json"
REAL_CHANGELOG="$SCRIPT_DIR/CHANGELOG.md"
REAL_PKG_MD5_BEFORE="$(md5_of "$REAL_PKG")"
REAL_CHANGELOG_MD5_BEFORE="$(md5_of "$REAL_CHANGELOG")"

# ── Helpers ────────────────────────────────────────────────────────────────────

# Create an isolated scratch clone with tags, no remote, clean working tree.
# Then copy the working-tree versions of release.sh and changelog.ts so we
# test the current (possibly uncommitted) implementation.
setup_scratch() {
  local scratch
  scratch="$(mktemp -d)"
  if ! git clone --no-local "$SCRIPT_DIR" "$scratch" >/dev/null 2>&1; then
    echo "ERROR: setup_scratch: 'git clone --no-local $SCRIPT_DIR' failed" >&2
    exit 1
  fi
  # A clone copies neither the source repo's LOCAL identity nor, on a host without
  # one, any global identity — and a missing identity makes `git commit` fail with
  # exit 128 ("Author identity unknown"). Give the scratch its own identity so the
  # harness runs in a fresh shell without GIT_AUTHOR_*/GIT_COMMITTER_* env vars.
  git -C "$scratch" config user.name "Release Script Test"
  git -C "$scratch" config user.email "release-script-test@example.invalid"
  # Drop the origin remote so no accidental pushes are possible.
  git -C "$scratch" remote remove origin 2>/dev/null || true
  # Ensure clean working tree at HEAD.
  git -C "$scratch" checkout "$(git -C "$scratch" rev-parse HEAD)" -- . 2>/dev/null || true
  git -C "$scratch" clean -fd 2>/dev/null || true
  # Install the working-tree versions of the scripts under test.
  cp "$SCRIPT_DIR/scripts/release.sh" "$scratch/scripts/release.sh"
  cp "$SCRIPT_DIR/scripts/changelog.ts"  "$scratch/scripts/changelog.ts"
  chmod +x "$scratch/scripts/release.sh" "$scratch/scripts/changelog.ts"
  # Stage them, then commit, so release.sh's dirty-tree guard sees a clean tree.
  # Staging is what brings the working-tree versions into the scratch at all: when
  # they differ from HEAD (the case this harness exists to cover) an unstaged copy
  # leaves the scratch dirty and every release.sh call is refused. With the two
  # files identical to HEAD the add is a no-op and nothing is committed.
  # A failing commit must be loud (silently swallowing it made the old harness fail
  # with a misleading message).
  git -C "$scratch" add scripts/release.sh scripts/changelog.ts
  if ! git -C "$scratch" diff --cached --quiet; then
    if ! git -C "$scratch" commit -m "test: install working-tree script versions" --no-verify >/dev/null 2>&1; then
      echo "ERROR: setup_scratch: could not commit the script baseline in $scratch" >&2
      exit 1
    fi
  fi
  printf '%s\n' "$scratch"
}

cleanup_scratches() {
  for d in ${SCRATCHES[@]:-}; do
    [ -d "$d" ] && rm -rf "$d"
  done
}
declare -a SCRATCHES=()
trap cleanup_scratches EXIT

# Read the version from package.json in a given directory.
read_version() {
  python3 -c "import json; print(json.load(open('$1/package.json'))['version'])"
}

# Run a command inside the scratch directory.
in_scratch() {
  local s="$1"; shift
  (cd "$s" && "$@")
}

# Strict semver-ish "is $1 strictly greater than $2?" mirroring compareVersions()
# in scripts/changelog.ts (numeric core first, a release outranks a prerelease).
semver_gt() {
  python3 - "$1" "$2" <<'PY'
import sys

def key(v):
    core, _, pre = v.lstrip("v").partition("-")
    nums = [int(p) if p.isdigit() else 0 for p in core.split("+")[0].split(".")]
    return nums, pre

a_nums, a_pre = key(sys.argv[1])
b_nums, b_pre = key(sys.argv[2])
for i in range(max(len(a_nums), len(b_nums))):
    diff = (a_nums[i] if i < len(a_nums) else 0) - (b_nums[i] if i < len(b_nums) else 0)
    if diff:
        sys.exit(0 if diff > 0 else 1)
if a_pre == b_pre:
    sys.exit(1)
if not a_pre:
    sys.exit(0)
if not b_pre:
    sys.exit(1)
sys.exit(0 if a_pre > b_pre else 1)
PY
}

# Print a test version derived from the newest tag of the repo under test: same
# core with the minor bumped, so it compares strictly ahead of that tag (which is
# the one scripts/changelog.ts treats as released). $1: 0 = main, 1 = dirty-tree.
derive_version() {
  python3 - "$LATEST_TAG" "$1" <<'PY'
import sys

core = sys.argv[1].lstrip("v").split("+")[0].split("-")[0]
parts = core.split(".")
major = int(parts[0]) if parts[0].isdigit() else 0
minor = int(parts[1]) if len(parts) > 1 and parts[1].isdigit() else 0
print(f"{major}.{minor + 1}.{'0-test.0' if sys.argv[2] == '0' else '1-dirty-test'}")
PY
}

# ═════════════════════════════════════════════════════════════════════════════
# 0. Derive the versions under test from the repo's tags
# ═════════════════════════════════════════════════════════════════════════════

echo ""
echo "=== 0. derived test versions (from the tags of the repo under test) ==="

# Exactly the tag scripts/changelog.ts picks as "latest".
LATEST_TAG="$(git -C "$SCRIPT_DIR" tag --list --sort=creatordate | tail -1)"
if [ -z "$LATEST_TAG" ]; then
  fail "no tags in $SCRIPT_DIR — cannot derive test versions (changelog.ts requires ≥1 tag)"
  echo ""
  echo "Results: $PASS passed, $FAIL failed"
  exit 1
fi

TEST_VER="$(derive_version 0)"
TEST_VER2="$(derive_version 1)"
TEST_TAG="v${TEST_VER}"

SEMVER_RE='^[0-9]+\.[0-9]+\.[0-9]+([-+][A-Za-z0-9._-]+)?$'
if [[ "$TEST_VER" =~ $SEMVER_RE ]] && [[ "$TEST_VER2" =~ $SEMVER_RE ]]; then
  pass "derived TEST_VER=$TEST_VER TEST_VER2=$TEST_VER2 (latest tag $LATEST_TAG)"
else
  fail "derived versions are not valid semver: TEST_VER='$TEST_VER' TEST_VER2='$TEST_VER2'"
  echo ""
  echo "Results: $PASS passed, $FAIL failed"
  exit 1
fi

if semver_gt "$TEST_VER" "$LATEST_TAG"; then
  pass "TEST_VER=$TEST_VER is strictly ahead of the latest tag $LATEST_TAG"
else
  fail "TEST_VER=$TEST_VER is NOT ahead of the latest tag $LATEST_TAG (changelog.ts would refuse to run)"
fi

if semver_gt "$TEST_VER2" "$LATEST_TAG"; then
  pass "TEST_VER2=$TEST_VER2 is strictly ahead of the latest tag $LATEST_TAG"
else
  fail "TEST_VER2=$TEST_VER2 is NOT ahead of the latest tag $LATEST_TAG (changelog.ts would refuse to run)"
fi

# ═════════════════════════════════════════════════════════════════════════════
# 1. release.sh: version bump produces package.json + CHANGELOG changes, NO tag
# ═════════════════════════════════════════════════════════════════════════════

echo ""
echo "=== 1. release.sh: bump + changelog, no git mutation ==="
SCRATCH=$(setup_scratch)
SCRATCHES+=("$SCRATCH")

BEFORE_TAG_COUNT=$(git -C "$SCRATCH" tag --list | wc -l)
BEFORE_COMMIT_COUNT=$(git -C "$SCRATCH" rev-list --count HEAD)

RC=0
in_scratch "$SCRATCH" bash scripts/release.sh "$TEST_VER" > /tmp/release-out.log 2>&1 || RC=$?

[ "$RC" -eq 0 ] && pass "release.sh exits 0 for $TEST_VER" || fail "release.sh exited $RC (log: $(head -3 /tmp/release-out.log))"

# package.json must be bumped.
CUR_VER=$(read_version "$SCRATCH")
[ "$CUR_VER" = "$TEST_VER" ] && pass "package.json bumped to $CUR_VER" || fail "package.json version=$CUR_VER (expected $TEST_VER)"

# CHANGELOG.md must contain a pending section for the new version.
if grep -q "^## ${TEST_TAG}" "$SCRATCH/CHANGELOG.md"; then
  pass "CHANGELOG.md contains pending section ## $TEST_TAG"
else
  fail "CHANGELOG.md missing pending section ## $TEST_TAG"
fi

# No new tags must have been created.
AFTER_TAG_COUNT=$(git -C "$SCRATCH" tag --list | wc -l)
[ "$AFTER_TAG_COUNT" -eq "$BEFORE_TAG_COUNT" ] && \
  pass "No new git tag created ($AFTER_TAG_COUNT tags)" || \
  fail "Unexpected tag count: $AFTER_TAG_COUNT (expected $BEFORE_TAG_COUNT)"

# No new commits must have been created.
AFTER_COMMIT_COUNT=$(git -C "$SCRATCH" rev-list --count HEAD)
[ "$AFTER_COMMIT_COUNT" -eq "$BEFORE_COMMIT_COUNT" ] && \
  pass "No new commit created ($AFTER_COMMIT_COUNT commits)" || \
  fail "Unexpected commit count: $AFTER_COMMIT_COUNT (expected $BEFORE_COMMIT_COUNT)"

# Working tree must show modified files (package.json + CHANGELOG.md).
MODIFIED=$(git -C "$SCRATCH" status --porcelain | wc -l)
[ "$MODIFIED" -ge 2 ] && pass "Working tree has ≥2 modified files ($MODIFIED)" || fail "Only $MODIFIED modified file(s)"

# ═════════════════════════════════════════════════════════════════════════════
# 2. release.sh: idempotent re-run with same version
# ═════════════════════════════════════════════════════════════════════════════

echo ""
echo "=== 2. release.sh: idempotent re-run (after commit) ==="

# Commit the changes from run 1 so the tree is clean for run 2.
git -C "$SCRATCH" add package.json CHANGELOG.md
git -C "$SCRATCH" commit -m "chore: bump version to $TEST_VER" --no-verify >/dev/null 2>&1

BEFORE_COMMIT_COUNT2=$(git -C "$SCRATCH" rev-list --count HEAD)

RC2=0
in_scratch "$SCRATCH" bash scripts/release.sh "$TEST_VER" > /tmp/release-idem.log 2>&1 || RC2=$?

[ "$RC2" -eq 0 ] && pass "release.sh exits 0 on re-run ($TEST_VER)" || fail "release.sh re-run exited $RC2 (log: $(head -3 /tmp/release-idem.log))"

CUR_VER2=$(read_version "$SCRATCH")
[ "$CUR_VER2" = "$TEST_VER" ] && pass "Version still $CUR_VER2 after re-run" || fail "Version drifted to $CUR_VER2"

AFTER_COMMIT_COUNT2=$(git -C "$SCRATCH" rev-list --count HEAD)
[ "$AFTER_COMMIT_COUNT2" -eq "$BEFORE_COMMIT_COUNT2" ] && \
  pass "Re-run created no new commit (release.sh does not commit)" || \
  fail "Re-run commit count: $AFTER_COMMIT_COUNT2 (expected $BEFORE_COMMIT_COUNT2)"

# ═════════════════════════════════════════════════════════════════════════════
# 3. changelog.ts: exits 0 and does NOT commit/push when CHANGELOG unchanged
# ═════════════════════════════════════════════════════════════════════════════

echo ""
echo "=== 3. changelog.ts: no-op when unchanged ==="

BEFORE_COMMIT_COUNT3=$(git -C "$SCRATCH" rev-list --count HEAD)
CHG_HASH_BEFORE=$(md5sum "$SCRATCH/CHANGELOG.md" | awk '{print $1}')

RC3=0
in_scratch "$SCRATCH" bun run scripts/changelog.ts > /tmp/changelog-out.log 2>&1 || RC3=$?

[ "$RC3" -eq 0 ] && pass "changelog.ts exits 0 when no change" || fail "changelog.ts exited $RC3 (log: $(head -3 /tmp/changelog-out.log))"

if grep -qi 'unchanged\|skipping commit' /tmp/changelog-out.log; then
  pass "changelog.ts reported 'unchanged / skipping commit'"
else
  fail "changelog.ts did NOT report unchanged (output: $(head -5 /tmp/changelog-out.log))"
fi

AFTER_COMMIT_COUNT3=$(git -C "$SCRATCH" rev-list --count HEAD)
[ "$AFTER_COMMIT_COUNT3" -eq "$BEFORE_COMMIT_COUNT3" ] && \
  pass "changelog.ts created no commit when unchanged" || \
  fail "changelog.ts created an unexpected commit"

CHG_HASH_AFTER=$(md5sum "$SCRATCH/CHANGELOG.md" | awk '{print $1}')
[ "$CHG_HASH_BEFORE" = "$CHG_HASH_AFTER" ] && \
  pass "CHANGELOG.md content unchanged after second run" || \
  fail "CHANGELOG.md was modified on re-run"

# ═════════════════════════════════════════════════════════════════════════════
# 4. Simulate release.yml detect step (local)
# ═════════════════════════════════════════════════════════════════════════════
# Replicate the shell logic from .github/workflows/release.yml lines 30-93.
# Uses a dedicated scratch with a controlled commit history.

echo ""
echo "=== 4. release.yml detect step simulation ==="

SCRATCH_DETECT=$(setup_scratch)
SCRATCHES+=("$SCRATCH_DETECT")

get_pkg_version() {
  local sha="$1"
  git -C "$SCRATCH_DETECT" show "${sha}:package.json" 2>/dev/null \
    | python3 -c "import sys,json; print(json.load(sys.stdin).get('version',''))" \
    || true
}

detect_release() {
  local new_sha="$1"
  local before="$2"
  local new_version prev_version tag tag_exists prerelease should_release
  new_version=$(get_pkg_version "$new_sha")
  if [ -z "$new_version" ]; then
    echo "should_release=false|version=|tag=|prerelease=false|prev_tag="
    return
  fi
  prev_version=""
  if [ -n "$before" ] && [ "$before" != "0000000000000000000000000000000000000000" ]; then
    prev_version=$(get_pkg_version "$before")
  fi
  tag="v${new_version}"
  tag_exists=false
  [ -n "$(git -C "$SCRATCH_DETECT" tag -l "$tag")" ] && tag_exists=true
  prerelease=false
  [[ "$new_version" == *-* ]] && prerelease=true
  should_release=false
  if [ "$new_version" != "$prev_version" ] && [ "$tag_exists" = "false" ]; then
    should_release=true
  fi
  echo "should_release=${should_release}|version=${new_version}|tag=${tag}|prerelease=${prerelease}|prev_tag=${prev_version:+v${prev_version}}"
}

run_detect_case() {
  local label="$1" new_sha="$2" before_sha="$3" expected_release="$4" expected_prerelease="$5"
  local out released pre
  out=$(detect_release "$new_sha" "$before_sha")
  released=$(echo "$out" | cut -d'|' -f1 | sed 's/should_release=//')
  pre=$(echo "$out" | cut -d'|' -f4 | sed 's/prerelease=//')
  if [ "$released" = "$expected_release" ] && [ "$pre" = "$expected_prerelease" ]; then
    pass "detect [$label]: should_release=$released prerelease=$pre"
  else
    fail "detect [$label]: got should_release=$released prerelease=$pre (expected $expected_release $expected_prerelease)"
    echo "         output: $out"
  fi
}

# Build a commit chain: BASE → bump-0.9.0 → bump-0.9.1 → bump-0.9.2-alpha.0 → bump-0.9.2
BASE_SHA=$(git -C "$SCRATCH_DETECT" rev-parse HEAD)
# Set version to 0.9.0 at base.
sed -i "s/\"version\": *\"[^\"]*\"/\"version\": \"0.9.0\"/" "$SCRATCH_DETECT/package.json"
git -C "$SCRATCH_DETECT" add package.json
git -C "$SCRATCH_DETECT" commit -m "test: base version 0.9.0" --no-verify >/dev/null 2>&1
V0_SHA=$(git -C "$SCRATCH_DETECT" rev-parse HEAD)

# Bump to 0.9.1
sed -i "s/\"version\": *\"[^\"]*\"/\"version\": \"0.9.1\"/" "$SCRATCH_DETECT/package.json"
git -C "$SCRATCH_DETECT" add package.json
git -C "$SCRATCH_DETECT" commit -m "test: bump 0.9.1" --no-verify >/dev/null 2>&1
V1_SHA=$(git -C "$SCRATCH_DETECT" rev-parse HEAD)

# Bump to 0.9.2-alpha.0
sed -i "s/\"version\": *\"[^\"]*\"/\"version\": \"0.9.2-alpha.0\"/" "$SCRATCH_DETECT/package.json"
git -C "$SCRATCH_DETECT" add package.json
git -C "$SCRATCH_DETECT" commit -m "test: bump 0.9.2-alpha.0" --no-verify >/dev/null 2>&1
V_ALPHA_SHA=$(git -C "$SCRATCH_DETECT" rev-parse HEAD)

# Bump to 0.9.2
sed -i "s/\"version\": *\"[^\"]*\"/\"version\": \"0.9.2\"/" "$SCRATCH_DETECT/package.json"
git -C "$SCRATCH_DETECT" add package.json
git -C "$SCRATCH_DETECT" commit -m "test: bump 0.9.2" --no-verify >/dev/null 2>&1
V2_SHA=$(git -C "$SCRATCH_DETECT" rev-parse HEAD)

# Case A: version unchanged (push to existing commit, no tag) → false
run_detect_case "unchanged push" "$V1_SHA" "$V1_SHA" "false" "false"

# Case B: version changed (0.9.0→0.9.1), tag absent → true
run_detect_case "bump + no tag" "$V1_SHA" "$V0_SHA" "true" "false"

# Case C: version changed, tag already exists → false
git -C "$SCRATCH_DETECT" tag "v0.9.1"
run_detect_case "bump + tag exists" "$V1_SHA" "$V0_SHA" "false" "false"
git -C "$SCRATCH_DETECT" tag -d v0.9.1 2>/dev/null || true

# Case D: prerelease flag for - versions (0.9.1→0.9.2-alpha.0, no tag) → true, prerelease=true
run_detect_case "prerelease version" "$V_ALPHA_SHA" "$V1_SHA" "true" "true"

# Case E: stable version (0.9.2-alpha.0→0.9.2, no tag) → true, prerelease=false
run_detect_case "stable version" "$V2_SHA" "$V_ALPHA_SHA" "true" "false"

# Case F: missing package.json → false
BAD_SHA="deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
run_detect_case "missing package.json" "$BAD_SHA" "$V2_SHA" "false" "false"

# ═════════════════════════════════════════════════════════════════════════════
# 5. release.sh: rejects invalid semver
# ═════════════════════════════════════════════════════════════════════════════
# CWD inside a scratch: release.sh must never be invoked from the repo under test.

echo ""
echo "=== 5. release.sh: invalid semver rejection ==="

SCRATCH5=$(setup_scratch)
SCRATCHES+=("$SCRATCH5")

RC5_A=0
in_scratch "$SCRATCH5" bash scripts/release.sh "not-a-version" > /tmp/release-bad.log 2>&1 || RC5_A=$?
[ "$RC5_A" -ne 0 ] && pass "release.sh rejected invalid version" || fail "release.sh accepted invalid version"

RC5_B=0
in_scratch "$SCRATCH5" bash scripts/release.sh "0.8" > /tmp/release-bad2.log 2>&1 || RC5_B=$?
[ "$RC5_B" -ne 0 ] && pass "release.sh rejected incomplete semver" || fail "release.sh accepted incomplete semver"

RC5_C=0
in_scratch "$SCRATCH5" bash scripts/release.sh "" > /tmp/release-bad3.log 2>&1 || RC5_C=$?
[ "$RC5_C" -ne 0 ] && pass "release.sh rejected empty version" || fail "release.sh accepted empty version"

# A rejection must happen before any write into the CWD tree.
SCRATCH5_DIRT=$(git -C "$SCRATCH5" status --porcelain | wc -l)
[ "$SCRATCH5_DIRT" -eq 0 ] && \
  pass "invalid-semver rejections left the scratch tree untouched" || \
  fail "invalid-semver rejections wrote $SCRATCH5_DIRT path(s) into the scratch tree"

# ═════════════════════════════════════════════════════════════════════════════
# 6. release.sh: dirty-tree guard — clean tree accepted, dirty tree refused
#    Both halves run with CWD inside the same scratch (never the repo under test).
# ═════════════════════════════════════════════════════════════════════════════

echo ""
echo "=== 6. release.sh: dirty-tree guard ==="

SCRATCH2=$(setup_scratch)
SCRATCHES+=("$SCRATCH2")

# 6a. Clean tree → accepted (exit 0).
RC6_CLEAN=0
in_scratch "$SCRATCH2" bash scripts/release.sh "$TEST_VER2" > /tmp/release-clean.log 2>&1 || RC6_CLEAN=$?
[ "$RC6_CLEAN" -eq 0 ] && \
  pass "release.sh accepted the clean scratch tree (exit 0)" || \
  fail "release.sh exited $RC6_CLEAN on a clean scratch tree (log: $(head -3 /tmp/release-clean.log))"

CUR_VER_DIRTY=$(read_version "$SCRATCH2")
[ "$CUR_VER_DIRTY" = "$TEST_VER2" ] && \
  pass "clean-tree run bumped package.json to $CUR_VER_DIRTY" || \
  fail "clean-tree run left package.json at $CUR_VER_DIRTY (expected $TEST_VER2)"

# Restore a clean tree so the refusal below can only come from the injected dirt.
git -C "$SCRATCH2" add package.json CHANGELOG.md
git -C "$SCRATCH2" commit -m "chore: bump version to $TEST_VER2" --no-verify >/dev/null 2>&1
CLEAN_AFTER_COMMIT=$(git -C "$SCRATCH2" status --porcelain | wc -l)
[ "$CLEAN_AFTER_COMMIT" -eq 0 ] && \
  pass "scratch is clean again before the dirty-tree case" || \
  fail "scratch still has $CLEAN_AFTER_COMMIT dirty path(s) before the dirty-tree case"

# 6b. Dirty that same scratch → refused (non-zero) and nothing written.
echo "random" >> "$SCRATCH2/package.json"
PKG_HASH_PRE_REFUSAL=$(md5_of "$SCRATCH2/package.json")
RC6_DIRTY=0
in_scratch "$SCRATCH2" bash scripts/release.sh "$TEST_VER2" > /tmp/release-dirty.log 2>&1 || RC6_DIRTY=$?
[ "$RC6_DIRTY" -ne 0 ] && \
  pass "release.sh refused the dirty scratch tree (exit $RC6_DIRTY)" || \
  fail "release.sh ran on a dirty tree (exit 0)"

if grep -q 'uncommitted changes' /tmp/release-dirty.log; then
  pass "refusal comes from the dirty-tree guard (not the changelog guard)"
else
  fail "refusal does not cite uncommitted changes (output: $(head -3 /tmp/release-dirty.log))"
fi

PKG_HASH_POST_REFUSAL=$(md5_of "$SCRATCH2/package.json")
[ "$PKG_HASH_PRE_REFUSAL" = "$PKG_HASH_POST_REFUSAL" ] && \
  pass "refused run did not rewrite package.json" || \
  fail "refused run rewrote package.json ($PKG_HASH_PRE_REFUSAL -> $PKG_HASH_POST_REFUSAL)"

# ═════════════════════════════════════════════════════════════════════════════
# 7. release.yml structural guard: structural assertions on .github/workflows/release.yml
#    (issue #873/#874 follow-up — guard the fixes from regressing)
# ═════════════════════════════════════════════════════════════════════════════

echo ""
echo "=== 7. release.yml structural assertions ==="

YML="$SCRIPT_DIR/.github/workflows/release.yml"
[ -f "$YML" ] && pass "release.yml exists" || { fail "release.yml missing"; YML=""; }

if [ -n "$YML" ]; then
  # 7a. fetch-depth: 0 on BOTH the detect and release (notes) checkouts.
  FETCH_DEPTH_COUNT=$(grep -c 'fetch-depth: 0' "$YML" || true)
  [ "$FETCH_DEPTH_COUNT" -ge 2 ] && \
    pass "fetch-depth: 0 present on ≥2 checkouts (detect + release notes)" || \
    fail "fetch-depth: 0 found on only $FETCH_DEPTH_COUNT checkout(s) (need ≥2: detect + release)"

  # 7b. Concurrency group that does NOT cancel in-progress runs.
  if grep -q 'cancel-in-progress: false' "$YML"; then
    pass "concurrency cancel-in-progress is false (duplicate runs safe)"
  else
    fail "concurrency cancel-in-progress is NOT false (duplicate runs may be cancelled)"
  fi

  # 7c. Tag-exists re-check precedes tag creation (idempotent re-entry guard).
  if grep -q 'git tag -l' "$YML"; then
    pass "tag-exists re-check present before tag creation"
  else
    fail "no tag-exists re-check before tag creation (risk of duplicate-tag failure)"
  fi

  # 7d. Release-exists re-check precedes gh release create (idempotent re-entry guard).
  if grep -q 'gh release view' "$YML"; then
    pass "release-exists re-check present before Release creation"
  else
    fail "no release-exists re-check before gh release create (risk of duplicate-release error)"
  fi

  # 7e. No leftover debug echo lines in the detect step.
  #     The detect step runs from line 25 through the job boundary before 'verify:'.
  #     We check that no line in the detect section contains a bare 'echo' with
  #     debugging keywords (not the structured GITHUB_OUTPUT echo lines).
  DETECT_SECTION=$(sed -n '/^  detect:/,/^  [a-z]/p' "$YML")
  DEBUG_ECHO=$(printf '%s\n' "$DETECT_SECTION" | grep -iE '^\s+echo\s+["\x27][^$]' | grep -iv 'GITHUB_OUTPUT\|should_release\|version\|tag\|prerelease\|prev_tag\|No version' || true)
  if [ -z "$DEBUG_ECHO" ]; then
    pass "No leftover debug echo lines in detect step"
  else
    fail "Debug echo line(s) remain in detect step: $(printf '%s\n' "$DEBUG_ECHO" | head -3)"
  fi

  # 7g. workflow_dispatch trigger present alongside push.
  if grep -q 'workflow_dispatch' "$YML"; then
    pass "workflow_dispatch trigger is present"
  else
    fail "workflow_dispatch trigger is MISSING (releases cannot be manually triggered)"
  fi

  # 7h. Git identity configured before tag creation (required for annotated tags).
  if grep -q 'git config --global user.name' "$YML" && grep -q 'git config --global user.email' "$YML"; then
    # Verify the identity step appears BEFORE the "Create annotated tag" step.
    IDENTITY_LINE=$(grep -n 'git config --global user.name' "$YML" | head -1 | cut -d: -f1)
    TAG_LINE=$(grep -n 'Create annotated tag' "$YML" | head -1 | cut -d: -f1)
    if [ -n "$IDENTITY_LINE" ] && [ -n "$TAG_LINE" ] && [ "$IDENTITY_LINE" -lt "$TAG_LINE" ]; then
      pass "Git identity configured before annotated tag step (line $IDENTITY_LINE < $TAG_LINE)"
    else
      fail "Git identity step is missing or appears AFTER the tag creation step"
    fi
  else
    fail "Git identity (user.name / user.email) configuration is MISSING before tag creation"
  fi

  # 7i. prev_tag fallback: when github.event.before is empty, derive from newest tag by creatordate.
  #     Uses fixed-string exact-tag exclusion (grep -Fxv) to avoid regex interpretation of tag names.
  if grep -q 'git tag --sort=-creatordate' "$YML" && grep -q 'grep -Fxv' "$YML"; then
    pass "prev_tag fallback via creatordate present for workflow_dispatch scenario (fixed-string exclusion)"
  else
    fail "prev_tag fallback via creatordate is MISSING or uses regex exclusion (workflow_dispatch cannot derive prev_tag)"
  fi

  # 7j. Notes step: no `|| true` swallowing real command failures.
  #     The notes step is the `Build Release Notes` job step (id: notes).
  #     grep commands with || true are expected (no-match exit 1); we check
  #     that non-grep commands don't have || true.
  NOTES_SECTION=$(sed -n '/- name: Build Release Notes/,/^- name:/p' "$YML")
  # Lines with || true that are NOT grep commands.
  SILENCED_NON_GREP=$(printf '%s\n' "$NOTES_SECTION" | grep -E '\|\| true' | grep -v 'grep ' || true)
  if [ -z "$SILENCED_NON_GREP" ]; then
    pass "Notes step: no non-grep commands swallow failures with || true"
  else
    fail "Notes step has non-grep || true swallowing failures: $(printf '%s\n' "$NOTES_SECTION" | grep -E '\|\| true' | grep -v 'grep ' | head -3)"
  fi
fi

# ═════════════════════════════════════════════════════════════════════════════
# 8. Safety net: the repo under test must be byte-identical
# ═════════════════════════════════════════════════════════════════════════════

echo ""
echo "=== 8. safety net: repo under test untouched ==="

REAL_PKG_MD5_AFTER="$(md5_of "$REAL_PKG")"
REAL_CHANGELOG_MD5_AFTER="$(md5_of "$REAL_CHANGELOG")"

if [ "$REAL_PKG_MD5_BEFORE" = "$REAL_PKG_MD5_AFTER" ]; then
  pass "repo-under-test package.json unchanged (md5 $REAL_PKG_MD5_AFTER)"
else
  fail "DESTRUCTIVE: $REAL_PKG changed ($REAL_PKG_MD5_BEFORE -> $REAL_PKG_MD5_AFTER)"
fi

if [ "$REAL_CHANGELOG_MD5_BEFORE" = "$REAL_CHANGELOG_MD5_AFTER" ]; then
  pass "repo-under-test CHANGELOG.md unchanged (md5 $REAL_CHANGELOG_MD5_AFTER)"
else
  fail "DESTRUCTIVE: $REAL_CHANGELOG changed ($REAL_CHANGELOG_MD5_BEFORE -> $REAL_CHANGELOG_MD5_AFTER)"
fi

# ═════════════════════════════════════════════════════════════════════════════
# Summary
# ═════════════════════════════════════════════════════════════════════════════

echo ""
echo "Results: $PASS passed, $FAIL failed"

if [ "$FAIL" -gt 0 ]; then
  echo ""
  echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
  echo "!! $FAIL assertion(s) FAILED — see the FAIL lines above."
  if [ "$REAL_PKG_MD5_BEFORE" != "$REAL_PKG_MD5_AFTER" ] || \
     [ "$REAL_CHANGELOG_MD5_BEFORE" != "$REAL_CHANGELOG_MD5_AFTER" ]; then
    echo "!! DESTRUCTIVE RUN: the repo under test ($SCRIPT_DIR) was MODIFIED."
    echo "!! Restore package.json / CHANGELOG.md from git before continuing."
  fi
  echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
  exit 1
fi

exit 0
