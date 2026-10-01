#!/usr/bin/env bash

# Provenance: vendored verbatim from https://forgejo.home.lan/authelia/bun-templates commit 89be318daf8adab5ddca957162b3b7df8429e725
# ════════════════════════════════════════════════════════════════════════════
#  update.sh — move an installed app to a newer version
#
#  Usage:
#      bash <state-dir>/scripts/update.sh [OPTIONS]
#
#  Options:
#      --version TAG   Update to a specific version (default: resolve latest)
#      --yes           Do not prompt (required for downgrades / non-interactive)
#      --help, -h      Show this help
#
#  Order of operations:
#      compare versions -> refuse same/downgrade -> pre-update hook
#      -> fetch + swap -> post-update hook -> refresh unit -> restart + health
#      -> rollback hint
#
#  DIST=binary swaps a release tarball's payload (executable + vec0.so +
#  lib/libonnxruntime.so.1) instead of a git checkout; see
#  docs/adr/0001-self-contained-binary-tarball-deployment.md.
# ════════════════════════════════════════════════════════════════════════════
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd -P)" || SCRIPT_DIR=""

load_common() {
  local cand
  for cand in "${SCRIPT_DIR}/lib/common.sh" "${SCRIPT_DIR}/common.sh"; do
    if [ -f "$cand" ]; then
      # shellcheck source=lib/common.sh
      . "$cand"
      return 0
    fi
  done
  echo "[app] ERROR: cannot find lib/common.sh next to $0" >&2
  exit 1
}
load_common
trap cleanup_run EXIT

ARG_VERSION=""
ASSUME_YES=false

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --version) ARG_VERSION="$2"; shift 2 ;;
      --yes|-y)  ASSUME_YES=true;  shift   ;;
      --help|-h) sed -n '2,16p' "$0" 2>/dev/null || echo "See the comment header of update.sh"; exit 0 ;;
      *) error "unknown option: $1 (try --help)" ;;
    esac
  done
}

# ── Current / target version ───────────────────────────────────────────────
current_version() {
  if [ "$DIST" = "binary" ]; then
    local bin="${INSTALL_DIR}/${APP_NAME}"
    if [ -x "$bin" ]; then app_version "$bin"; else echo "unknown"; fi
  else
    local v
    v="$(read_package_version "${INSTALL_DIR}/package.json")"
    echo "${v:-unknown}"
  fi
}

# package.json version at origin/<branch> (source branch policy only).
#
# Sets REMOTE_PKG_VERSION instead of printing it. This function is called from a
# command substitution, and a command substitution is a SUBSHELL: the
# `cleanup_add` that used to sit here appended to the subshell's copy of the
# registry, so the EXIT trap never saw the temp file and it survived every
# source-mode update that resolved a branch. Same reason binary_stage_payload()
# sets STAGED_PAYLOAD and updater.sh sets STAGE_ROOT rather than printing them.
REMOTE_PKG_VERSION=""
remote_pkg_version() {
  local tmp=""
  mktemp_owned tmp || return 0
  if git -C "$INSTALL_DIR" show "origin/${1}:package.json" > "$tmp" 2>/dev/null; then
    REMOTE_PKG_VERSION="$(read_package_version "$tmp")"
  fi
}

# ── Hooks ──────────────────────────────────────────────────────────────────
# The backups the pre-update hook reported, filled by collect_db_backups from the
# hook's own output. print_recovery restores exactly these.
DB_BACKUPS=()

# collect_db_backups FILE — the backup paths the pre-update hook printed.
#
# The hook's line IS the record: "… Database backed up: <path>", where <path> is
# <db>.backup/<name>.<timestamp>.bak. It is parsed rather than re-derived because
# the hook is the INSTALLED copy, possibly from an older release: those print the
# same line, while a path re-derived from this release's config.json would be
# wrong for any host whose database lives elsewhere.
collect_db_backups() {
  local file="$1" line path
  DB_BACKUPS=()
  if [ ! -f "$file" ]; then return 0; fi
  while IFS= read -r line; do
    case "$line" in
      *"Database backed up: "*)
        path="${line##*Database backed up: }"
        # Strip trailing whitespace, never a leading one: a path may contain a
        # space, and a mangled path is worse than none.
        path="${path%"${path##*[![:space:]]}"}"
        if [ -n "$path" ]; then DB_BACKUPS+=("$path"); fi
        ;;
    esac
  done < "$file"
  return 0
}

