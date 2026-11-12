# Server Installation & Updates

Install SynaptoMind as a systemd service from a published release tarball
(`DIST=binary`) using the `deploy/` framework, and update it in place. This is
the supported install path; for containers see [DOCKER.md](DOCKER.md), and for
an overview of the project see the [README](../README.md).

---

## Quick Start

```bash
curl -fsSL https://raw.githubusercontent.com/zumik3-del/synaptomind/main/deploy/install.sh | bash
```

A piped script has no sibling files, so the shared helpers and config are fetched
from the published base by default — no environment variables are needed.
`DEPLOY_RAW_URL` overrides that base (forks/mirrors); an explicit `APP_ENV_URL`
or `LIB_RAW_URL` still wins.

The installer downloads the release tarball, extracts it into a staging
directory, verifies the payload, and swaps it into `/opt/synaptomind`. The
server starts on `http://127.0.0.1:3105` (API) and `http://127.0.0.1:3106/mcp`
(MCP). Config lives in `/var/lib/synaptomind/config.json`, reached via the
`/opt/synaptomind/config.json` symlink.

---

## Installation

### One-line install

```bash
curl -fsSL https://raw.githubusercontent.com/zumik3-del/synaptomind/main/deploy/install.sh | bash
```

A piped script has no sibling files, so the shared helpers (`deploy/lib/common.sh`)
and config (`deploy/app.env`) are fetched from the published base by default.
`APP_ENV_URL` and `LIB_RAW_URL` are optional overrides for those two URLs, and
`DEPLOY_RAW_URL` moves the base used for both (forks/mirrors). To pass flags in
the piped form, append them after `bash -s --`:

```bash
curl -fsSL https://raw.githubusercontent.com/zumik3-del/synaptomind/main/deploy/install.sh | bash -s -- --port 3105
```

### From a checkout

From a local checkout, run the installer directly instead:

```bash
git clone https://github.com/zumik3-del/synaptomind.git && cd synaptomind
sudo bash deploy/install.sh
```

### Install flags

Options (append after `--` in the piped form, e.g. `bash -s -- --port 3105`):

| Flag | Effect |
|------|--------|
| `--dir DIR` | Install directory (default `INSTALL_DIR` in `deploy/app.env`) |
| `--port PORT` | Port written to the seeded `config.json` and used by the health check |
| `--version TAG` | Pin a version instead of resolving the latest |
| `--force` | Reinstall even when the same version is already present; also the reinstall-over-a-running-service path, which now restarts the unit |
| `--no-service` | Skip systemd unit installation and start/restart |
| `--help`, `-h` | Show usage |

### What the installer does

The installer resolves the release tag, downloads the release tarball
(`synaptomind-<tag>-linux-x86_64.tar.gz`), extracts it into a staging directory,
and verifies that the payload contains the required files (`synaptomind`,
`vec0.so`, `lib/libonnxruntime.so.1`). It then:

1. Copies each rollback-critical file to `<file>.prev` (skipped when the bytes
   are identical, so a `.prev` is never a false rollback point).
2. Swaps the payload into `/opt/synaptomind` in a fixed order — data files first,
   the executable last — so an interrupted swap leaves old-executable +
   new-data, which is detectable as "old version" rather than "new binary, old
   library".
3. Seeds `config.json` into `/var/lib/synaptomind/` (not the payload tree,
   which is swapped on every update) and `.env` (generating
   `SYNAPTOMIND_SECRET`) into `/opt/synaptomind/`.
4. Creates the `/opt/synaptomind/config.json` → `/var/lib/synaptomind/config.json`
   symlink so the app's cwd-relative config resolver finds it.
5. Links `/opt/synaptomind/data` → `/var/lib/synaptomind`.
6. Installs the helper scripts into `${HOME}/.synaptomind/scripts` and the
   update hooks into `${HOME}/.synaptomind/hooks`.
7. Installs the systemd unit, **restarts** it, and polls `/health`.

The service step is a `restart`, not a `start`, and that is load-bearing:
`systemctl start` on an already-active unit is a no-op, so a re-install over a
running service (`install.sh --force`) used to leave the **old** process
serving while the new payload and unit sat on disk unused. The run then failed
its own health gate with `/health reports version 0.8.0, expected 0.9.0` — the
gate was right, the install had simply not taken effect. `restart` brings the
replaced unit up whether or not it was already running, so the same verb is
correct for a first install and a re-install.

The secret is written to `/opt/synaptomind/.env`; read it with
`sudo grep SYNAPTOMIND_SECRET /opt/synaptomind/.env`. See [CONFIG.md](CONFIG.md)
for the full configuration reference.

