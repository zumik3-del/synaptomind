# Server Installation & Updates

Install SynaptoMind as a systemd service from source using the `deploy/`
framework, and update it in place. This is the supported install path; for
containers see [DOCKER.md](DOCKER.md), and for an overview of the project see
the [README](../README.md).

---

## Quick Start

```bash
curl -fsSL https://raw.githubusercontent.com/zumik3-del/synaptomind/main/deploy/install.sh \
  | APP_ENV_URL=https://raw.githubusercontent.com/zumik3-del/synaptomind/main/deploy/app.env \
    LIB_RAW_URL=https://raw.githubusercontent.com/zumik3-del/synaptomind/main/deploy/lib/common.sh \
    bash
```

`APP_ENV_URL` supplies the config and `LIB_RAW_URL` the shared helpers, since a
piped script has no sibling files. Server starts on `http://127.0.0.1:3005`.
MCP endpoint: `http://127.0.0.1:3006/mcp`.

---

## Installation

### One-line install

```bash
curl -fsSL https://raw.githubusercontent.com/zumik3-del/synaptomind/main/deploy/install.sh \
  | APP_ENV_URL=https://raw.githubusercontent.com/zumik3-del/synaptomind/main/deploy/app.env \
    LIB_RAW_URL=https://raw.githubusercontent.com/zumik3-del/synaptomind/main/deploy/lib/common.sh \
    bash
```

`APP_ENV_URL` points at `deploy/app.env` and `LIB_RAW_URL` at the shared helpers
(`deploy/lib/common.sh`) — both are required for the piped form, where the
script has no sibling files.

### From a checkout

From a local checkout, run the installer directly instead:

```bash
git clone https://github.com/zumik3-del/synaptomind.git && cd synaptomind
sudo bash deploy/install.sh
```

### Install flags

Options (append after `--` in the piped form, e.g. `bash -s -- --port 3005`):

| Flag | Effect |
|------|--------|
| `--dir DIR` | Install directory (default `INSTALL_DIR` in `deploy/app.env`) |
| `--port PORT` | Port written to the seeded `config.json` and used by the health check |
| `--version TAG` | Pin a version instead of resolving the latest |
| `--force` | Reinstall even when the same version is already present |
| `--no-service` | Skip systemd unit installation and start |
| `--help`, `-h` | Show usage |

### What the installer does

The installer installs Bun when missing, clones `REPO_URL` to
`/opt/synaptomind`, checks out the resolved channel, installs dependencies,
seeds `config.json` + `.env` (generating `SYNAPTOMIND_SECRET`), links
`/opt/synaptomind/data` → `/var/lib/synaptomind`, installs the helper scripts
into `${HOME}/.synaptomind/scripts` and the update hooks into
`${HOME}/.synaptomind/hooks`, then installs and starts the systemd unit and
polls `/health`.

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
| `<branch>` | That branch (the default branch when no tag exists) |

---

## Updating

The installer drops a bootstrap `updater.sh` next to the other helpers. It is
the primary update entry point — run it as the user that owns the install; it
needs no root itself.

```bash
bash ${HOME}/.synaptomind/scripts/updater.sh                    # interactive: pick from stable releases
bash ${HOME}/.synaptomind/scripts/updater.sh --yes              # non-interactive: newest stable
bash ${HOME}/.synaptomind/scripts/updater.sh --version v0.8.0   # pin a stable tag
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
prerelease or a branch (the updater is stable-only):

```bash
bash ${HOME}/.synaptomind/scripts/update.sh                  # target from CHECKOUT_POLICY
bash ${HOME}/.synaptomind/scripts/update.sh --version v0.6.1
bash ${HOME}/.synaptomind/scripts/update.sh --yes            # non-interactive (required for downgrades)
```

### Upgrade safety

`update.sh` is upgrade-safe and never reverts automatically:

1. Runs the pre-update hook — a WAL-safe `sqlite3 .backup` of every configured
   database to `<db>.backup/<name>.<timestamp>.bak` (skipped when no database
   exists; aborts before switching code if an existing database cannot be backed
   up).
2. Checks out the target version, reinstalls production dependencies, and
   restarts the systemd service if it is running.
3. Polls `/health` until it reports the target version; on timeout or version
   mismatch it exits non-zero and prints recovery instructions (previous
   revision + rollback command) without reverting. If no systemd service is
   running, health verification is skipped with a notice.

The health URL resolves from `config.json` `server.port` / `PORT` (default
`http://127.0.0.1:3005/health`); override it with `HEALTH_URL` in
`deploy/app.env`.

### Rollback

Schema migrations are **forward-only** (`src/db/init.ts:127`): the server applies
every migration it has not seen and never reverses one. Checking out an older
tag against a database that a newer version has already migrated is therefore
**unsafe**. The pre-update hook has already copied the database, so the
supported rollback restores that backup and returns to the previous revision
that `update.sh` printed:

```bash
sudo systemctl stop synaptomind
sudo cp /opt/synaptomind/data/synaptomind.db.backup/synaptomind.db.<timestamp>.bak \
        /opt/synaptomind/data/synaptomind.db
sudo rm -f /opt/synaptomind/data/synaptomind.db-wal /opt/synaptomind/data/synaptomind.db-shm
cd /opt/synaptomind
git checkout --force <previous-revision>   # hash printed by update.sh
bun install --frozen-lockfile --production
sudo systemctl start synaptomind
```

The hook prints the exact backup path (`Database backed up: …`), and
`update.sh` repeats the previous revision in its recovery block.

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
