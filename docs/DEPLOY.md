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

1. Runs the pre-update hook — a WAL-safe `sqlite3 .backup` of every configured
   database to `<db>.backup/<name>.<timestamp>.bak` (skipped when no database
   exists; aborts before switching code if an existing database cannot be backed
   up).
2. Downloads the release tarball, extracts it, verifies the payload, copies
   `.prev` rollback points, and swaps the new payload into `/opt/synaptomind`.
3. Refreshes the systemd unit (full re-render in binary mode) and restarts it.
4. Polls `/health` until it reports the target version; on timeout or version
   mismatch it exits non-zero and prints recovery instructions (the `.prev`
   rollback points + the DB restore command) without reverting. If no systemd
   service is running, health verification is skipped with a notice.

The health URL resolves from `config.json` `server.port` / `PORT` (default
`http://127.0.0.1:3105/health`); override it with `HEALTH_URL` in
`deploy/app.env`.

### Rollback

Schema migrations are **forward-only** (`src/db/init.ts:127`): the server applies
every migration it has not seen and never reverses one. Running an older binary
against a database that a newer version has already migrated is therefore
**unsafe**. The pre-update hook has already copied the database, so the
supported rollback restores that backup and restores the `.prev` payload files:

```bash
sudo systemctl stop synaptomind
# Restore the database backup (path printed by the pre-update hook)
sudo cp -p /opt/synaptomind/data/synaptomind.db.backup/synaptomind.db.<timestamp>.bak \
          /opt/synaptomind/data/synaptomind.db
sudo rm -f /opt/synaptomind/data/synaptomind.db-wal /opt/synaptomind/data/synaptomind.db-shm
# Restore the previous payload from .prev
sudo mv -f /opt/synaptomind/vec0.so.prev /opt/synaptomind/vec0.so
sudo mv -f /opt/synaptomind/lib/libonnxruntime.so.1.prev /opt/synaptomind/lib/libonnxruntime.so.1
sudo mv -f /opt/synaptomind/synaptomind.prev /opt/synaptomind/synaptomind
sudo systemctl start synaptomind
```

The hook prints the exact backup path (`Database backed up: …`), and
`update.sh` repeats the `.prev` restore loop and the DB restore commands in its
recovery block.

`/opt/synaptomind/data` is a symlink to `/var/lib/synaptomind`, so the real
database file is `/var/lib/synaptomind/synaptomind.db` — there is no `data/`
under `/var/lib/synaptomind`.

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