---

## Channels

`CHECKOUT_POLICY` in `deploy/app.env` selects what install and a direct
`update.sh` run resolve. The frozen `updater.sh` (below) always resolves stable
releases and ignores `CHECKOUT_POLICY`.

| Value | Resolves |
|-------|----------|
| `stable` (default) | Newest tag without `-` |
| `latest` | Newest tag of any kind |
| `prerelease` | Newest `-alpha.` / `-beta.` / `-rc.` tag |
| `<branch>` | **Rejected in binary mode** — a branch has no release asset |

---

## Updating

The installer drops a bootstrap `updater.sh` next to the other helpers. It is
the primary update entry point — run it as the user that owns the install; it
needs no root itself.

```bash
bash ${HOME}/.synaptomind/scripts/updater.sh                    # interactive: pick from stable releases
bash ${HOME}/.synaptomind/scripts/updater.sh --yes              # non-interactive: newest stable
bash ${HOME}/.synaptomind/scripts/updater.sh --version v0.9.0   # pin a stable tag
bash ${HOME}/.synaptomind/scripts/updater.sh --help
```

| Flag | Effect |
|------|--------|
| `--version TAG` | Update to a specific stable tag (skips the menu) |
| `--yes`, `-y` | Non-interactive: pick the newest stable and forward `--yes` |
| `--help`, `-h` | Show usage |

`updater.sh` (installed as `${RUN_DIR}/scripts/updater.sh`, i.e.
`${HOME}/.synaptomind/scripts/updater.sh` by default) is **stable-only**: it
always resolves the newest tag without a `-` (prereleases and branches are
ignored). It is a *frozen bootstrap* — on every run it shallow-clones the
chosen release into a temporary directory and executes **that release's own
`deploy/update.sh`** (together with its `lib/common.sh` and a copy of your
installed `app.env`), so fixes to the update process ship with ordinary releases
instead of requiring a reinstall, and your port/`RUN_DIR` configuration is left
untouched.

### Exit codes

- `0` on success (including "already up to date" and an aborted menu).
- `1` for a bootstrap pre-flight failure: no stable tags, an unknown or
  non-stable `--version`, or a release whose `update.sh` does not accept the
  frozen `--version`/`--yes`/`--help` flags.
- Otherwise the exit code of the release's `update.sh` is propagated verbatim.

### Runtime model

The updater itself calls no `sudo` and writes nothing to the install directory.
It runs as the service/installing user; the only privileged step is the systemd
service restart, which the release's `update.sh` performs via `sudo` when it is
not already root.

> **Note:** the frozen updater takes effect only from the first **stable**
> release that ships the `deploy/` directory (the framework was adopted after
> `v0.7.3`; expected from `v0.8.0`). Older stable tags such as `v0.7.3` contain
> no `deploy/`, so the updater aborts with an explicit message rather than
> falling back to a branch or prerelease.

### Data retention

