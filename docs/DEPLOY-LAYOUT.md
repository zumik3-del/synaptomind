# Three-App Deployment Layout

One deployment convention for the three systemd-hosted apps on this host —
**synaptomind**, **ziptask**, **subagentix** — so that "where does this file
live?", "what does the unit do?" and "what is the rollback point?" have one
answer per class of file, and the answer does not depend on which app you are
asking about.

This file is the **cross-app reference**: layout, unit policy, the two
distribution modes, and the per-app `app.env` keys. It is not the install
procedure. For synaptomind that is [DEPLOY.md](DEPLOY.md); for the other two
it is the `Install` section of their own README. Where the two overlap, the
procedure wins and this file is the map.

**Where the truth lives.** `deploy/` is authored, tested and vendored from this
repository (`deploy/lib/common.sh` is byte-identical in all three repos —
sha256 `119edd86…`); ziptask and subagentix each carry a `deploy/` copy plus
their own `deploy/app.env`. This document therefore lives here, in the
framework's home repo, and the other two repos point at it. Design history is
in the ai-workdir, not here:
`/mnt/external/zum/ai-workdir/synaptomind/plans/2026-10-01-unify-deploy-framework-adr.md`
(§1 layout, §2 unit truth, §3 framework gaps, §4–§5 the two cutovers, §6
versioning, §8 variant C) and its addendum
`…-unify-deploy-framework-adr-addendum-config-home.md` (rules R1–R4 below).

---

## At a glance

| | synaptomind | ziptask | subagentix |
|---|---|---|---|
| `DIST` | `binary` | `binary` | **`source`** (documented exception, §7) |
| Code | `/opt/synaptomind` | `/opt/ziptask` | `/opt/subagentix` (git checkout) |
| Data | `/var/lib/synaptomind` | `/var/lib/ziptask` | `/var/lib/subagentix` |
| `data` symlink | `/opt/synaptomind/data` | `/opt/ziptask/data` | `/opt/subagentix/data` |
| App config (R1) | `/var/lib/synaptomind/config.json` (reached via `config.json` symlink) | `/var/lib/ziptask/settings.json` | `/var/lib/subagentix/settings.json` (via `STATE_DIRECTORY`) |
| Operator env (R2) | `/opt/synaptomind/.env` (see §9) | — none | `/etc/subagentix/subagentix.env` |
| Deploy state | `~/.synaptomind` | `~/.ziptask` | `~/.subagentix` |
| Unit | `synaptomind.service` | `ziptask.service` | `subagentix.service` |
| Runs as | `opencode:opencode` | `opencode:opencode` | `opencode:opencode` |
| Port / health | `3105`, `GET /health` | `3005`, `GET /health` | `3010`, `GET /api/health` |
| Health body | `{"status":"ok","version":…}` | `{"ok":true}` | `{"ok":true,…}` |
| Update = | file swap + `.prev` | file swap + `.prev` | **build** + git ref |
| Rollback point | `<file>.prev` per file | `<file>.prev` | previous git commit (`PREV_REF`) |

---

## 1. Canonical layout

Three locations per app, and one rule for which is which.

| Concern | Key | Value | Where it is made |
|---|---|---|---|
| Code / payload | `INSTALL_DIR` | `/opt/<app>` | default `install.sh:768`; `app.env` names it explicitly in all three |
| Data | `DATA_DIR` | `/var/lib/<app>`, exposed as `INSTALL_DIR/data` symlink | `setup_data()` `install.sh:459-466` |
| Deploy state | `RUN_DIR` (empty ⇒ `${HOME}/.<app>`) | `~/.<app>` | `common.sh:188` |
| Helpers | — | `~/.<app>/scripts/{app.env,common.sh,update.sh,updater.sh,uninstall.sh}` | `install_helper_scripts()` `install.sh:546-571` — `app.env` mode 600, the rest `+x` |
| Hooks | `HOOKS_DIR` (empty ⇒ `${RUN_DIR}/hooks`) | `~/.<app>/hooks/{pre-update,post-update}` | `install_hook_scripts()` `install.sh:579-601`, default `install.sh:782` |
| Unit | — | `/etc/systemd/system/<app>.service` | `install.sh:622`, re-rendered by `update.sh:513-538` |
| Owner | `SERVICE_USER` | `opencode` | `chown -R` over both trees: `apply_ownership()` `common.sh:323-339`; the state dir separately in `apply_run_dir_ownership()` `common.sh:360-373` |