run_hook() {
  local hook="${HOOKS_DIR}/$1" rc=0 out=""
  if [ -x "$hook" ]; then
    info "Running ${1} hook..."
    # The hook's output is DATA, not only a transcript: pre-update names the
    # backup files it produced, and the recovery block restores exactly those
    # (task #1079 F6 — it used to print a literal `synaptomind.db.<timestamp>.bak`,
    # a path that does not exist, so the only DB restore it offered could not
    # run). Teed, so a long backup still streams instead of looking hung, and the
    # hook's stderr joins its stdout in that transcript. BOTH properties are
    # load-bearing; neither may be traded for the exit status below.
    #
    # mktemp_owned, not `out="$(mktemp)"`: the bare mktemp was never registered
    # with the EXIT trap, so every hook run left its transcript in TMPDIR — 91
    # files per run of the deploy suite, on the same filesystem production's
    # SQLite database lives on. The transcript is a temp file, not an artefact:
    # nothing names it after the hook returns, so owning it is correct.
    #
    # WHY `${PIPESTATUS[0]}` (task #1102). The construct here used to be
    # `{ "$hook" 2>&1 || rc=$?; } | tee "$out"`, and it could not report a failed
    # hook: the `|| rc=$?` runs in the LEFT STAGE of a pipeline, and a pipeline
    # stage is a SUBSHELL, so the assignment died there and the parent shell only
    # ever saw tee's status (always 0). A pre-update hook exiting 7 therefore
    # reached `if ! run_hook pre-update` as success, and the guard that a failed
    # database backup must not be followed by a code swap was unreachable — while
    # the comment above claimed the status "crossed the pipe" and update.sh:809
    # called the hook fatal. Reproduced on this host; the fix is to read the
    # stage's own status after the pipeline instead of trying to write it from
    # inside one.
    #
    # Why not the alternatives:
    #   * `${PIPESTATUS[0]}` — what this uses. The hook's real status, streaming
    #     and capture untouched, and `|| rc=` keeps the non-zero pipeline from
    #     tripping `set -e`. Index 0 specifically, so a tee failure (ENOSPC — this
    #     host has filled / before) is NOT misreported as a hook failure.
    #   * plain `|| rc=$?` on the pipeline — works only because `set -o pipefail`
    #     is on, and then it attributes tee's failure to the hook, so a full disk
    #     aborts the update as if the backup had failed.
    #   * `set -e` on the pipeline — rejected by the AC and by the code: it would
    #     abort the script from inside a function whose caller is written to
    #     decide what a hook failure means.
    #   * dropping the tee — not an option at all: the transcript is what
    #     collect_db_backups parses, so the recovery block would name no backup.
    if mktemp_owned out 2>/dev/null; then
      { "$hook" 2>&1; } | tee "$out" || rc=${PIPESTATUS[0]}
      if [ "$1" = "pre-update" ]; then collect_db_backups "$out"; fi
    else
      out=""
      # No pipe here, so `$?` is the hook's own status already (it always was on
      # this branch); kept explicit so the two branches cannot drift apart again.
      "$hook" || rc=$?
      warn "could not capture the ${1} hook's output (no temp file) — the recovery block will name no backup path"
    fi
    # Not "(continuing)": whether a failed hook ends the run is the CALLER's
    # decision (fatal for pre-update, a reported failure for post-update), so
    # this function only reports the status and returns it.
    if [ "$rc" -ne 0 ]; then warn "${1} hook failed (exit ${rc})"; fi
  fi
  return "$rc"
}

# ── Rollback guidance (no automatic revert) ────────────────────────────────
# shell_quote STRING — single-quoted, so a path containing a space or a quote
# survives being pasted into a shell. The printed commands are run by a human,
# and a path from config.json is operator content.
shell_quote() {
  local s="$1"
  printf "'%s'" "${s//\'/\'\\\'\'}"
}

# print_db_restore — the mandatory DB restore, naming the REAL backup files.
#
# The payload is three files, not one commit, and migrations are forward-only
# (src/db/init.ts:127), so a rollback MUST restore the DB backup as well
# (ADR 0001 §2.9). The old text named `data/synaptomind.db.backup/
# synaptomind.db.<timestamp>.bak` — a template, not a file, and one the operator
# had to guess a timestamp into — while claiming the hook "printed each backup
# path" instead of printing the paths it had.
print_db_restore() {
  local b dir db
  if [ "${#DB_BACKUPS[@]}" -eq 0 ]; then
    warn "    # no database backup was reported by the pre-update hook, so there is"
    warn "    # nothing to restore here. On a host that HAS backups, newest first:"
    warn "    sudo ls -lt ${INSTALL_DIR}/data/synaptomind.db.backup/*.bak ${INSTALL_DIR}/data/*.backup/*.bak"
  else
    for b in "${DB_BACKUPS[@]}"; do
      # The hook writes <db>.backup/<name>.<timestamp>.bak (hooks/pre-update), so
      # the database a backup belongs to is the DIRECTORY minus its .backup
      # suffix. Deriving it from the shape the hook itself writes is what keeps
      # this command runnable for a database that does not live under data/ at
      # all, which a re-derived hardcoded path never was.
      dir="${b%/*}"
      db="${dir%.backup}"
      if [ "$dir" = "$b" ] || [ "$db" = "$dir" ] || [ "${b##*/}" = "$b" ]; then
        # Not that shape: name the file and say that its database cannot be
        # derived, rather than printing a guess that would restore over the
        # wrong file.
        warn "    # not a <db>.backup/<name>.bak path — which database it backs up is unknown:"
        warn "    #   sudo cp -p $(shell_quote "$b") <that database>"
        continue
      fi
      warn "    sudo cp -p $(shell_quote "$b") $(shell_quote "$db")"
      warn "    sudo rm -f $(shell_quote "${db}-wal") $(shell_quote "${db}-shm")"
    done
  fi
  warn "  Restoring the DB is mandatory: migrations are forward-only (src/db/init.ts),"
  warn "  so a pre-upgrade binary against a post-upgrade schema is unsafe. Every"
  warn "  database the pre-update hook backed up is listed above — those are the paths"
  warn "  it reported, not a template."
  warn "  A .prev kept only because it was byte-identical restores THIS version rather"
  warn "  than an older one (see binary_keep_previous) — check it before relying on it."
}