There is no automatic age-based deletion of thoughts. Retention review is an
operator-driven workflow: inspect candidates with `retention_review action=list`,
then explicitly protect, delete (preview, then `confirm: true`), or compact them.
Configure candidate age, importance threshold, and page size with
`retentionReview.*` settings; see [CONFIG.md](CONFIG.md#retention-review) and
[docs/mcp-tools.md](mcp-tools.md#retention_review--retention-candidates)
(the HTTP routes that used to expose this went with the 0.20 ops-plane shrink —
[API.md](API.md)).
The database migration installs indexes used by candidate lookup.

### Multi-user deployments

`config.json` may list `users[]`: one SQLite database and one bearer token per
user, all served by the single process. Upgrading changes nothing while the list
is empty; switching an existing install, adding users and rotating tokens are in
[CONFIG.md](CONFIG.md#users-multi-user).

Operationally:

- `/health` probes every configured database and returns HTTP 503 `degraded`
  when any is unavailable. The update gate accepts an expected-version 503 as a
  warning (see [Upgrade safety](#upgrade-safety)); containers report unhealthy.
- The pre-update backup covers each `users[].dbPath` and prints one snapshot per
  database; [Rollback](#rollback) restores each database separately.
- `mcp.maxSessions` is a per-user cap on legacy (2025-era) sessions; the
  2026-07-28 era keeps none, its listen streams are bounded by
  `mcp.maxSubscriptions`.
- MCP stdio stays single-user: it opens `db.path` only and refuses to start when
  that path aliases a user database.

### Advanced: direct `update.sh`

The installed `update.sh` stays available and is required on hosts that track a
prerelease (the updater is stable-only; a branch is rejected in binary mode —
see Channels):

```bash
bash ${HOME}/.synaptomind/scripts/update.sh                  # target from CHECKOUT_POLICY
bash ${HOME}/.synaptomind/scripts/update.sh --version v0.9.0
bash ${HOME}/.synaptomind/scripts/update.sh --yes            # non-interactive (required for downgrades)
```

### Upgrade safety

`update.sh` is upgrade-safe and never reverts automatically:

1. Backs up every database the service will open with a WAL-safe
   `sqlite3 .backup` into `<db>.backup/`, and aborts before the payload is
   downloaded or swapped when a database it found cannot be copied or verified.
   The step is built into `update.sh` and `lib/common.sh`, not delegated to the
   hook — see [Pre-update backup](#pre-update-backup).
2. Runs the installed `pre-update` hook. Its failure is fatal too, but it is an
   extension point: the shipped hook skips its own copy when step 1 already ran.
3. Downloads the release tarball, extracts it, verifies the payload, copies
   `.prev` rollback points, and swaps the new payload into `/opt/synaptomind`.
4. Refreshes the systemd unit (full re-render in binary mode) and restarts it.
5. Polls `/health` until it reports the target version; on timeout or version
   mismatch it exits non-zero and prints recovery instructions (the `.prev`
   rollback points + the DB restore command) without reverting. If no systemd
   service is running, health verification is skipped with a notice.

The health URL resolves from `config.json` `server.port` / `PORT` (default
`http://127.0.0.1:3105/health`); override it with `HEALTH_URL` in
`deploy/app.env`.

If a configured database is unavailable, `/health` returns HTTP 503. The deploy
gate accepts this as **running but degraded**, not healthy, only when the body
passes strict JSON and health-contract validation, its version matches the
expected version, and the embedder has not failed. It warns the operator to
investigate the database. This 503 path requires `curl` and `python3` and a known
expected version; without them it fails closed as an unverified timeout. Wrong
versions, malformed responses, and embedder failure do not pass. A timeout can
also mean the service did not respond; inspect the endpoint and logs before
taking recovery action. No recovery is automatic.

The Dockerfile and Compose health checks also use `curl -f`: HTTP 503 counts as
a failed probe, so partial or total database unavailability eventually makes the
container unhealthy after the configured retries. Docker health status does not
itself restart the container; investigate the unavailable database rather than
assuming the health check repaired it.

### Pre-update backup

The backup is taken by the code every update fetches, not by the installed
hook. `deploy/update.sh:954` calls `backup_databases`
(`deploy/lib/common.sh:2637`) before the pre-update hook and before the release
payload is downloaded or swapped; a failure aborts the run, so no code moves
without a copy. On the default path that is the **target release's** own copy of
both files: the frozen bootstrap stages `update.sh`, `lib/common.sh` and your
`app.env` from the tag it is installing (`deploy/updater.sh:116-118`).

**What is covered.** Every database the service actually opens: `db.path`, each
`users[].dbPath`, `SYNAPTOMIND_DB_PATH`, any `SYNAPTOMIND_CONFIG` /
`SYNAPTOMIND_DB_PATH` declared in the payload `.env` files (read in addition to
the service environment), plus a bounded discovery pass (`-maxdepth 2`, SQLite
magic number) over `DATA_DIR` (`/var/lib/synaptomind` by default, falling back
to `${INSTALL_DIR}/data` when the key is empty), the unit's working directory's
`data/`, and the parent directories of the resolved paths.
Candidates are deduplicated by canonical path and inode, so a symlink and its
target are one database. The configuration is read from the running service
where possible (`/proc/<pid>/environ`, `/proc/<pid>/cwd`), then from the unit,
then from the installed `app.env`.

**Snapshots.** `sqlite3 -cmd ".timeout 10000" <db> ".backup '<out>'"`, written
next to the real file as
`<db>.backup/<basename>.<YYYYMMDD-HHMMSS>-<pid>-<n>.bak`, where `<n>` is a
per-run counter over the candidate paths — e.g.
`/var/lib/synaptomind/synaptomind.db.backup/synaptomind.db.20261103-111142-417429-1.bak`
for the default database (`/opt/synaptomind/data` is a symlink, and a symlinked
database is resolved first). The `.backup` API includes WAL content. Each copy
is then verified: `PRAGMA quick_check` must answer `ok`, and the copy's
`PRAGMA user_version` must equal the source's.

**Skip and abort rules.** A path that does not exist, is not a regular file, or
does not begin with `SQLite format 3` is skipped with an `info` line naming it —
a fresh install has nothing to copy, and a 0-byte or foreign file at a
configured path is reported rather than copied. Everything that would leave a
database uncopied fails closed and aborts before the swap: `sqlite3` missing
while at least one database exists, a backup directory that cannot be created, a
backup destination that already exists, a failed `.backup`, a failed
`quick_check` or `user_version` check (the partial file is removed), and a run
where the service is active and a config file was resolved but no database could
be enumerated at all.

**Retention.** After a successful backup the same step prunes, per database and
oldest first, everything beyond the newest `BACKUP_KEEP` copies — default `5`,
set it in `deploy/app.env` or the environment. `BACKUP_KEEP=0` disables pruning
(a non-numeric value also disables it, silently). The pattern is
`<basename>.[0-9]{8}-[0-9]{6}*.bak`, which also matches the older hook-written
`<basename>.<timestamp>.bak`: on a host that has been updated before, the first
run of this code counts every historical pre-update backup of a database and
deletes all but the newest `BACKUP_KEEP` of them, without a prompt. Copy
anything older you mean to keep before that first update.

**The hook is an extension point.** `update.sh` still runs
`${HOOKS_DIR}/pre-update` after the built-in backup and still treats a non-zero
exit as fatal, but the guarantee does not depend on it: `update.sh` never
installs or refreshes hooks (`install_hook_scripts()` is called only from
`deploy/install.sh:856`), so an existing host keeps whatever hook it installed —
possibly a release-old copy with its own `grep`-based resolver. The shipped hook
exits 0 with `pre-update: built-in backup already performed` when
`APP_BACKUP_ALREADY_DONE=1` (`deploy/hooks/pre-update:118`), which
`backup_databases` and `deploy/update.sh:957` export before the hook runs. A
custom hook that backs up on its own should honour that variable as well;
otherwise it adds a second set of copies, subject to the same retention.
Re-running `install.sh` is what refreshes the installed hook.

**Dry run.** `update.sh --check-backup` prints what the backup step would
protect — no backup taken, nothing downloaded or swapped, no unit touched —
and exits non-zero when resolution would have refused. Typical output on a
running host with the default single database:

```text
CONTEXT_SOURCE=observed
ENV_SOURCE=observed
RESOLVER_AGREEMENT=bash-only
EFFECTIVE_CONFIG_PATH=/opt/synaptomind/config.json
DATABASES:
/var/lib/synaptomind/synaptomind.db
```

`CONTEXT_SOURCE` and `ENV_SOURCE` name the layer that answered (`observed` = the
running process, `derived` = `systemctl show` or the unit file, `assumed` =
`app.env` only), `RESOLVER_AGREEMENT` is always `bash-only` because nothing
inside the application is probed, and the `DATABASES:` lines are absolute paths
with an existing parent directory canonicalised, so
`/opt/synaptomind/data/…` prints as `/var/lib/synaptomind/…`. The flag is
handled before the version guards, so it works on a host that is already
current. `updater.sh` rejects unknown flags, so run it on an `update.sh`
directly:

```bash
bash ${HOME}/.synaptomind/scripts/update.sh --check-backup
```

The installed `update.sh` in `${HOME}/.synaptomind/scripts/` learns the flag only
when a re-install refreshes it; until then run the same command from a checkout
of the release you intend to deploy — `bash deploy/update.sh --check-backup`,
where the checkout's `app.env` supplies `INSTALL_DIR`/`DATA_DIR` just as the
installed copy does.

### Rollback

Schema migrations are **forward-only** (`src/db/init.ts:166`): the server applies
every migration it has not seen and never reverses one. Running an older binary
against a database that a newer version has already migrated is therefore
**unsafe**. The pre-update backup ([above](#pre-update-backup)) has already
copied every database, so the supported rollback restores those copies and the
`.prev` payload files:

```bash
sudo systemctl stop synaptomind
# Restore EVERY database the backup step copied. It prints one
# "Database backed up: ..." line per database (the main db.path plus each
# users[].dbPath); run the printed cp/rm pair for each of them. Example for
# the default single database:
sudo cp -p /opt/synaptomind/data/synaptomind.db.backup/synaptomind.db.<timestamp>.bak \
          /opt/synaptomind/data/synaptomind.db
sudo rm -f /opt/synaptomind/data/synaptomind.db-wal /opt/synaptomind/data/synaptomind.db-shm
# Repeat the two lines above for each per-user database, using the path the
# backup step printed for it (e.g. .../alice.db.backup/alice.db.<timestamp>.bak
# -> alice.db).
# Restore the previous payload from .prev
sudo mv -f /opt/synaptomind/vec0.so.prev /opt/synaptomind/vec0.so
sudo mv -f /opt/synaptomind/lib/libonnxruntime.so.1.prev /opt/synaptomind/lib/libonnxruntime.so.1
sudo mv -f /opt/synaptomind/synaptomind.prev /opt/synaptomind/synaptomind
sudo systemctl start synaptomind
```

The backup step prints the exact path (`Database backed up: …`), and
`update.sh` repeats the per-database `cp`/`rm` pair and the `.prev` restore
commands in its recovery block — for the copies it made itself and for any an
operator hook reported.

`/opt/synaptomind/data` is a symlink to `/var/lib/synaptomind`, so the real
database file is `/var/lib/synaptomind/synaptomind.db` — there is no `data/`
under `/var/lib/synaptomind`.

**v048: project-scoped vector index.** The first boot after updating to a
release that carries v048 copies the whole vector corpus once. A staging copy of
the embeddings and the rebuilt `vec_thoughts` table coexist inside one migration
transaction — ≈1.5 KB per row at 384 dimensions, so ~150 MB at 100k rows and
~1.5 GB at 1M, transiently doubled in the WAL. The migration refuses to start
when the data filesystem has less than 2 × that staged size free and fails the
boot with an actionable message (free space and restart) instead of dying
mid-transaction, so check `df` on the data filesystem before a large upgrade.
Its rollback is the generic one above — restore the pre-update backup and the
previous payload: v048 is forward-only and the schema-version guard refuses a
v48 database from an older binary.

### Logging

Application logs now route to stdout/stderr (info/debug to stdout, warning/error
to stderr) and, when configured, an optional size-rotated file via
`log.file`/`SYNAPTOMIND_LOG_FILE` (with `log.fileMaxBytes`/`SYNAPTOMIND_LOG_FILE_MAX_BYTES`
and `log.fileMaxFiles`/`SYNAPTOMIND_LOG_FILE_MAX_FILES`).

---

## Troubleshooting

### ERR_DLOPEN_FAILED / libonnxruntime.so.1

The compiled binary dlopens an embedded addon (`libonnxruntime.so.1`) whose
RUNPATH resolves inside `/$bunfs`. The systemd unit sets
`Environment=LD_LIBRARY_PATH=/opt/synaptomind/lib` so the loader finds it. If the
unit is hand-edited or the `lib/` directory is missing, the embedder child dies
on `ERR_DLOPEN_FAILED` in a loop. Verify:

```bash
ls -l /opt/synaptomind/lib/libonnxruntime.so.1
systemctl cat synaptomind.service | grep LD_LIBRARY_PATH
```

If the file is missing, re-run the installer (`sudo bash deploy/install.sh
--force`) to restore the payload. If the unit lacks the `LD_LIBRARY_PATH`
line, re-render it by re-running `install.sh` or `update.sh`.

### Health check fails after update

If `/health` does not report the expected version after an update, the unit
may not have been refreshed. Check:

```bash
systemctl cat synaptomind.service   # should match a fresh render
curl http://127.0.0.1:3105/health   # should report the target version
```

Re-run `bash ${HOME}/.synaptomind/scripts/update.sh --yes` to re-refresh and
restart.

### Update aborts with `pre-update backup failed`

`[synaptomind] ERROR: pre-update backup failed — aborting before switching
code` means the backup step refused to continue: the payload was not downloaded,
nothing was swapped, and the service is still running the code it ran a minute
ago. Find out what the step resolved and from where:

```bash
bash ${HOME}/.synaptomind/scripts/update.sh --check-backup
```

The usual causes are a missing `sqlite3` while a database exists, a `.backup`
directory the update user cannot write, a config file that cannot be read or
parsed, and a host where the service is active but no database could be
enumerated — the step refuses rather than backing up nothing. Also check the
filesystem: retention keeps up to `BACKUP_KEEP` copies of every database, so the
`<db>.backup/` directories are part of the disk budget. Fix the cause and re-run;
a copy that fails verification is deleted, so nothing partial stays behind.

---

## Uninstall

```bash
bash ${HOME}/.synaptomind/scripts/uninstall.sh            # keeps code + data
bash ${HOME}/.synaptomind/scripts/uninstall.sh --purge    # also removes them
```

Stops and disables the systemd unit (`/etc/systemd/system/synaptomind.service`),
removes it, and removes the helper scripts (`${HOME}/.synaptomind/scripts`). By
default it keeps the install directory (`/opt/synaptomind`) and data
(`/var/lib/synaptomind`); pass `--purge` to remove them as well. Use `--yes` in
non-interactive shells.

---

## Docker alternative

See [DOCKER.md](DOCKER.md). The `deploy/` framework is the supported install
path; Docker is provided as a convenience.