Verified on the live host (2026-10-01): `/opt/<app>` and `/var/lib/<app>` both
`opencode:opencode`; `~/.<app>/scripts` holds the five helpers with `app.env`
mode 600; all three `data` symlinks resolve to their `DATA_DIR`; the three
`install_helper_scripts`/hook phases are the only writers of `~/.<app>`.

### The config-home rules (R1–R4)

The three apps hold two different classes of file, which is why the layout has
a fourth rule beyond code/data/state. From the ADR addendum:

- **R1 — app config home = `DATA_DIR`.** The app's own settings file lives in
  `/var/lib/<app>/`, beside its database. It is the only config location
  writable at runtime (`ProtectSystem=strict`), and it is inside the backup
  boundary the pre-update hooks search. Seeded with `SEED_FILES_DATA`
  (`install.sh:382`); the location is declared per app in `CONFIG_FILE`, which
  is documentation and assertion material only — no framework code reads it
  (verified: `grep -rn CONFIG_FILE deploy/` matches `app.env` alone).
- **R2 — operator/secret env = `/etc/<app>/<app>.env`**, root-owned `0640
  root:opencode`, loaded by the unit's `EnvironmentFile=` **before** `exec`.
  subagentix is the only app that uses it today (§9).
- **R3 — `INSTALL_DIR/data -> DATA_DIR` is mandatory** for all three. The
  shipped defaults are relative (`./data/…`) and resolve against
  `WorkingDirectory=/opt/<app>`, so without the symlink the writes land inside
  a read-only `/opt`.
- **R4 — `SERVICE_USER="opencode"` explicitly in every `app.env`**, and the
  unit carries both `User=` and `Group=`. An empty `SERVICE_USER` makes
  `resolve_target_user()` (`common.sh:161-189`) fall through to `SUDO_USER`
  and then `id -un`, so the same installer run renders `User=root` when invoked
  as root without `SUDO_USER` and the service silently runs as root.

The **home** is uniform; the **filename** is not, deliberately:
`config.json` for synaptomind, `settings.json` for ziptask and subagentix.
Renaming synaptomind's file means changing a hardcoded literal in
`src/config.ts:268-281` and gains nothing operationally.

synaptomind's app resolves its config relative to its working directory
(`loadFileConfig()` → `join(process.cwd(), 'config.json')`,
`src/config.ts:269`) and has no path flag, so R1 is bridged by a symlink:
`CONFIG_LINK_NAME="config.json"` (`app.env:56`) makes `setup_config_link()`
(`install.sh:495-536`) create `/opt/synaptomind/config.json ->
/var/lib/synaptomind/config.json` after seeding. It never replaces a real file
there — it warns and leaves the operator's file alone (`install.sh:521-526`).

---

## 2. The unit policy

`render_systemd_unit()` (`common.sh:1214-1413`) is the **single renderer of
unit text**, called from exactly two places: `install_service()`
(`install.sh:637`) and `refresh_unit()` (`update.sh:535`). No hand-written unit
body survives anywhere in the framework. The rendered text is data, never shell:
it is assembled into an array and emitted with one `printf` (`common.sh:1356-1412`),
and the whole file is asserted by `deploy/systemd-unit.test.ts`.

Verified on the live host: all three units are **byte-identical** to a fresh
render from this repository's `deploy/lib/common.sh` (sha256
`dd734733…` synaptomind, `be9a59ed…` ziptask, `a6ec2323…` subagentix).

### What every unit carries