# print_unverified — the verdict when the service never answered.
#
# Printed INSTEAD of the rollback block, which used to be printed for exactly this
# case: a service that was merely slow (or an HEALTH_TIMEOUT of 2) was handed a
# remedy that stops the unit, moves the .prev payload back and restores the
# database over the new schema's. Nothing destructive is advised for a silence —
# the payload that was just installed is not evidence of anything, and the
# rollback point stays on disk, named, for an operator who has established that
# the service really is broken (task #1079 F4).
print_unverified() {
  local f port
  port="$(health_url_port "${HEALTH_URL}")"
  warn "the service did not confirm the new version — this update is UNVERIFIED, not failed."
  if [ "${HEALTH_RECHECKED:-false}" = true ]; then
    warn "  ${HEALTH_URL} did not answer as ${APP_NAME} in ${HEALTH_TIMEOUT}s, nor in the"
    warn "  ${HEALTH_CONFIRM_TIMEOUT}s re-check that followed it."
  else
    warn "  ${HEALTH_URL} did not answer as ${APP_NAME} within ${HEALTH_TIMEOUT}s."
  fi
  warn "  what IS done: the payload is swapped in, the unit is refreshed and the"
  warn "  pre-update hook ran. Nothing was rolled back, nothing was restored."
  warn "  check, in this order:"
  warn "    sudo systemctl status ${APP_NAME}"
  warn "    journalctl -u ${APP_NAME} -n 100 --no-pager"
  warn "    curl -sS ${HEALTH_URL}                     # does OUR service answer?"
  if [ -n "$port" ]; then
    warn "    sudo ss -ltnp | grep ':${port}'            # or something else on that port?"
  fi
  warn "  a slow start is the likeliest cause. Raise HEALTH_TIMEOUT (or"
  warn "  HEALTH_CONFIRM_TIMEOUT) in ${RUN_DIR}/scripts/app.env and re-run rather than"
  warn "  reverting a payload that may well be serving."
  if [ "$DIST" = "binary" ]; then
    warn "  if the service does turn out to be broken, the rollback point is still here:"
    for f in $BINARY_ROLLBACK_FILES; do
      if [ -f "${INSTALL_DIR}/${f}.prev" ]; then warn "    ${INSTALL_DIR}/${f}.prev"; fi
    done
  else
    warn "  if the service does turn out to be broken, the previous commit is ${PREV_REF}."
  fi
  if [ "${#DB_BACKUPS[@]}" -gt 0 ]; then
    warn "  the pre-update database backup(s) are untouched:"
    for f in ${DB_BACKUPS[@]+"${DB_BACKUPS[@]}"}; do warn "    ${f}"; done
  fi
  return 0
}

# print_recovery CONFIRMED|UNCONFIRMED
# The remedy for an OBSERVED failure only. A timeout is not observed (see
# print_unverified), so it must never reach this block.
print_recovery() {
  local verdict="${1:-confirmed}"
  if [ "$verdict" != "confirmed" ]; then
    print_unverified
    return 0
  fi
  warn "update did not finish cleanly — previous state:"
  if [ "$DIST" = "binary" ]; then
    warn "  rollback:"
    warn "    sudo systemctl stop ${APP_NAME}"
    warn "    cd ${INSTALL_DIR}"
    warn "    for f in ${BINARY_ROLLBACK_FILES}; do [ -f \"\$f.prev\" ] && sudo mv -f \"\$f.prev\" \"\$f\"; done"
    print_db_restore
    warn "    sudo systemctl start ${APP_NAME}"
  else
    warn "  previous commit: ${PREV_REF}"
    warn "  rollback:        git -C ${INSTALL_DIR} checkout --force ${PREV_REF} && (cd ${INSTALL_DIR} && bun install --frozen-lockfile --production)"
  fi
  return 0
}

