#!/usr/bin/env bash
# Durable regression tests for hardened deploy scripts (issue #136).
# Run: bash scripts/tests/deploy-scripts.test.sh
# These tests verify structural properties of the hardened deploy scripts;
# they do not depend on specific tag values or network access.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
LIB="$SCRIPT_DIR/lib/deploy-common.sh"

PASS=0; FAIL=0
pass() { echo "  PASS: $*"; ((PASS++)) || true; }
fail() { echo "  FAIL: $*"; ((FAIL++)) || true; }

cd "$SCRIPT_DIR/.."
. "$LIB"

echo "=== Deploy script regression tests (issue #136) ==="

# --- Tag/version/secret helpers ---

STABLE=$(latest_stable_tag .)
PRE=$(latest_prerelease_tag .)
ANY=$(latest_any_tag .)
VER=$(read_package_version package.json)

[ -n "$STABLE" ] && pass "stable tag resolved: $STABLE" || fail "no stable tag"
[ -n "$PRE" ] && pass "prerelease tag resolved: $PRE" || fail "no prerelease tag"
[ -n "$ANY" ] && pass "any tag resolved: $ANY" || fail "no any tag"
[ -n "$VER" ] && pass "version read: $VER" || fail "version unreadable"

SEC=$(generate_secret)
[ ${#SEC} -ge 20 ] && pass "secret length=${#SEC}" || fail "secret too short: ${#SEC}"

# --- Systemd unit hardening: StartLimit* must be in [Unit], not [Service] ---

INSTALL_SH="$SCRIPT_DIR/install.sh"
unit_line=$(grep -n '\[Unit\]' "$INSTALL_SH" | head -1 | cut -d: -f1)
svc_line=$(grep -n '\[Service\]' "$INSTALL_SH" | head -1 | cut -d: -f1)
startlim_line=$(grep -n 'StartLimitIntervalSec' "$INSTALL_SH" | head -1 | cut -d: -f1)
if [ -n "$unit_line" ] && [ -n "$svc_line" ] && [ -n "$startlim_line" ]; then
  if [ "$startlim_line" -gt "$unit_line" ] && [ "$startlim_line" -lt "$svc_line" ]; then
    pass "StartLimit* in [Unit] section (unit@$unit_line startlim@$startlim_line service@$svc_line)"
  else
    fail "StartLimit* NOT in [Unit] (unit@$unit_line startlim@$startlim_line service@$svc_line)"
  fi
else
  fail "could not locate [Unit]/[Service]/StartLimit markers in install.sh"
fi

# --- .env.example: no active (uncommented) secret ---

if grep -qE '^[^#]*SYNAPTOMIND_SECRET=' .env.example 2>/dev/null; then
  fail ".env.example has an active (uncommented) SYNAPTOMIND_SECRET"
else
  pass ".env.example: no active secret"
fi

# --- update.sh changelog range uses v prefix ---

if grep -q 'git log "v${CURRENT}..${LATEST_TAG}"' scripts/update.sh; then
  pass "update.sh changelog range uses v prefix"
else
  fail "update.sh changelog range missing v prefix"
fi

# --- No duplicated tag/helper implementations remain ---

for s in install.sh update.sh deploy.sh; do
  if grep -qE 'find_latest_(stable|prerelease)\(\)' "scripts/$s" 2>/dev/null; then
    fail "$s still has duplicated find_latest_* function"
  else
    pass "$s: no duplicated find_latest_* function"
  fi
done

# --- All entry scripts source the shared helper ---

for s in install.sh update.sh deploy.sh synaptomind release.sh; do
  if grep -q 'deploy-common.sh' "scripts/$s" 2>/dev/null; then
    pass "$s sources deploy-common.sh"
  else
    fail "$s does NOT source deploy-common.sh"
  fi
done

# --- install.sh --no-service skips systemctl start ---

if grep -q 'NO_SERVICE=true' scripts/install.sh && \
   grep -q 'Skipping systemd service' scripts/install.sh && \
   grep -q 'Skipping service verification' scripts/install.sh; then
  pass "install.sh: --no-service path has skip checks"
else
  fail "install.sh: --no-service skip checks missing"
fi

# --- .env written with 0600 in install.sh and deploy.sh ---

if grep -q 'umask 077' scripts/install.sh && grep -q 'chmod 600.*\.env' scripts/install.sh; then
  pass "install.sh: .env written with umask 077 + chmod 600"
else
  fail "install.sh: .env permission hardening missing"
fi

if grep -q 'umask 077' scripts/deploy.sh && grep -q 'chmod 600.*\.env' scripts/deploy.sh; then
  pass "deploy.sh: .env written with umask 077 + chmod 600"
else
  fail "deploy.sh: .env permission hardening missing"
fi

# --- update.sh backs up DB before switching code ---

if grep -q 'backup_databases' scripts/update.sh && grep -q 'verify_health' scripts/update.sh; then
  pass "update.sh: backup_databases + verify_health present"
else
  fail "update.sh: backup/verify functions missing"
fi

# --- SYNAPTOMIND_PORT is NOT forced into the systemd unit ---

if grep -q 'Environment=SYNAPTOMIND_PORT' scripts/install.sh; then
  fail "install.sh still forces SYNAPTOMIND_PORT into unit"
else
  pass "install.sh: SYNAPTOMIND_PORT no longer forced into unit"
fi

echo ""
echo "Results: $PASS passed, $FAIL failed"
exit ${FAIL:-0}