| Section | Directive | Source | Why it is there |
|---|---|---|---|
| `[Unit]` | `StartLimitIntervalSec=60`, `StartLimitBurst=5` | `common.sh:1361-1362` | **Before** `[Service]`, deliberately: systemd 230+ ignores `StartLimit*` in `[Service]`, so a unit that puts them there has an inert crash-loop bound. With `Restart=always` this is what stops "always" from becoming a respawn storm. |
| `[Unit]` | `After=`/`Wants=network-online.target` | `common.sh:1359-1360` | Bind to a real address, not to a loopback that comes up first. |
| `[Service]` | `User=`, `Group=` | `common.sh:1305,1319` | R4. `Group=` comes from `TARGET_GROUP`, which defaults to the service user (`common.sh:174`). |
| | `WorkingDirectory=INSTALL_DIR` | `common.sh:1306` | Why an app with a cwd-relative config needs R1's symlink. |
| | `Environment=NODE_ENV=production` | `common.sh:1269` | — |
| | `Environment=LD_LIBRARY_PATH=INSTALL_DIR/lib` **(binary mode only)** | `common.sh:1276-1278` | A compiled binary dlopens an embedded addon whose RUNPATH resolves inside `/$bunfs`. Load-bearing for synaptomind (`lib/libonnxruntime.so.1`); for ziptask it points at an empty `lib/` and is inert — do not chase it. |
| | `Environment=HOME=`, `Environment=PATH=` | `common.sh:1279-1280` | The build (`run_as_target_user`) and the service must agree on HOME. |
| | `StateDirectory=` + `StateDirectoryMode=0700`, `EnvironmentFile=`, extra `Environment=` pairs | `common.sh:1328-1344` | Rendered **only when the matching `app.env` key is non-empty**; an app.env that sets none gets the body this template has always produced. |
| | `ExecStart=` | `common.sh:1307` | From `EXEC_START`, or the mode-specific default (`default_exec_start()` `install.sh:132`). |
| | **`Restart=always`**, `RestartSec=5` | `common.sh:1380-1381` | The 2026-09-30 incident: the app registers SIGTERM/SIGINT handlers, so an external signal ends in a graceful shutdown and **exit 0** — which `on-failure` deliberately does not restart, turning a signal into a one-way outage (12 min). `on-abnormal` is not the fix either: a handler that exits 0 is a *clean* exit. Deliberate operator intent still holds: `systemctl stop` sets the unit inactive and systemd does not restart it. |
| | `TimeoutStopSec=15` | `common.sh:1397` | A bounded stop instead of systemd's 90 s default, so `systemctl restart` (what install and update call) is a predictable step. **`KillSignal` is deliberately NOT set**: the default SIGTERM is the first step of the stop and the shutdown path needs it; `SendSIGKILL=yes` (the default) is what bounds the stop once `TimeoutStopSec` expires. An earlier revision set `KillSignal=SIGKILL` and every stop ended `status=9/KILL` with the shutdown path never running — do not re-add it. |
| | `NoNewPrivileges`, `ProtectSystem=strict`, `ReadWritePaths=INSTALL_DIR DATA_DIR`, `PrivateTmp`, `ProtectKernelTunables/Modules/ControlGroups`, `RestrictSUIDSGID` | `common.sh:1399-1407` | `ReadWritePaths` is derived (`common.sh:1217`), not a constant: it is the only writable pair, which is why R1 cannot be `/etc`. |
| `[Install]` | `WantedBy=multi-user.target` | `common.sh:1410` | — |

### The rule that bites: a source-mode unit is rendered ONCE

`refresh_unit()` returns early for `DIST != binary` and delegates to
`ensure_restart_policy()` (`update.sh:520`), which rewrites **only** the
`Restart=` line and preserves every other byte. So for **subagentix**:

- the body written at install time is what persists for the life of the install;
- a later framework change to the template does **not** reach that unit on
  update;
- therefore never hand-edit a framework-rendered unit. A hand edit is preserved
  forever in source mode, and in binary mode the next update silently
  overwrites it. Re-render instead: fix the value in `app.env` and re-run
  `install.sh` (binary and source alike) or `update.sh` (binary only).

Unit writes are atomic (`write_file_atomically()` `common.sh:1493`), and
`install.sh` keeps the replaced unit as `<unit>.bak` (`install.sh:648-650`).
Every value substituted into the unit passes `assert_unit_value()`
(`common.sh:1136-1183`) — including each `UNIT_EXTRA_ENV` pair, checked one
pair at a time so a TAB or newline is **refused** rather than shredded by word
splitting.

---

## 3. The two DIST modes

`DIST` selects the payload; everything else in the framework is shared.

### `DIST=binary` — synaptomind, ziptask

No bun, no `node_modules`, no checkout in `INSTALL_DIR`; the host needs `git`
(only for the `updater.sh` bootstrap) and `tar`.

1. `require_binary_platform()` (`common.sh:1682`) — refuse a host with no asset.
2. `binary_stage_payload()` (`common.sh:1698`) — download
   `${RELEASES_BASE}/${TAG}/${ASSET_PATTERN}`, extract, and require **exactly
   one top-level directory**. A bare executable is refused; the release must
   ship a `.tar.gz`.