# ── restart policy: the source-mode half of the unit refresh ────────────────
# Deliver the template's restart policy to a SOURCE-mode host.
#
# refresh_unit() re-renders the whole unit in binary mode, which carries the
# Restart= line with it. Source mode returns early there, because a full
# re-render would clobber an operator's hand edits — and that made the policy
# UNDELIVERABLE to exactly the hosts that need it: production is DIST=source
# (ExecStart=bun run start), so after the 2026-09-30 outage (an agent's
# name-pattern pkill; the process handled SIGTERM and exited 0; Restart=
# on-failure then left it down for 12 minutes) an update would have kept
# Restart=on-failure forever.
#
# So source mode gets a SURGICAL refresh: the existing Restart= line is rewritten
# in place, and only when it differs. Every other byte of the unit — an operator's
# hand edits included — is preserved, which is the invariant the early return was
# protecting. Nothing is ever INSERTED: a unit with no Restart= line is left
# alone and warned about rather than having a directive appended into an unknown
# section.
#
# Never fatal, unlike refresh_unit: an undelivered restart policy leaves a
# running service (the pre-incident behaviour), whereas failing here would block
# updates outright on a host that is otherwise fine. Every path returns 0.
#
# The write is ATOMIC and the messages describe the unit ON DISK, never the one
# this function meant to write. Both were defects of the first version, found in
# review of d9ff4bb:
#   * `cp -f "$tmp" "$unit"` opens the destination O_TRUNC and then writes, so a
#     copy that died partway (ENOSPC/EIO/killed — the class of event that took
#     production down on 2026-09-30) left the live unit truncated at 24 bytes,
#     while the message said "unchanged ... it still says Restart=on-failure".
#     Both halves were false: the file no longer contained Restart= at all, and
#     the staged good copy was rm -rf'd on the way out. Now the new body is
#     staged beside the unit and swapped in with rename(2), so the unit is
#     either the old file or the new one — never a hybrid — and the previous
#     body is kept as <unit>.bak the way the binary path keeps one.
#     That staging lives in lib/common.sh's write_file_atomically(), which
#     install.sh and refresh_unit() below also use: the same O_TRUNC pattern
#     survived in those two entry points (task #1094) precisely because the
#     mechanism was inlined here instead of shared, so it is shared now.
#   * A unit's mode was forced to 644, which widened a hand-edited unit that may
#     carry Environment= secrets. cp -f over an existing file does not change
#     its mode, so the chmod bought nothing and only ever lost the operator's
#     choice. The mode is now read from the unit and re-applied to the STAGED
#     file by write_file_atomically(), which also stages that file 600 BEFORE
#     any byte lands in it and widens it only after the copy succeeded — the
#     staging file used to inherit the awk render's 644 (umask 022), so a failed
#     stage left the start of a 600 unit, Environment= secrets included, in a
#     world-readable file in the unit directory, and it was left there (task
#     #1094: both findings reproduced, both now covered by the shared function).
ensure_restart_policy() {
  local unit="$1" body current backup now tmpdir tmp
  [ -e "$unit" ] || return 0

  # Read the unit ONCE and tell a read FAILURE apart from an absent directive:
  # the greps used to swallow their errors, so a mode-000 unit came back with an
  # empty result and was reported as "declares no Restart= line" — with a remedy
  # (edit the unit) the operator cannot apply for the very permission reason that
  # made it unreadable.
  if ! body="$(cat -- "$unit" 2>/dev/null)"; then
    warn "Restart policy unchanged in ${unit}: it could not be READ."
    warn "  permissions, not a missing directive — this run wrote nothing."
    warn "  remedy: ls -l ${unit} && sudo chown root:root ${unit} && sudo chmod 644 ${unit}"
    return 0
  fi

  # The EFFECTIVE directive, not the first line that matches: systemd honours the
  # LAST Restart= it reads, so a unit with Restart=always followed by Restart=no
  # is a unit on `no`. Matching a line left that host silently on the outage
  # shape this function exists to prevent — no write, no warning, exit 0.
  current="$(printf '%s\n' "$body" | grep -E '^[[:space:]]*Restart=' | tail -n 1 | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' || true)"
  if [ "$current" = "Restart=always" ]; then
    return 0
  fi
  if [ -z "$current" ]; then
    # No Restart= line at all: systemd's default is "no restart", the same
    # outage shape. Refuse to guess where the directive belongs.
    warn "Restart policy unchanged in ${unit}: it declares no Restart= line."
    warn "  a signalled or cleanly-exited process would then NOT be restarted."
    warn "  remedy: add 'Restart=always' under [Service] in ${unit}, then sudo systemctl daemon-reload"
    return 0
  fi

  if ! command -v systemctl >/dev/null 2>&1; then
    warn "Restart policy unchanged in ${unit}: systemctl is not on PATH."
    warn "  it still says ${current}; remedy: sudo systemctl daemon-reload after editing it"
    return 0
  fi
  if [ "$(id -u)" -ne 0 ] && ! command -v sudo >/dev/null 2>&1; then
    warn "Restart policy unchanged in ${unit}: writing it needs root and sudo is not available."
    warn "  it still says ${current}; remedy: sudo sed -i 's/^Restart=.*/Restart=always/' ${unit} && sudo systemctl daemon-reload"
    return 0
  fi

  # Duplicate Restart= lines are COLLAPSED onto a single Restart=always, in the
  # position and indentation of the first one. Leaving them as several identical
  # lines would be behaviourally correct (systemd takes the last) but leaves a
  # unit whose directive count silently grew with each rewrite; and a duplicate
  # set is itself how the last-wins case got here. Every other byte — an
  # operator's hand edits, their Environment= lines, their comments — is carried
  # through untouched.
  mktemp_owned tmpdir -d || { warn "Restart policy unchanged in ${unit}: no temp dir (TMPDIR unwritable?); it still says ${current}."; return 0; }
  tmp="${tmpdir}/${APP_NAME}.service"
  if ! awk '
    /^[[:space:]]*Restart=/ {
      if (held) next              # a later duplicate: drop it
      held = 1
      line = $0
      sub(/^[[:space:]]*Restart=.*/, "Restart=always", line)
      next
    }
    { if (held) { print line; held = 0 }; print }
    END { if (held) print line }
  ' "$unit" > "$tmp" 2>/dev/null; then
    warn "Restart policy unchanged in ${unit}: cannot rewrite the unit (transform failed); it still says ${current}."
    return 0
  fi

  # Stage BESIDE the unit, under a name nothing loads, and swap with rename(2).
  # write_file_atomically() owns the whole sequence (empty 600 staging file, cp
  # onto it, mode widened only on success, rename, staging file removed on every
  # failure) because each of those steps was a separate finding: a staging file
  # that inherited the awk render's 644 mode carried the first bytes of a 600
  # unit — Environment= secrets included — world-readable in the unit directory,
  # and a FAILED stage left that partial file behind.
  #
  # The previous body, kept for recovery: a swap that turns out to be wrong is
  # only recoverable if the old file still exists somewhere. It goes through the
  # same atomic path, so a .bak is never itself a truncated file.
  backup=""
  if write_file_atomically "${unit}.bak" "$unit"; then
    backup="${unit}.bak"
  else
    warn "  proceeding WITHOUT a recovery copy of the previous unit."
  fi

  if write_file_atomically "$unit" "$tmp"; then
    # Report what is on disk NOW, not what was intended: if something replaced
    # the unit underneath us (a concurrent install), say so.
    now="$(unit_restart_state "$unit")"
    if [ "$now" = "Restart=always" ]; then
      if run_root systemctl daemon-reload; then
        info "Restart policy: ${unit} now carries Restart=always (was: ${current})"
        if [ -n "$backup" ]; then info "  previous unit kept at ${backup}"; fi
      else
        warn "Restart policy written to ${unit} (it now carries Restart=always), but systemctl daemon-reload failed."
        warn "  systemd still has the old policy in memory until it reloads; the service keeps running."
        if [ -n "$backup" ]; then warn "  previous unit kept at ${backup}"; fi
      fi
    else
      warn "Restart policy written to ${unit}, but it now says: ${now}."
      warn "  something replaced the file during this run; leaving it to the operator."
    fi
  else
    # The unit is untouched, so it still says what it said: report that, not the
    # directive this run meant to write.
    warn "Restart policy unchanged in ${unit}: ${ATOMIC_WRITE_REASON}."
    warn "  it still says ${current}; the unit was NOT touched."
    if [ -n "$backup" ]; then warn "  previous unit kept at ${backup}"; fi
  fi
  return 0
}

