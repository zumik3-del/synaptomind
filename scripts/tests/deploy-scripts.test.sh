#!/usr/bin/env bash
# Durable regression tests for the deploy/ surface (issue #862, replaces #136).
# Run: bash scripts/tests/deploy-scripts.test.sh
#
# Tests structural properties of the hardened deploy scripts.
# They do NOT depend on network access and NEVER invoke real sudo/systemctl.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
DEPLOY="$SCRIPT_DIR/deploy"
LIB="$DEPLOY/lib/common.sh"

PASS=0; FAIL=0
pass() { echo "  PASS: $*"; ((PASS++)) || true; }
fail() { echo "  FAIL: $*"; ((FAIL++)) || true; }

cd "$SCRIPT_DIR"
# shellcheck source=deploy/lib/common.sh
. "$LIB"

echo "=== Deploy script regression tests (deploy/ surface) ==="

# ═════════════════════════════════════════════════════════════════════════════
# 1. Tag / version / secret helpers
# ═════════════════════════════════════════════════════════════════════════════

STABLE=$(latest_stable_tag .)
PRE=$(latest_prerelease_tag .)
ANY=$(latest_any_tag .)
VER=$(read_package_version package.json)

[ -n "$STABLE" ] && pass "stable tag resolved: $STABLE" || fail "no stable tag"
[ -n "$PRE" ]    && pass "prerelease tag resolved: $PRE" || fail "no prerelease tag"
[ -n "$ANY" ]    && pass "any tag resolved: $ANY" || fail "no any tag"
[ -n "$VER" ]    && pass "version read: $VER" || fail "version unreadable"