3. Verify `BINARY_REQUIRED_FILES` **before anything is touched** (`common.sh:1667`).
4. `binary_keep_previous()` (`common.sh:1784`) — copy each
   `BINARY_ROLLBACK_FILES` entry to `<file>.prev`, skipped when the bytes are
   identical (so a `.prev` is never a false rollback point).
5. `binary_swap_payload()` (`common.sh:1809`) — move files in
   `BINARY_SWAP_ORDER`, **the executable last**, so an interrupted swap leaves
   old-executable + new-data, which is detectable as "old version" rather than
   "new binary, old library" (`common.sh:1673-1679`).
6. Refresh the unit (full re-render) and restart; a refresh that did not happen
   is fatal, because a stale unit would start the new binary with a broken
   loader while `/health` still answers `ok` (`update.sh:493-512`).

The four payload lists are per-app, defaulted in `common.sh:1663-1679` and
overridden in `app.env` — synaptomind uses the defaults, ziptask names its own
single-file payload (`deploy/app.env:66-69`).

### `DIST=source` — subagentix

`INSTALL_DIR` **is** the git checkout. `source_prepare()` (`install.sh:207`)
clones it; `update_source()` (`update.sh:675-716`) fetches tags, checks out the
target ref, records `PREV_REF`, applies ownership **before** the build, then
runs the same `install_deps_and_build()` pair the installer runs.

- `INSTALL_FLAGS` (`common.sh:1587`) is the `bun install` flag list. The
  default is `--frozen-lockfile --production`; **drop `--production` when a
  `BUILD_CMD` is set**, because a build needs its devDependencies and
  `--production` prunes exactly those.
- `BUILD_CMD` (`common.sh:1588`) runs in `INSTALL_DIR`, as the service user,
  under `timeout ${BUILD_TIMEOUT}` (default 600 s, `common.sh:1589`). A
  non-zero exit **aborts** the install or update: a failed build leaves a
  payload with no artefact, and the health gate would report a plain timeout
  naming neither the build nor its error.
- Rollback is `git checkout --force ${PREV_REF}` plus the same
  `INSTALL_FLAGS` + `BUILD_CMD` — and `update.sh` prints exactly that pair
  rather than a hardcoded `bun install --frozen-lockfile --production`
  (`update.sh:301-304`).

### Shared by both modes

pre-update hook → fetch → swap → refresh unit → restart → health gate →
post-update hook; `apply_ownership`; the health contract; and the same
`install_helper_scripts` / `install_hook_scripts` / `uninstall.sh` surface in
`~/.<app>/scripts`.

### Which `app.env` an entry point reads

`load_app_env()` (`common.sh:1850-1882`) sources the `app.env` **next to the
running script**, so the three entry points read three different copies:

| Entry point | `app.env` read |
|---|---|
| `sudo bash deploy/install.sh` from a checkout | the **repo** `deploy/app.env` |
| `bash ~/.<app>/scripts/update.sh` | the **installed** `~/.<app>/scripts/app.env` |
| `bash ~/.<app>/scripts/updater.sh` | the installed one, **copied** next to the staged release's `update.sh` (`updater.sh:118`) — so the release's own `update.sh` + `common.sh` run with *your* values |

An install therefore never sees the operator's runtime edits to the installed
copy, and an update never sees repo changes. Copy a changed value into the
installed `app.env` (it is the file the updater ships forward) or re-run
`install.sh`.

---

## 4. The shared `deploy/` framework

One implementation, three vendored copies, one `app.env` per app.

- **Home:** this repo. `deploy/lib/common.sh` is byte-identical in all three
  repos (sha256 `119edd861d9cb742481ac588e8f0fd81aa421992da2ee0f31906025d59e7fc8c`),
  as is the upstream provenance it records: `bun-templates`
  `89be318daf8adab5ddca957162b3b7df8429e725`.