# What the unit on disk actually says, as ONE line, for a message that must
# report the real state: the effective (last) Restart= directive, or a plain
# statement of why it cannot be read.
unit_restart_state() {
  local unit="$1" body
  if [ ! -e "$unit" ]; then printf 'the file is gone'; return 0; fi
  if ! body="$(cat -- "$unit" 2>/dev/null)"; then printf 'it cannot be READ'; return 0; fi
  local line
  line="$(printf '%s\n' "$body" | grep -E '^[[:space:]]*Restart=' | tail -n 1 | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' || true)"
  if [ -z "$line" ]; then printf 'no Restart= line'; else printf '%s' "$line"; fi
}

# ── systemd unit ────────────────────────────────────────────────────────────
# render_systemd_unit() has exactly ONE call site in the framework
# (install.sh). A unit written before the LD_LIBRARY_PATH line existed therefore
# kept its old body through every update, so a host that updates INTO binary mode
# would run a binary whose embedder cannot dlopen libonnxruntime.so.1
# (ADR 0001 §2.2). Binary mode re-renders and reinstalls the unit here.
#
# Scope is deliberately narrow: source mode returns immediately, because a full
# re-render would clobber an operator's hand edits to the unit. (The other half of
# that justification — "the rendered body is unchanged for source mode" — stopped
# being true once the template gained its Restart= line, so source mode no longer
# returns without an effect: it delegates to ensure_restart_policy above, which
# rewrites that one line and nothing else. A full re-render is still refused.)
#
# In binary mode a refresh that did NOT happen is FATAL (returns 1, and main()
# aborts before the restart). Rationale: the payload has already been swapped at
# this point, so a unit left without Environment=LD_LIBRARY_PATH is a unit that
# starts the new binary with an embedder which dies on ERR_DLOPEN_FAILED — and
# /health still answers status "ok", so nothing downstream would notice. The one
# case that stays non-fatal is a host with NO unit on disk (a --no-service or
# container install): there is nothing there to go stale.
refresh_unit() {
  # UNIT_FILE is overridable so a non-standard unit path (and the deploy tests)
  # need not write to /etc/systemd/system.
  local unit="${UNIT_FILE:-/etc/systemd/system/${APP_NAME}.service}" tmpdir tmp saved
  # Source mode takes the surgical path instead of a full re-render, so the
  # template's restart policy still reaches a source host without clobbering a
  # hand-edited unit. It cannot fail the update.
  if [ "$DIST" != "binary" ]; then ensure_restart_policy "$unit"; return 0; fi

  # Render first, unconditionally: it needs neither root nor systemd, and the
  # rendered body is what the failure message has to point at.
  #
  # The render REFUSES (returns 1) rather than exiting, so this path returns 1
  # like every other refresh failure and main() still prints the recovery block.
  # It used to `error` from inside the renderer, which is exit(1): the payload
  # was already swapped, and the operator got neither the rollback block nor the
  # warning that a re-run will not fix it — and then could not fix it.
  # The render dir is owned from creation (mktemp_owned), so every path below
  # that returns or aborts releases it through the EXIT trap. The ONE exception
  # is the hand-off below, which says so out loud with cleanup_release.
  mktemp_owned tmpdir -d
  tmp="${tmpdir}/${APP_NAME}.service"
  if ! render_systemd_unit "$EXEC_START" > "$tmp"; then
    unit_not_rendered "$unit"
    return 1
  fi

  if command -v systemd-analyze >/dev/null 2>&1; then
    systemd-analyze verify "$tmp" >/dev/null 2>&1 || warn "systemd-analyze verify reported issues"
  fi

  # Keep a copy for the remedy. A plain re-run cannot fix a failed refresh —
  # main()'s "Already up to date" guard returns before refresh_unit is reached
  # again — so the operator needs the rendered unit as a file to install.
  # When RUN_DIR is unwritable the render dir itself must SURVIVE the EXIT trap,
  # or the remedy would name a path the trap just deleted — so the ownership is
  # released explicitly here rather than never taken, which is what made the
  # difference between this path and a forgotten registration invisible.
  saved="${RUN_DIR}/unit-refresh/${APP_NAME}.service"
  if mkdir -p "${RUN_DIR}/unit-refresh" 2>/dev/null && cp -f "$tmp" "$saved" 2>/dev/null; then
    :   # the durable copy exists; the trap still owns the render dir
  else
    saved="$tmp"
    cleanup_release "$tmpdir"
  fi

  local blocked=""
  if ! command -v systemctl >/dev/null 2>&1; then
    blocked="systemctl is not on PATH"
  elif ! systemd_running; then
    blocked="systemd is not running"
  elif [ "$(id -u)" -ne 0 ] && ! command -v sudo >/dev/null 2>&1; then
    blocked="sudo is not available, and writing ${unit} needs root"
  fi
  if [ -n "$blocked" ]; then
    if [ ! -e "$unit" ]; then
      info "No systemd unit at ${unit} — nothing to refresh; start ${EXEC_START} by hand."
      rm -f "$saved" "$tmp"
      return 0
    fi
    unit_not_refreshed "$unit" "$blocked" "$saved"
    return 1
  fi

  # The previous body is kept, so a rendered unit that turns out to be wrong is
  # recoverable: main()'s "Already up to date" guard returns before
  # refresh_unit is reached again, so a plain re-run cannot fix it.
  if [ -e "$unit" ] && ! write_file_atomically "${unit}.bak" "$unit"; then
    warn "  proceeding WITHOUT a recovery copy of the unit this refresh replaces."
  fi

  # `enable` is deliberately NOT repeated: that is install.sh's job.
  # Atomic replacement, not `cp -f` + chmod 644: that pair opened the LIVE unit
  # O_TRUNC, so a copy dying partway (ENOSPC, EIO, killed) left a 24-byte stub
  # where a hand-edited unit was — while this very function went on to report
  # the unit as "left unchanged", and while the forced 644 widened a unit that
  # may carry Environment= secrets. Staged beside the unit and swapped with
  # rename(2), so a failed write is a no-op and the mode is preserved.
  if write_file_atomically "$unit" "$tmp"; then
    # The unit is correct on disk, but until systemd has read it a restart would
    # apply the OLD body — the same failure one step later, so it is fatal too.
    if ! run_root systemctl daemon-reload; then
      unit_not_refreshed "$unit" "systemctl daemon-reload failed after the unit was written" ""
      return 1
    fi
    rm -f "$saved" "$tmp"
    info "Refreshed ${unit}"
  else
    unit_not_refreshed "$unit" "the unit was NOT replaced — ${ATOMIC_WRITE_REASON}" "$saved"
    return 1
  fi
}