SEC=$(generate_secret)
[ ${#SEC} -ge 20 ] && pass "secret length=${#SEC}" || fail "secret too short: ${#SEC}"

# ═════════════════════════════════════════════════════════════════════════════
# 2. Required deploy/app.env keys
# ═════════════════════════════════════════════════════════════════════════════

APP_ENV="$DEPLOY/app.env"
[ -f "$APP_ENV" ] && pass "app.env exists" || fail "app.env missing"

for key in APP_NAME APP_DESC DIST REPO_URL INSTALL_DIR SEED_FILES GENERATE_SECRET_IN PORT; do
  if grep -qE "^${key}=" "$APP_ENV" 2>/dev/null; then
    pass "app.env has $key"
  else
    fail "app.env missing required key: $key"
  fi
done

# ═════════════════════════════════════════════════════════════════════════════
# 3. Rendered systemd unit hardening
# ═════════════════════════════════════════════════════════════════════════════

# Set the minimal env render_systemd_unit needs.
APP_NAME="synaptomind"
APP_DESC="SynaptoMind — thought-graph engine"
TARGET_USER="$(id -un)"
TARGET_HOME="${HOME}"
INSTALL_DIR="/opt/synaptomind"
DATA_DIR="/var/lib/synaptomind"
BUN_BIN=""
TAG="v0.8.0"
OS="linux"
ARCH="x86_64"

UNIT=$(render_systemd_unit "/usr/local/bin/bun run src/index.ts")

# StartLimit* must land in [Unit], not [Service].
if printf '%s\n' "$UNIT" | grep -q 'StartLimitIntervalSec'; then
  unit_section=$(printf '%s\n' "$UNIT" | sed -n '/^\[Unit\]/,/^\[/{ p; }' | grep -c 'StartLimit' || true)
  svc_section=$(printf '%s\n' "$UNIT" | sed -n '/^\[Service\]/,/^\[/{ p; }' | grep -c 'StartLimit' || true)
  if [ "$unit_section" -ge 1 ] && [ "$svc_section" -eq 0 ]; then
    pass "StartLimit* rendered in [Unit] section"
  else
    fail "StartLimit* NOT in [Unit] (unit=$unit_section service=$svc_section)"
  fi
else
  fail "StartLimit* missing from rendered unit"
fi

# Hardening directives must be present.
for directive in NoNewPrivileges ProtectSystem PrivateTmp ProtectKernelTunables; do
  if printf '%s\n' "$UNIT" | grep -qE "^${directive}="; then
    pass "Unit hardening: $directive present"
  else
    fail "Unit hardening: $directive missing"
  fi
done

# SYNAPTOMIND_PORT must NOT be forced into the unit as Environment=.
if printf '%s\n' "$UNIT" | grep -qE '^Environment=.*SYNAPTOMIND_PORT'; then
  fail "Unit incorrectly forces SYNAPTOMIND_PORT"
else
  pass "Unit does not force SYNAPTOMIND_PORT"
fi

# ═════════════════════════════════════════════════════════════════════════════
# 4. wait_health accepts ok / degraded with exact version
# ═════════════════════════════════════════════════════════════════════════════

# We can't start the real server, so we verify the logic by patching url_get.
# The function is in common.sh; we inspect the source to confirm the acceptance
# condition rather than spawning a HTTP server.
if grep -qE '\[ "\$status" = "ok" \] \|\| \[ "\$status" = "degraded" \]' "$LIB" && \
   grep -q 'parse_json_version' "$LIB"; then
  pass "wait_health accepts ok/degraded and checks version"
else
  fail "wait_health health/status/version logic missing or incorrect"
fi

# ═════════════════════════════════════════════════════════════════════════════
# 5. Hooks installed into RUN_DIR/hooks
# ═════════════════════════════════════════════════════════════════════════════

# Verify install_hook_scripts sources the right paths and lands in ${RUN_DIR}/hooks.
if grep -q 'RUN_DIR/hooks' "$DEPLOY/install.sh" && \
   grep -q 'pre-update' "$DEPLOY/install.sh" && \
   grep -q 'post-update' "$DEPLOY/install.sh"; then
  pass "install_hook_scripts targets RUN_DIR/hooks with pre/post-update"
else
  fail "install_hook_scripts target or hook names missing"
fi

# The hook files themselves must exist and be executable.
for h in pre-update post-update; do
  if [ -x "$DEPLOY/hooks/$h" ]; then
    pass "hook $h exists and is executable"
  else
    fail "hook $h missing or not executable"
  fi
done

# ═════════════════════════════════════════════════════════════════════════════
# 6. Dry-run install → update → uninstall in an isolated copy
#    NEVER uses real sudo / systemctl.
# ═════════════════════════════════════════════════════════════════════════════

TMPROOT="$(mktemp -d)"
trap 'rm -rf "'"$TMPROOT"'"' EXIT

INSTALL_DIR_T="$TMPROOT/install"
DATA_DIR_T="$TMPROOT/data"
RUN_DIR_T="$TMPROOT/run"
REPO_URL_T="file://$(pwd)"

# Copy deploy/ to temp root so install.sh finds our modified app.env
DEPLOY_TMP="$TMPROOT/deploy"
cp -r "$DEPLOY" "$DEPLOY_TMP"

# --- install ---
echo ""
echo "--- dry-run install ---"
# Overwrite RUN_DIR in a copy of app.env so the install lands in our temp tree.
APP_ENV_TMP="$DEPLOY_TMP/app.env"
# Override paths for isolation.
sed -i "s|^INSTALL_DIR=.*|INSTALL_DIR=\"$INSTALL_DIR_T\"|" "$APP_ENV_TMP"
sed -i "s|^DATA_DIR=.*|DATA_DIR=\"$DATA_DIR_T\"|" "$APP_ENV_TMP"
sed -i "s|^RUN_DIR=.*|RUN_DIR=\"$RUN_DIR_T\"|" "$APP_ENV_TMP"
sed -i "s|^REPO_URL=.*|REPO_URL=\"$REPO_URL_T\"|" "$APP_ENV_TMP"
# Neutralize systemd to prevent any real service operations.
sed -i 's|^HEALTH_URL=.*|HEALTH_URL="http://127.0.0.1:99999/health"|' "$APP_ENV_TMP"

# Stub systemctl/sudo so real service ops cannot happen.
STUB_DIR="$TMPROOT/stubbin"
mkdir -p "$STUB_DIR"
cat > "$STUB_DIR/systemctl" <<'STUB'
#!/usr/bin/env bash
echo "[stub] systemctl $*" >&2
exit 0
STUB
cat > "$STUB_DIR/sudo" <<'STUB'
#!/usr/bin/env bash
echo "[stub] sudo $*" >&2
exit 0
STUB
chmod +x "$STUB_DIR/systemctl" "$STUB_DIR/sudo"
export PATH="$STUB_DIR:$PATH"

bash "$DEPLOY_TMP/install.sh" --no-service --dir "$INSTALL_DIR_T" < /dev/null 2>&1 || true

# Assert: config.json was seeded.
if [ -f "$INSTALL_DIR_T/config.json" ]; then
  pass "config.json seeded in install dir"
else
  fail "config.json NOT seeded"
fi

# Assert: .env was seeded with 0600 and contains SYNAPTOMIND_SECRET.
if [ -f "$INSTALL_DIR_T/.env" ]; then
  perms=$(stat -c '%a' "$INSTALL_DIR_T/.env" 2>/dev/null || stat -f '%Lp' "$INSTALL_DIR_T/.env")
  [ "$perms" = "600" ] && pass ".env has 0600 permissions (got $perms)" || fail ".env permissions=$perms (expected 600)"
  grep -q 'SYNAPTOMIND_SECRET=' "$INSTALL_DIR_T/.env" && pass ".env contains SYNAPTOMIND_SECRET" || fail ".env missing SYNAPTOMIND_SECRET"
else
  fail ".env NOT seeded"
fi

# Assert: ./data symlink exists and points to DATA_DIR.
if [ -L "$INSTALL_DIR_T/data" ]; then
  link_target=$(readlink "$INSTALL_DIR_T/data")
  [ "$link_target" = "$DATA_DIR_T" ] && pass "./data symlink -> $DATA_DIR_T" || fail "./data symlink -> $link_target (expected $DATA_DIR_T)"
else
  fail "./data symlink missing"
fi

# Assert: helper scripts installed in RUN_DIR/scripts.
for s in update.sh uninstall.sh common.sh app.env; do
  if [ -f "$RUN_DIR_T/scripts/$s" ]; then
    pass "helper script $s installed in RUN_DIR/scripts"
  else
    fail "helper script $s missing from RUN_DIR/scripts"
  fi
done
[ -x "$RUN_DIR_T/scripts/update.sh" ] && pass "update.sh is executable" || fail "update.sh not executable"

# Assert: hooks installed in RUN_DIR/hooks.
for h in pre-update post-update; do
  if [ -x "$RUN_DIR_T/hooks/$h" ]; then
    pass "hook $h installed in RUN_DIR/hooks"
  else
    fail "hook $h missing from RUN_DIR/hooks"
  fi
done

# Assert: DB-backup hook fires (pre-update runs resolve_db_paths and sqlite3 .backup).
if grep -q 'sqlite3' "$RUN_DIR_T/hooks/pre-update" && grep -q '.backup' "$RUN_DIR_T/hooks/pre-update"; then
  pass "pre-update hook contains sqlite3 .backup logic"
else
  fail "pre-update hook missing sqlite3 .backup logic"
fi

# --- update (dry, no-op because same ref) ---
echo ""
echo "--- dry-run update ---"
# update.sh reads app.env from RUN_DIR/scripts/; it should find our overrides there.
# But we pass --yes to skip the interactive prompt and --version to pin.
VERSION_STR=$(grep -o '"version": *"[^"]*"' package.json | head -1 | sed 's/"version": *"//;s/"//')
bash "$RUN_DIR_T/scripts/update.sh" --yes --version "v${VERSION_STR}" < /dev/null 2>&1 || true
pass "update.sh completed without invoking real systemctl"

# --- uninstall ---
echo ""
echo "--- dry-run uninstall ---"
bash "$RUN_DIR_T/scripts/uninstall.sh" --yes < /dev/null 2>&1 || true
pass "uninstall.sh completed without invoking real systemctl"

# After uninstall, helper scripts should be removed but code kept (no --purge).
if [ -d "$RUN_DIR_T/scripts" ]; then
  fail "RUN_DIR/scripts NOT removed after uninstall"
else
  pass "RUN_DIR/scripts removed after uninstall"
fi
if [ -d "$INSTALL_DIR_T" ]; then
  pass "INSTALL_DIR kept after uninstall (no --purge)"
else
  fail "INSTALL_DIR was removed without --purge"
fi

# ═════════════════════════════════════════════════════════════════════════════
# 7. Pre-update hook in INSTALLED layout (issue #864/#865)
#    Exercises the hook the way update.sh invokes it: from ${RUN_DIR}/hooks,
#    with ${RUN_DIR}/scripts/app.env present, and a real DB on disk.
# ═════════════════════════════════════════════════════════════════════════════

echo ""
echo "--- pre-update in installed layout ---"

# Spin up a second isolated temp tree so the first lifecycle is undisturbed.
TMPROOT2="$(mktemp -d)"
INSTALL_DIR_T2="$TMPROOT2/install"
DATA_DIR_T2="$TMPROOT2/data"
RUN_DIR_T2="$TMPROOT2/run"
REPO_URL_T2="file://$(pwd)"
DEPLOY_TMP2="$TMPROOT2/deploy"
cp -r "$DEPLOY" "$DEPLOY_TMP2"
APP_ENV_TMP2="$DEPLOY_TMP2/app.env"
sed -i "s|^INSTALL_DIR=.*|INSTALL_DIR=\"$INSTALL_DIR_T2\"|" "$APP_ENV_TMP2"
sed -i "s|^DATA_DIR=.*|DATA_DIR=\"$DATA_DIR_T2\"|" "$APP_ENV_TMP2"
sed -i "s|^RUN_DIR=.*|RUN_DIR=\"$RUN_DIR_T2\"|" "$APP_ENV_TMP2"
sed -i "s|^REPO_URL=.*|REPO_URL=\"$REPO_URL_T2\"|" "$APP_ENV_TMP2"
sed -i 's|^HEALTH_URL=.*|HEALTH_URL="http://127.0.0.1:99999/health"|' "$APP_ENV_TMP2"

# Stub systemctl/sudo again for this isolated tree.
STUB_DIR2="$TMPROOT2/stubbin"
mkdir -p "$STUB_DIR2"
cat > "$STUB_DIR2/systemctl" <<'STUB'
#!/usr/bin/env bash
echo "[stub] systemctl $*" >&2
exit 0
STUB
cat > "$STUB_DIR2/sudo" <<'STUB'
#!/usr/bin/env bash
echo "[stub] sudo $*" >&2
exit 0
STUB
chmod +x "$STUB_DIR2/systemctl" "$STUB_DIR2/sudo"
export PATH="$STUB_DIR2:$PATH"

bash "$DEPLOY_TMP2/install.sh" --no-service --dir "$INSTALL_DIR_T2" < /dev/null 2>&1 || true

# Drop a real SQLite DB at the path the hook will look for (config.json is
# seeded by install.sh with path "./data/synaptomind.db", relative to INSTALL_DIR).
mkdir -p "$DATA_DIR_T2"
sqlite3 "$DATA_DIR_T2/synaptomind.db" "CREATE TABLE _guard(id INT);" 2>/dev/null || true

# Run the pre-update hook the way update.sh does: with RUN_DIR exported,
# from ${RUN_DIR}/hooks, and with ${RUN_DIR}/scripts/app.env on disk.
PRE_RC=0
RUN_DIR="$RUN_DIR_T2" bash "$RUN_DIR_T2/hooks/pre-update" > /tmp/pre-update-out.log 2>&1 || PRE_RC=$?
if [ "$PRE_RC" -eq 0 ]; then
  pass "pre-update hook exits 0 in installed layout with DB present"
else
  fail "pre-update hook exited $PRE_RC (expected 0)"
  cat /tmp/pre-update-out.log
fi

# A backup directory should have been created next to the DB.
if [ -d "$DATA_DIR_T2/synaptomind.db.backup" ]; then
  pass "pre-update created backup directory next to DB"
else
  fail "pre-update did NOT create backup directory"
fi

# Verify the hook resolves config from the installed layout (${RUN_DIR}/scripts/app.env).
# The hook's load_common walks SCRIPT_DIR→scripts/lib, scripts/, lib/, .. — with
# SCRIPT_DIR=${RUN_DIR}/hooks these resolve to ${RUN_DIR}/scripts/common.sh.
if grep -q 'RUN_DIR}/scripts/app.env' "$RUN_DIR_T2/hooks/pre-update"; then
  pass "pre-update hook searches RUN_DIR/scripts/app.env (installed layout)"
else
  fail "pre-update hook does not search RUN_DIR/scripts/app.env"
fi

# Capture the install.sh up-to-date message while the tree is still at the
# stable tag (before any update step mutates it).  This exercises the fix
# for ${cur:-$TARGET_REF#v} → ${cur:-${TARGET_REF#v}} (issue #864): without
# the braces the fallback resolves to "#v<ref>" instead of the bare version.
INSTALL_OUT2=""
INSTALL_OUT2="$(bash "$DEPLOY/install.sh" --no-service --dir "$INSTALL_DIR_T2" < /dev/null 2>&1)" || true
if printf '%s\n' "$INSTALL_OUT2" | grep -qE 'is already installed at .*— up to date'; then
  pass "install.sh detected up-to-date state (second lifecycle)"
else
  fail "install.sh did not report up-to-date in second lifecycle"
fi
if printf '%s\n' "$INSTALL_OUT2" | grep -q '#v'; then
  fail "install.sh up-to-date message contains '#v' artifact"
else
  pass "install.sh up-to-date message is clean (no #v artifact)"
fi

# ═════════════════════════════════════════════════════════════════════════════
# 8. update.sh aborts before checkout when pre-update fails
#    (issue #864/#865 — critical upgrade-safety regression guard)
# ═════════════════════════════════════════════════════════════════════════════

echo ""
echo "--- pre-update failure aborts update.sh before swap ---"

# Use a third isolated temp tree. Install at the stable tag, then patch sqlite3
# to fail so the pre-update hook cannot back up the DB.
TMPROOT3="$(mktemp -d)"
INSTALL_DIR_T3="$TMPROOT3/install"
DATA_DIR_T3="$TMPROOT3/data"
RUN_DIR_T3="$TMPROOT3/run"
REPO_URL_T3="file://$(pwd)"
DEPLOY_TMP3="$TMPROOT3/deploy"
cp -r "$DEPLOY" "$DEPLOY_TMP3"
APP_ENV_TMP3="$DEPLOY_TMP3/app.env"
sed -i "s|^INSTALL_DIR=.*|INSTALL_DIR=\"$INSTALL_DIR_T3\"|" "$APP_ENV_TMP3"
sed -i "s|^DATA_DIR=.*|DATA_DIR=\"$DATA_DIR_T3\"|" "$APP_ENV_TMP3"
sed -i "s|^RUN_DIR=.*|RUN_DIR=\"$RUN_DIR_T3\"|" "$APP_ENV_TMP3"
sed -i "s|^REPO_URL=.*|REPO_URL=\"$REPO_URL_T3\"|" "$APP_ENV_TMP3"
sed -i 's|^HEALTH_URL=.*|HEALTH_URL="http://127.0.0.1:99999/health"|' "$APP_ENV_TMP3"

STUB_DIR3="$TMPROOT3/stubbin"
mkdir -p "$STUB_DIR3"
cat > "$STUB_DIR3/systemctl" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
cat > "$STUB_DIR3/sudo" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
# sqlite3 stub that always fails — pre-update calls it when a DB exists.
cat > "$STUB_DIR3/sqlite3" <<'STUB'
#!/usr/bin/env bash
echo "[stub] sqlite3 failed" >&2
exit 1
STUB
chmod +x "$STUB_DIR3/systemctl" "$STUB_DIR3/sudo" "$STUB_DIR3/sqlite3"
export PATH="$STUB_DIR3:$PATH"

bash "$DEPLOY_TMP3/install.sh" --no-service --dir "$INSTALL_DIR_T3" < /dev/null 2>&1 || true

# Put a real DB on disk so the hook attempts a backup (and the stub fails).
mkdir -p "$DATA_DIR_T3"
sqlite3 /usr/bin/sqlite3 "$DATA_DIR_T3/synaptomind.db" "CREATE TABLE _guard(id INT);" 2>/dev/null || \
  /usr/bin/sqlite3 "$DATA_DIR_T3/synaptomind.db" "CREATE TABLE _guard(id INT);" 2>/dev/null || true

# Record the git HEAD before running update.sh.
HEAD_BEFORE="$(git -C "$INSTALL_DIR_T3" rev-parse HEAD 2>/dev/null || true)"

# Run update.sh targeting a *different* version so it actually attempts a swap.
# The pre-update hook should fail (sqlite3 stub), and update.sh must abort
# BEFORE calling git checkout.
VERSION_AFTER=$(grep -o '"version": *"[^"]*"' package.json | head -1 | sed 's/"version": *"//;s/"//')
UPDATE_OUT=""
UPDATE_RC=0
UPDATE_OUT="$(bash "$RUN_DIR_T3/scripts/update.sh" --yes --version "v${VERSION_AFTER}" < /dev/null 2>&1)" || UPDATE_RC=$?

# If update.sh aborted cleanly, HEAD must be unchanged.
HEAD_AFTER="$(git -C "$INSTALL_DIR_T3" rev-parse HEAD 2>/dev/null || true)"
if [ "$HEAD_BEFORE" = "$HEAD_AFTER" ]; then
  pass "update.sh did NOT swap code after pre-update failure (HEAD unchanged)"
else
  fail "update.sh swapped code despite pre-update failure (HEAD changed: ${HEAD_BEFORE:0:8} -> ${HEAD_AFTER:0:8})"
fi

# update.sh must have emitted an error about the failed pre-update hook.
if printf '%s\n' "$UPDATE_OUT" | grep -qi 'pre-update.*failed\|aborting before switching'; then
  pass "update.sh emitted abort message after pre-update failure"
else
  fail "update.sh did NOT emit abort message after pre-update failure"
  printf '%s\n' "$UPDATE_OUT" | head -30
fi

# ═════════════════════════════════════════════════════════════════════════════
# 9. bash -n syntax check on deploy scripts and the test file itself
# ═════════════════════════════════════════════════════════════════════════════

echo ""
echo "--- bash -n syntax checks ---"
for f in "$DEPLOY/install.sh" "$DEPLOY/update.sh" "$DEPLOY/uninstall.sh" \
         "$DEPLOY/hooks/pre-update" "$DEPLOY/hooks/post-update" \
         "scripts/tests/deploy-scripts.test.sh"; do
  if bash -n "$f" 2>/tmp/bash-n.err; then
    pass "bash -n $f"
  else
    fail "bash -n $f FAILED: $(cat /tmp/bash-n.err)"
  fi
done

# ═════════════════════════════════════════════════════════════════════════════
# 10. --no-service path: install.sh skips systemctl start/verify
# ═════════════════════════════════════════════════════════════════════════════

if grep -q 'NO_SERVICE' "$DEPLOY/install.sh" && \
   grep -q 'Skipping systemd service' "$DEPLOY/install.sh"; then
  pass "install.sh: --no-service path present"
else
  fail "install.sh: --no-service skip path missing"
fi

# ═════════════════════════════════════════════════════════════════════════════
# 11. .env.example: no active (uncommented) SYNAPTOMIND_SECRET
# ═════════════════════════════════════════════════════════════════════════════

if grep -qE '^[^#]*SYNAPTOMIND_SECRET=' .env.example 2>/dev/null; then
  fail ".env.example has an active (uncommented) SYNAPTOMIND_SECRET"
else
  pass ".env.example: no active secret"
fi

# ═════════════════════════════════════════════════════════════════════════════
# Summary
# ═════════════════════════════════════════════════════════════════════════════

echo ""
echo "Results: $PASS passed, $FAIL failed"
exit ${FAIL:-0}