- **Local deviations**, each recorded in the vendored file's own provenance
  header and each deliberate:

  | File | ziptask | subagentix |
  |---|---|---|
  | `install.sh` | one-liner URL + `DEPLOY_RAW_URL` default → its own repo | same, plus the provenance block |
  | `update.sh` | one glob in `print_db_restore()` → `${DATA_DIR}` | DB-restore paragraphs gated on "there is a database" / `DIST=binary` (subagentix has neither) |
  | `updater.sh` | staging dir `${APP_NAME}-updater` | same |
  | `uninstall.sh`, `hooks/post-update` | byte-identical | comment-only / gated no-op |
  | `hooks/pre-update` | resolves `settings.json`'s `dbPath`, searching `DATA_DIR` **first** (`hooks/pre-update:64`) | honest no-op, with the three reasons printed on every run |

  The `DEPLOY_RAW_URL` change is the one that is a bug rather than cosmetics if
  left alone: a piped run with a foreign base fetches *that* app's `app.env` and
  installs it under this app's name.
- **Re-vendoring** is a copy of `deploy/` plus re-applying those app-local
  diffs, then re-installing the helpers on the host
  (`~/.<app>/scripts`, `~/.<app>/hooks`). The framework is never fetched from a
  shared host at install time, so a production install does not depend on a
  self-hosted Forgejo being reachable.