# A unit is installed that this update could not refresh, so the payload just
# swapped in would start under a stale unit. Names what failed, the line at
# stake, the difference between the two units, and a remedy. Prints only.
#
# Split in two so the remedy can differ while the CONSEQUENCE cannot: the unit
# on disk is the previous body in both cases, and only one of them has a
# rendered unit to hand over. See unit_not_rendered.
_unit_stale_warning() {
  local unit="$1" reason="$2"
  warn "systemd unit NOT refreshed: ${reason}"
  warn "  installed:  ${unit} (left unchanged)"
  warn "  required:   Environment=LD_LIBRARY_PATH=${INSTALL_DIR}/lib"
  warn "  the payload just installed cannot dlopen lib/libonnxruntime.so.1 without"
  warn "  that line: the embedder child dies on ERR_DLOPEN_FAILED while /health"
  warn "  still reports status ok, so nothing else in this run would notice."
}

# What the operator must not do while the unit is stale, whatever stopped the
# refresh. A re-run does not reach the refresh: the payload is already swapped,
# so main() reports the version as already up to date and returns 0.
_unit_stale_tail() {
  warn "  the running service still serves the PREVIOUS payload; do not restart it"
  warn "  until the unit is fixed, and re-running update.sh will NOT fix it (it"
  warn "  reports the version as already up to date before refreshing anything)."
}

unit_not_refreshed() {
  local unit="$1" reason="$2" saved="$3"
  _unit_stale_warning "$unit" "$reason"
  if [ -n "$saved" ]; then
    warn "  rendered:   ${saved} (this update's unit — diff it against the installed one)"
    warn "  remedy:     sudo install -m 644 ${saved} ${unit}"
    warn "              sudo systemctl daemon-reload"
  else
    # The unit on disk is already correct; systemd simply has not read it yet.
    warn "  the unit on disk IS this update's unit — systemd has not reloaded it"
    warn "  remedy:     sudo systemctl daemon-reload"
  fi
  warn "              sudo systemctl restart ${APP_NAME}"
  _unit_stale_tail
}

# The unit could not be RENDERED at all: a value in app.env would not survive
# systemd's parser (see unit_value_defect), so there is no new body to install
# and — unlike every other failure here — no rendered file to hand over. The
# remedy is therefore not "install this unit over that one": the value has to be
# fixed first, and then something has to re-render. install.sh is that something
# (it re-renders from app.env and re-installs the unit); a plain re-run of
# update.sh is not, for the reason in _unit_stale_tail.
unit_not_rendered() {
  local unit="$1"
  _unit_stale_warning "$unit" "the unit on disk is the PREVIOUS body — it was NOT re-rendered, because a value in app.env would fold, forge or rewrite a directive (named above)"
  warn "  rendered:   nothing — the refusal happens before any unit text is written,"
  warn "              so there is no file to install over the installed one"
  # No rendered file to hand over, so the remedy cannot be "install this unit
  # over that one". The value has to be fixed first, and then something has to
  # re-render — and that something is install.sh, not a re-run of this script
  # (see _unit_stale_tail). install.sh is NOT named by path: it does not copy
  # itself into ${RUN_DIR}/scripts, so a path printed here would not exist.
  warn "  remedy:     fix the value named above in ${RUN_DIR}/scripts/app.env, then"
  warn "              re-run install.sh (the deploy/ copy this update came from) — it"
  warn "              re-renders the unit from the fixed value and installs it"
  warn "  or add the one line above by hand, then:"
  warn "              sudo systemctl daemon-reload"
  warn "              sudo systemctl restart ${APP_NAME}"
  _unit_stale_tail
}