- **Conformance travels the other way.** The framework's suite lives only here
  (12 `deploy/*.test.ts` files); it is pointed at the other repos' real
  `app.env` files with
  `DEPLOY_APP_ENVS='subagentix=/path/to/subagentix/deploy,ziptask=/path/to/ziptask/deploy'`
  (`deploy/app-targets.ts`). A named target that does not resolve **fails** the
  run — a typo cannot come back green. Unset (CI's default) means no target and
  no change in the suite's own result. When you change one app's `app.env`, run
  it against that repo.

---

## 5. Per-app `app.env`

The shipped `deploy/app.env` of each repo is that app's single source of truth.
The keys below are the ones whose value is not obvious from the name.

### synaptomind — `deploy/app.env`

| Key | Value | Note |
|---|---|---|
| `DIST` | `binary` | Release tarball; no bun at install or runtime. |
| `INSTALL_DIR` / `DATA_DIR` | `/opt/synaptomind` / `/var/lib/synaptomind` | The default paths, named explicitly. |
| `CONFIG_FILE` / `CONFIG_LINK_NAME` | `/var/lib/synaptomind/config.json` / `config.json` | R1 + the symlink that reaches it. `CONFIG_FILE` is documentation only. |
| `SEED_FILES` / `SEED_FILES_DATA` | `.env.example:.env` / `config.json.example:config.json` | The config is seeded into `DATA_DIR`, **not** the payload tree: the tree is swapped on every binary update, so a config seeded there competes with the operator's file for one pathname. |
| `PORT` / `MCP_PORT` / `HEALTH_URL` | `3105` / empty ⇒ `PORT+1` = `3106` / empty ⇒ `http://127.0.0.1:<port>/health` | `MCP_PORT` only affects a *freshly seeded* config; an existing `config.json` is never rewritten. |
| `SERVICE_USER` | `opencode` | R4. |
| `REQUIRES_BUN` / `SYSTEM_DEP_CMDS` | `no` / `git tar` | `tar` extracts the payload; `git` is only the updater bootstrap. |
| `HEALTH_*` | not set ⇒ defaults | This app's `/health` is the shape the defaults describe: `{"status":"ok","version":…}`. |
| `BINARY_*` | not set ⇒ defaults | Three-file payload: executable + `vec0.so` + `lib/libonnxruntime.so.1`. |

### ziptask — `deploy/app.env`

| Key | Value | Note |
|---|---|---|
| `DIST` | `binary` | Requires the release to publish `ziptask-<tag>-linux-x86_64.tar.gz`; the bare executable is refused. |
| `BINARY_REQUIRED_FILES` / `_ROLLBACK_FILES` / `_SWAP_ORDER` | `ziptask` | A one-file payload, named here instead of editing framework code. |
| `CONFIG_FILE` | `/var/lib/ziptask/settings.json` | R1, seeded via `SEED_FILES_DATA="settings.example.json:settings.json"`. |
| **`EXEC_START`** | `/opt/ziptask/ziptask --settings /var/lib/ziptask/settings.json` | **Must be explicit.** The binary-mode default is `${INSTALL_DIR}/${APP_NAME}` with no arguments, and ziptask reads its config only from `--settings` / `ZIPTASK_SETTINGS` — the default would silently run against `./data/ziptask.db` under the unit's working directory. Naming the same file the pre-update hook searches first means the service and the hook read one path, not two candidates. |
| `PORT` / `HEALTH_URL` | `3005` / `http://127.0.0.1:3005/health` | `GET /health` answers `{"ok":true}` (`src/server.ts:143-144`). |
| **`HEALTH_STATUS_FIELD`** | `ok` | The framework's default is `status` compared against `ok degraded` — synaptomind's own shape. Applied unchanged it declares a contract violation on a healthy ziptask and **aborts every install and update**. |
| **`HEALTH_OK_VALUES`** | `true` | Both a quoted string and a bare token are accepted by the reader (`json_field_value()` `common.sh:779-793`). |
| **`HEALTH_VERSION_FIELD`** | empty | Disables the version comparison and prints one explicit warning. The body carries no version, so the gate rests on the status field alone — it cannot tell ziptask from any other process on the port. |
| `SYSTEM_DEP_CMDS` | `git tar sqlite3` | `sqlite3` is required: the pre-update hook aborts the swap without a WAL-safe `.backup` of the database first. |

### subagentix — `deploy/app.env`

| Key | Value | Note |
|---|---|---|
| **`DIST`** | `source` | The documented exception — §7. |
| `CHECKOUT_POLICY` | `stable` | **The repo has no tags yet**, so `stable` resolves to nothing and `resolve_source_ref()` (`common.sh:430`) falls back to the default branch: an install checks out `main`, not a pinned release. The tag path of the framework is untested for this app until the first tag exists. |
| **`EXEC_START`** | `/usr/local/bin/bun /opt/subagentix/build/index.js` | Explicit although the default (`${BUN_BIN} run start` → the same command) would resolve correctly, so a `BUN_BIN` difference between the operator's shell and the install cannot change what systemd starts. |
| `PORT` / `HEALTH_URL` | `3010` / `http://127.0.0.1:3010/api/health` | `/api`, not `/health` (`src/routes/api/health/+server.ts`). |
| **`HEALTH_STATUS_FIELD` / `_OK_VALUES` / `_VERSION_FIELD`** | `ok` / `true` / empty | The body is `{"ok":true,"dbPath":…,"sessions":N}` (`src/lib/server/db.ts:160`) — no `status`, no `version`. Same reasoning as ziptask. |
| **`UNIT_STATE_DIRECTORY`** | `subagentix` | Not cosmetic: `StateDirectory=` makes systemd create `/var/lib/subagentix` owned `User:Group` **and export `STATE_DIRECTORY`**, which `settingsFilePath()` (`src/lib/server/settings.ts:63-68`) resolves before its `cwd()/.data` fallback. Without it, a settings *write* fails at runtime — with `ProtectSystem=strict` and `WorkingDirectory=/opt/subagentix`, after an install that already passed its health check. |
| **`UNIT_ENV_FILE`** | `/etc/subagentix/subagentix.env` | Carries `OPENCODE_DB` / `HOST` / `PORT` / `ZIPTASK_BASE_URL`; root-owned `0640 root:opencode`, the operator's copy (R2). |
| **`UNIT_EXTRA_ENV`** | `BUN_RUNTIME_TRANSPILER_CACHE_PATH=0` | Stops bun writing a transpiler cache into a home directory `ProtectHome` will not allow. Space-separated `K=V` pairs; a TAB or newline is refused by the unit-value guard. |
| **`INSTALL_FLAGS`** | `--frozen-lockfile` | **No `--production`**: every build dependency (`@sveltejs/adapter-node`, `svelte`, `vite`, `typescript`, `svelte-check`) is a devDependency, and `--production` prunes exactly those — the build could not run at all. |
| **`BUILD_CMD`** / `BUILD_TIMEOUT` | `bun run build` / `600` | Without it there is no `build/index.js` and `ExecStart` points at a file that does not exist. |
| `REQUIRES_BUN` / `SYSTEM_DEP_CMDS` | `yes` / `git` | No `tar` (that is the binary extractor), no `sqlite3`: subagentix writes **no** database — it opens opencode's strictly read-only. |
| `SEED_FILES` | `.env.example:.env` | Gives a fresh checkout a readable `.env`. The operator's configuration is the `/etc` file; the seeded copy in the payload tree is `.env.example` verbatim. |

---

## 6. The health contract

Every install and every update ends in a health gate, and the gate is
**configurable per app** because the three `/health` bodies are not the same
shape. Three keys (`common.sh:720-771`, `app.env.example:81-90`):

| Key | Default | Meaning |
|---|---|---|
| `HEALTH_STATUS_FIELD` | `status` | The JSON key carrying state. Must be a plain key (letters, digits, `_`) — the name is interpolated into a pattern, so a `.` or `*` would match more than the field it names. Validated before anything is fetched (`require_health_contract()` `common.sh:737`). |
| `HEALTH_OK_VALUES` | `ok degraded` | Values of that key that mean healthy. An all-blank list is refused, because then nothing could ever pass. |
| `HEALTH_VERSION_FIELD` | `version` | The key carrying the version. **Empty disables the version check and prints one explicit warning** — skipping by silence would turn a missing contract into a vacuous pass. |

A timeout is not a failure: `HEALTH_CONFIRM_TIMEOUT` (30 s) opens a second
window used only when the first expired with *no answer at all*, and the run
reports **UNVERIFIED** — the payload is in, nothing was rolled back — rather
than reverting a service that may well be serving (`update.sh:238-273`).

---

## 7. subagentix: the source-mode exception

**subagentix is `DIST=source` and stays that way.** It is the one deliberate
deviation from the convention above: no release tarball, no `.prev`, an update
is a **build**, and the host needs bun plus a toolchain at update time.

What that produces on disk (verified live): `/opt/subagentix` is a git checkout
containing `node_modules/`, `build/`, `.svelte-kit/` and `build/index.js` beside
`package.json` and `deploy/`. `ProtectSystem=strict` makes that tree read-only
at runtime, which is the intended shape — the service only reads it.

Operational consequences to keep in mind:

- **The rollback point is a git ref.** `PREV_REF` is the short hash `update.sh`
  printed; there is no `.prev` file. The printed remedy is
  `git -C /opt/subagentix checkout --force <PREV_REF>` plus `bun install` +
  `bun run build`.
- **An update can fail in a way a file swap cannot** — a lockfile drift, a
  toolchain difference, a build error. The framework's answer is the build
  timeout and the non-zero abort, not a partial payload.
- **The unit is rendered once** (§2). A change to the template reaches
  subagentix only through a fresh `install.sh`.
- **The hooks are honest no-ops.** subagentix has no database, the source swap
  never touches `DATA_DIR`, and there is no forward-only migration to guard, so
  `hooks/pre-update` says exactly that on every run. Back up
  `/var/lib/subagentix/settings.json` by hand if you want a pre-update copy.

### Variant C (compile to a single binary) — deferred, with rationale

`bun build --compile` over a SvelteKit `adapter-node` app is not a packaging
problem, it is a different deployment shape. Three reasons, from the ADR §8:

1. **Client assets are not embedded.** `adapter-node` emits `build/client`, a
   directory of hashed files served at runtime. `--compile` produces one
   executable with no embedded-asset story for a directory, so they must ship
   alongside — at which point the "self-contained binary" property that
   motivated C is already gone.
2. **A third payload path on a framework that has just been hardened.** `deploy/`
   supports `DIST=source|binary`. C means a third path with its own verify,
   swap and rollback ordering, added to the same code that carries the 2026-09-30
   outage fix.
3. **The risk lands on the least critical app.** subagentix is a diagnostic
   viewer; every byte of availability risk moved into its deploy path comes out
   of the two services that are production.

What would justify revisiting: a measurement that subagentix's source-mode
install+build is the slowest or most failure-prone of the three, or a second
app with the same SvelteKit shape. Neither holds today.

---

## 8. Operating the layout

```bash
# install (from a checkout of the app's own repo)
sudo bash deploy/install.sh                 # add --force to reinstall over a running service
                                         # add --no-service to stage without touching the unit

# update — the primary entry point; stable-only, no sudo of its own
bash ~/ziptask/scripts/updater.sh                    # interactive
bash ~/ziptask/scripts/updater.sh --yes              # newest stable
bash ~/ziptask/scripts/updater.sh --version v0.1.9   # pin a tag
bash ~/ziptask/scripts/update.sh --version v0.1.9    # direct, needed for a branch/prerelease

# uninstall — keeps code + data unless --purge
bash ~/ziptask/scripts/uninstall.sh [--purge]
```

The service step is a **`restart`**, not a `start` (`install.sh:698`):
`systemctl start` on an already-active unit is a no-op, so a re-install over a
running service would leave the old process serving the new unit's port. The
run then fails its own health gate — correctly, and for a reason the operator
would otherwise have to guess.

### Verifying a host against this document

```bash
# 1. layout
ls -l /opt/<app>/data && stat -c '%U:%G' /opt/<app> /var/lib/<app> ~/.<app>/scripts/app.env
# 2. the unit is the rendered one, not a hand edit
diff <(systemctl cat <app>.service | grep -v '^#' | grep -v '^$') <rendered>   # see §2
systemctl show <app> -p Restart -p User -p Group -p NRestarts
# 3. the health body matches the declared contract
curl -sS <HEALTH_URL>
# 4. the restart policy actually holds (a clean exit 0 must come back)
kill -TERM $(pidof <app>) && sleep 8 && systemctl show <app> -p NRestarts
# 5. after an update, which app.env is in force
diff <repo>/deploy/app.env ~/.<app>/scripts/app.env
```

Step 4 is the one that proved its worth: `Restart=on-failure` on a process with
SIGTERM handlers is a one-way outage, and only `NRestarts` incrementing after a
`TERM` demonstrates the property on *this* unit.

---

## 9. Known drift and open items

Verified against the repos and the live host on 2026-10-01. None of these is
fixed by this document; each needs a code/config change in the owning repo.

| # | Finding | Where |
|---|---|---|
| 1 | `docs/DEPLOY.md` still describes the **git-checkout** install (`clones REPO_URL`, secret in `/opt/synaptomind/.env`, rollback by `git checkout`) and ports 3005/3006, while the app is `DIST=binary` on 3105/3106 with a `.env` in the payload tree. Being rewritten for the tarball path under task **#1045**; this file is the map, DEPLOY.md the procedure. | `docs/DEPLOY.md:63-84,183-201` |
| 2 | `AGENTS.md` §6 defers deploy values to `deploy/app.env` (source of truth) rather than restating them, so it no longer carries stale `DIST`/`PORT` literals. `AGENTS.md` is orchestrator-owned — proposed wording goes in a tracker comment, not the file. | `AGENTS.md` §6 |
| 3 | `deploy/app.env.example:73` documents `SERVICE_GROUP=""`, which **no script reads** — the rendered group comes from `TARGET_GROUP`, which `resolve_target_user()` defaults to the service user. Setting `TARGET_GROUP` in `app.env` works (app.env is sourced first); the documented key does not. | `common.sh:174,1319` |
| 4 | subagentix's `app.env` does not declare `CONFIG_FILE`, though the addendum's open item 4 asks for it in all three. `CONFIG_FILE` is documentation-only, so nothing breaks — the rule is just not checkable for that app. | `subagentix/deploy/app.env` |
| 5 | `print_summary()` prints `Config: ${RUN_DIR}/scripts/app.env`, which after R1 names one of two different files (the deploy config, not the app's). Open item 5 of the addendum; `CONFIG_FILE` is not printed. | `install.sh:740` |
| 6 | On this host the **installed** `~/.synaptomind/scripts/app.env` predates `CONFIG_LINK_NAME`/`SEED_FILES_DATA` and still seeds `config.json` into `INSTALL_DIR`; the repo file seeds into `DATA_DIR`. A re-install from a checkout picks up the repo file, an `update.sh` run uses the installed one. The `config.json` symlink already exists, so nothing is currently wrong. | `~/.synaptomind/scripts/app.env` |
| 7 | `/etc/subagentix/subagentix.env`'s header says it was "Installed by `bin/deploy.sh`" (a file that no longer exists) and describes a LAN bind while `HOST=127.0.0.1`. | `/etc/subagentix/subagentix.env` |

---

## 10. Provenance

| What | Where |
|---|---|
| Design decisions | `ai-workdir/synaptomind/plans/2026-10-01-unify-deploy-framework-adr.md` + `…-addendum-config-home.md` |
| Framework source | `deploy/` in this repo; upstream `bun-templates` `89be318d…` |
| Framework proof | `deploy/*.test.ts` (12 suites), pointed at the other repos via `DEPLOY_APP_ENVS` |
| Tracker | epic **#1105** (unify deployment), this document is **#1115**; the per-app procedure docs are **#1045** |