# ── Fetch & swap ───────────────────────────────────────────────────────────
update_source() {
  local bun=""
  git -C "$INSTALL_DIR" fetch --tags --force origin
  if [ -n "$ARG_VERSION" ]; then
    TARGET_REF="$ARG_VERSION"; TARGET_KIND="tag"
  else
    resolve_source_ref "$INSTALL_DIR"
    if [ "$TARGET_KIND" = "branch" ]; then
      local head want
      head="$(git -C "$INSTALL_DIR" rev-parse HEAD 2>/dev/null || true)"
      want="$(git -C "$INSTALL_DIR" rev-parse "origin/${TARGET_REF}" 2>/dev/null || true)"
      if [ -n "$head" ] && [ "$head" = "$want" ]; then
        info "Already up to date (${TARGET_REF} @ ${head:0:8})."
        exit 0
      fi
    fi
  fi

  PREV_REF="$(git -C "$INSTALL_DIR" rev-parse --short HEAD 2>/dev/null || echo unknown)"
  if [ "$TARGET_KIND" = "tag" ]; then
    git -C "$INSTALL_DIR" checkout --force "$TARGET_REF"
  else
    git -C "$INSTALL_DIR" checkout --force -B "$TARGET_REF" --track "origin/${TARGET_REF}"
  fi
  info "Checked out ${TARGET_REF}"

  if [ "${REQUIRES_BUN:-}" = "yes" ]; then
    bun="$(locate_bun || true)"
    [ -n "$bun" ] || error "Bun not found; re-run install.sh"
    info "Installing dependencies..."
    ( cd "$INSTALL_DIR" && "$bun" install --frozen-lockfile --production )
  fi
}

update_binary() {
  binary_install_payload
}

# ── Restart & verify ───────────────────────────────────────────────────────
# Set to true when the health verdict was re-checked, so the UNVERIFIED report
# can say that both windows were used (task #1079 F4).
HEALTH_RECHECKED=false

restart_and_verify() {
  local restarted=false expected="$TARGET_VERSION"
  if [ "$expected" = "unknown" ]; then expected=""; fi
  # Never poll without an expectation when one can be derived. A version-less
  # gate accepts any well-formed /health on the port, which is how a proxy — or
  # a second instance of this app — passed as the service this update installed
  # (F4). The artefact just swapped in is the authority, and it is what /health
  # must report back.
  if [ -z "$expected" ]; then
    installed_version
    expected="$INSTALLED_VERSION"
    if [ -z "$expected" ]; then
      warn "the target version is unknown and cannot be read from ${INSTALL_DIR} —"
      warn "  the health check can no longer tell this service from another one on ${HEALTH_URL}."
    fi
  fi
  if systemd_running && systemctl is-active "$APP_NAME" >/dev/null 2>&1; then
    info "Restarting ${APP_NAME}..."
    run_root systemctl restart "$APP_NAME"
    restarted=true
  else
    info "${APP_NAME} is not running under systemd — start it manually:"
    info "  sudo systemctl start ${APP_NAME}"
  fi

  if [ "$restarted" = true ]; then
    if wait_health "$HEALTH_URL" "$expected" "$HEALTH_TIMEOUT"; then
      return 0
    fi
    # A timeout is this run's own bound, not a fact about the service: with
    # HEALTH_TIMEOUT=2 a healthy upgrade was declared failed — with a remedy
    # that stops the unit and restores the database — while the service went on
    # answering eight seconds later. Re-check before deciding (F4).
    if [ "$HEALTH_FAILURE" = "timeout" ]; then
      if health_recheck "$HEALTH_URL" "$expected" "$HEALTH_CONFIRM_TIMEOUT"; then
        return 0
      fi
      HEALTH_RECHECKED=true
    fi
    # Only a sample that CONTRADICTED the update is a verdict; a silence is not.
    if [ "$HEALTH_FAILURE" = "timeout" ]; then
      print_recovery unconfirmed
    else
      print_recovery confirmed
    fi
    exit 1
  fi
  return 0
}

# ── Main ───────────────────────────────────────────────────────────────────
main() {
  parse_args "$@"
  load_app_env
  [ -n "${APP_NAME:-}" ] || error "APP_NAME is not set in app.env"
  detect_os
  detect_arch
  resolve_target_user

   INSTALL_DIR="${INSTALL_DIR:-/opt/${APP_NAME}}"
   PORT="${PORT:-3000}"
   HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-60}"
   # A second health window, used only when the first one expired with no answer
   # (task #1079 F4). 0 disables the re-check, which is NOT recommended: it is
   # the difference between "unverified" and a destructive remedy.
   HEALTH_CONFIRM_TIMEOUT="${HEALTH_CONFIRM_TIMEOUT:-30}"
   HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:$(resolve_port)/health}"
   HOOKS_DIR="${HOOKS_DIR:-${RUN_DIR}/hooks}"
   # Export RUN_DIR so hook scripts (pre-update / post-update) can locate
   # ${RUN_DIR}/scripts/app.env even when update.sh does not pass it explicitly.
   export RUN_DIR

  if [ "$DIST" = "source" ]; then
    [ -d "${INSTALL_DIR}/.git" ] || error "not installed at ${INSTALL_DIR} — run install.sh first"
    need_cmd git
  elif [ "$DIST" = "binary" ]; then
    [ -x "${INSTALL_DIR}/${APP_NAME}" ] || error "not installed at ${INSTALL_DIR} — run install.sh first"
    command -v curl >/dev/null 2>&1 || command -v wget >/dev/null 2>&1 || error "need curl or wget"
  else
    error "DIST must be 'source' or 'binary' (got '${DIST}')"
  fi

  CURRENT="$(current_version)"
  CURRENT="${CURRENT:-unknown}"

  # -- resolve target --
  if [ "$DIST" = "binary" ]; then
    if [ -n "$ARG_VERSION" ]; then
      TAG="$(normalize_v "$ARG_VERSION")"
    else
      release_resolve_tag
      TAG="$RESOLVED_TAG"
    fi
    TARGET_VERSION="${TAG#v}"
    TARGET_REF="$TAG"
    # refresh_unit needs it; binary mode has no bun, so the default is the
    # artefact itself (mirrors install.sh default_exec_start).
    [ -n "${EXEC_START:-}" ] || EXEC_START="${INSTALL_DIR}/${APP_NAME}"
  else
    TARGET_VERSION=""
    TARGET_REF=""
    git -C "$INSTALL_DIR" fetch --tags --force origin
    if [ -n "$ARG_VERSION" ]; then
      ARG_VERSION="$(normalize_v "$ARG_VERSION")"
      TARGET_REF="$ARG_VERSION"; TARGET_KIND="tag"; TARGET_VERSION="${ARG_VERSION#v}"
    else
      resolve_source_ref "$INSTALL_DIR"
      if [ "$TARGET_KIND" = "tag" ]; then
        TARGET_VERSION="${TARGET_REF#v}"
      else
        remote_pkg_version "$TARGET_REF"
        TARGET_VERSION="${REMOTE_PKG_VERSION:-unknown}"
      fi
    fi
  fi

  info "Current:  ${CURRENT}"
  info "Target:   ${TARGET_VERSION:-unknown}"

  # -- guards --
  if [ -n "$TARGET_VERSION" ] && [ "$TARGET_VERSION" != "unknown" ] && [ "$CURRENT" != "unknown" ]; then
    # BOTH operands normalised. current_version() returns app_version's
    # v-prefixed output for a binary install but a bare package.json version for
    # a source one, and TARGET_VERSION is bare — so without this,
    # `ver_cmp "v0.8.0" "0.9.0"` answers "newer" and a plain upgrade is
    # misreported as a downgrade needing confirmation (ADR 0001 §2.6).
    case "$(ver_cmp "$(normalize_v "$CURRENT")" "$(normalize_v "$TARGET_VERSION")")" in
      same)
        info "Already up to date."
        exit 0 ;;
      newer)
        info "installed ${CURRENT} is newer than ${TARGET_VERSION} (downgrade)."
        if ! confirm "Downgrade ${CURRENT} -> ${TARGET_VERSION}?"; then
          info "Aborted."
          exit 0
        fi ;;
    esac
  fi

  # -- hooks around the swap --
  # SynaptoMind deviation: pre-update is treated as FATAL — a failed DB backup
  # must never be followed by an unchecked code swap.  The upstream template
  # treats all hooks as non-fatal (warn + continue).
  #
  # This guard was UNREACHABLE until task #1102: run_hook could not carry a hook
  # status out of its tee pipeline, so the `if !` here always saw success. It is
  # now live, and `error` (not a bare exit) so the operator gets the same
  # "[app] ERROR:" line as every other fatal path. Aborting HERE is also the only
  # safe point: nothing has been swapped, the unit has not been touched and the
  # service is still running the code it was running a minute ago, so there is
  # nothing to recover — print_recovery would only name backups of an install
  # that is untouched.
  if ! run_hook pre-update; then
    error "pre-update hook failed — aborting before switching code"
  fi
  if [ "$DIST" = "binary" ]; then update_binary; else update_source; fi

  # DELIBERATE DECISION (task #1102): a failed post-update hook does NOT abort
  # mid-flight. By the time it runs the payload is already swapped, so aborting
  # here would leave the host WORSE off than continuing: the unit would not be
  # refreshed and the service would not be restarted, i.e. a swapped payload
  # that nothing has ever executed, with no health verdict and no recovery block.
  # The rest of the run (refresh_unit → restart_and_verify) is exactly the
  # evidence an operator needs, so it still runs.
  #
  # It is also not reported as success. The status is remembered and turned into
  # a non-zero exit AFTER the restart and the health gate, because by then the
  # honest verdict is "the update landed, and a step after the swap did not":
  # post-update is where future migrations would live (the shipped hook is a
  # placeholder), and a silently-ignored failure there is how an operator ends up
  # with code that reports healthy while a migration never ran.
  POST_UPDATE_RC=0
  run_hook post-update || POST_UPDATE_RC=$?

  # -- refresh unit, restart & health --
  # The unit is refreshed BEFORE the restart, so the service comes back with the
  # Environment=LD_LIBRARY_PATH a binary payload needs. A refresh that failed is
  # fatal in binary mode (refresh_unit returns 1): the payload is already
  # swapped, so a restart here would start it under a unit that cannot load
  # libonnxruntime.so.1, and the health gate cannot see that. The recovery block
  # still prints, because the swap is not rolled back automatically.
  if ! refresh_unit; then
    print_recovery
    error "aborting before the restart: the systemd unit is not what this update needs"
  fi
  restart_and_verify

  echo ""
  info "Done. Now at ${TARGET_VERSION:-${TARGET_REF}}."

  # The verdict the operator gets is "landed, but a post-swap step failed", and
  # it is a non-zero exit so a script or an alerting wrapper sees it. AFTER the
  # health gate, deliberately: the service really is up on the new code, and an
  # exit status reported before the restart would say nothing about whether the
  # swap was usable.
  if [ "$POST_UPDATE_RC" -ne 0 ]; then
    error "update landed at ${TARGET_VERSION:-${TARGET_REF}}, but the post-update hook failed (exit ${POST_UPDATE_RC}) — check its output above; the service was restarted on the new code anyway"
  fi
}

main "$@"
