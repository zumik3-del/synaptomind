# Docker Deployment

Run SynaptoMind as a Docker container for production or development.

---

## Quick Start

```bash
git clone https://github.com/zumik3-del/synaptomind.git && cd synaptomind
cp config.json.example config.json   # required: compose bind-mounts ./config.json
cp .env.example .env                 # then set SYNAPTOMIND_SECRET in .env
docker compose up -d
```

Both files must exist before `docker compose up`:
`docker-compose.yml` bind-mounts `./config.json` and `./data`. Without
`config.json`, Docker creates a directory at that path and the server refuses
to start (`config.json … is a directory`). `.env.example` deliberately ships no
secret — set `SYNAPTOMIND_SECRET` in `.env`, or the server fails closed and
rejects authenticated requests with `401` (see [CONFIG.md](CONFIG.md#authentication)).

Server starts on `http://127.0.0.1:3005`. MCP endpoint: `http://127.0.0.1:3006/mcp`.

---

## Production Deployment

### Using published image (recommended)

Edit `docker-compose.yml`:

```yaml
services:
  synaptomind:
    image: ghcr.io/zumik3-del/synaptomind:latest
    # build: .   # comment out for production
```

```bash
docker compose pull && docker compose up -d
```

### Using deploy script

The deploy script handles cloning, version selection, and container startup:

```bash
bash scripts/deploy.sh              # latest stable release
bash scripts/deploy.sh --alpha      # latest prerelease (alpha/beta/rc)
bash scripts/deploy.sh 0.3.0        # specific version
bash scripts/deploy.sh --dev        # main branch (builds from source)
```

The script:
1. Clones/updates repo to `/opt/synaptomind`
2. Force-checks out the target version — local modifications to tracked files
   (e.g. a diverged `docker-compose.yml`) are discarded, while untracked
   `.env`, `config.json`, and `data/` are preserved
3. Sets and persists the `SYNAPTOMIND_IMAGE` tag in `.env` (for tagged releases)
4. Migrates `./data` ownership to uid 10001 (non-root image requirement)
5. Starts the container and then polls `/health` until it reports the expected
   version (bounded to 60s). On mismatch or timeout it exits non-zero.
6. Best-effort installs/refreshes the versioned CLI to
   `${SYNAPTOMIND_BIN_DIR:-/usr/local/bin}/synaptomind` (root or sudo;
   warn-only, never fails the deploy).

It never prompts, so it is safe to call from scripts/CI. Output paths are
overridable via `SYNAPTOMIND_INSTALL_DIR`, `SYNAPTOMIND_HEALTH_URL`,
`SYNAPTOMIND_HEALTH_TIMEOUT`, and `SYNAPTOMIND_BIN_DIR`.

### Versioned CLI

`scripts/synaptomind` wraps the deploy script and day-to-day operations. It is
installed/refreshed automatically by `scripts/deploy.sh` after a successful
verified deploy (override the target with `SYNAPTOMIND_BIN_DIR`, default
`/usr/local/bin`). `scripts/install.sh` (the bare-metal path) does **not**
install the CLI — the bare-metal server runs directly under systemd — and
`scripts/uninstall.sh` removes it from
`${SYNAPTOMIND_BIN_DIR:-/usr/local/bin}/synaptomind` together with the systemd
service and install directory. Install it manually only if needed:

```bash
sudo install -m 0755 scripts/synaptomind /usr/local/bin/synaptomind

synaptomind upgrade            # latest stable (delegates to deploy.sh)
synaptomind upgrade 0.6.1      # specific version
synaptomind upgrade --alpha    # latest prerelease
synaptomind upgrade --dev      # main branch (builds from source)
synaptomind status             # container status + running version
synaptomind version            # running version
synaptomind logs 200           # follow last 200 log lines
synaptomind restart            # restart and wait until healthy
```

The CLI resolves the install directory from `SYNAPTOMIND_INSTALL_DIR`
(default `/opt/synaptomind`) and never duplicates deploy logic — `upgrade`
runs `scripts/deploy.sh` and then prints the verified running version.

---

## Configuration

### Environment variables

Create `.env` file:

```bash
cp .env.example .env
```

| Variable | Default | Description |
|----------|---------|-------------|
| `SYNAPTOMIND_SECRET` | (required) | Auth token for API and MCP |
| `SYNAPTOMIND_PORT` | 3005 | HTTP API port |
| `SYNAPTOMIND_HOST` | 127.0.0.1 | Bind address |
| `SYNAPTOMIND_MCP_HTTP_PORT` | 3006 | MCP HTTP transport port |
| `SYNAPTOMIND_DB_PATH` | ./data/synaptomind.db | SQLite database path |
| `SYNAPTOMIND_EMBEDDER_MODEL` | Xenova/multilingual-e5-small | Embedding model |
| `BIND_ADDR` | 127.0.0.1 | Docker port bind address |

Without `SYNAPTOMIND_SECRET` (and with no `SYNAPTOMIND_SERVICE_TOKEN`), the
server fails closed: authenticated API and MCP requests are rejected with
`401`. `SYNAPTOMIND_ALLOW_INSECURE=true` disables auth for local development
only.

For full configuration reference (all settings, env vars, defaults), see [CONFIG.md](CONFIG.md).

### Config file

Mount a custom `config.json`:

```yaml
volumes:
  - ./config.json:/app/config.json:ro
```

Priority: env vars > config.json > defaults. See `config.json.example` for all options.

**Port resolution:** the effective HTTP API port is `SYNAPTOMIND_PORT` >
`config.json` `server.port` > `3005` (the same rule the server applies, and what
`update.sh` uses to locate `/health`). Inside the container the port is pinned by
`docker-compose.yml` (`3005:3005`) and the image healthcheck; if you change the
API port you must update both to match, or the container will report unhealthy.

### Exposing to network

By default, ports bind to `127.0.0.1` (local only). To expose to network:

```bash
echo "BIND_ADDR=0.0.0.0" >> .env
docker compose up -d
```

Or edit `docker-compose.yml` directly:

```yaml
ports:
  - "0.0.0.0:3005:3005"
  - "0.0.0.0:3006:3006"
```

---

## Updating

### With the CLI (recommended)

```bash
synaptomind upgrade            # latest stable
synaptomind upgrade 0.6.1      # specific version (with or without leading "v")
synaptomind upgrade --alpha    # latest prerelease
```

`upgrade` delegates to `scripts/deploy.sh`, which forces the checkout to the
target tag, migrates `./data` to uid 10001, restarts the container, and waits
until `/health` reports the expected version (exits non-zero on mismatch or
timeout). The running version is printed at the end.

### With deploy script

```bash
bash scripts/deploy.sh 0.6.1
```

The deploy script is non-interactive and self-verifying; see
[Using deploy script](#using-deploy-script) for details.

### Manual update

The compose file resolves the image via `SYNAPTOMIND_IMAGE` (see `docker-compose.yml`):

```bash
cd /opt/synaptomind
git fetch --tags -f origin
git checkout -f 0.6.1          # force: discard diverged tracked files
export SYNAPTOMIND_IMAGE=ghcr.io/zumik3-del/synaptomind:0.6.1
# optional: persist for later manual `docker compose up` runs
grep -q '^SYNAPTOMIND_IMAGE=' .env && sed -i "s|^SYNAPTOMIND_IMAGE=.*|SYNAPTOMIND_IMAGE=${SYNAPTOMIND_IMAGE}|" .env || echo "SYNAPTOMIND_IMAGE=${SYNAPTOMIND_IMAGE}" >> .env
sudo chown -R 10001:10001 data   # required once when upgrading from root-run images
docker compose pull 2>/dev/null || true
docker compose up -d
```

### Rollback

Schema migrations are **forward-only** (`src/db/init.ts:127`): the server applies
every migration it has not seen yet and never reverses one. Running an older tag
against a database that a newer version has already migrated is therefore
**unsafe** — the old code cannot undo the schema change and may operate on
tables or columns it does not understand.

The supported rollback is: restore the database backup taken *before* the
upgrade, then run the older version. Unlike the bare-metal `scripts/update.sh`,
`scripts/deploy.sh` does not back up automatically, so take one first (see
[Backup](#backup)):

```bash
# 1. Before upgrading: stop the container and keep the current database
docker compose stop
cp data/synaptomind.db data/synaptomind.db.preupgrade
docker compose start

# 2. Upgrading happens here (CLI, deploy.sh, or manual)
#    ...

# 3. Roll back: stop, restore the pre-upgrade database, deploy the older tag
docker compose stop
cp data/synaptomind.db.preupgrade data/synaptomind.db
rm -f data/synaptomind.db-wal data/synaptomind.db-shm
bash scripts/deploy.sh 0.6.0
```

For the bare-metal path, `scripts/update.sh` creates this backup itself and
prints its exact path; see the README "Updating" section.

### Check running version

```bash
synaptomind version
# or
curl -s http://127.0.0.1:3005/health | jq -r .version
# {"status":"ok","version":"0.6.1","checks":{"database":"ok","embedder":"ok"}}
```

---

## Data Volumes

| Container path | Host mount | Description |
|----------------|------------|-------------|
| `/app/data` | `./data` | Database + embeddings cache |
| `/app/config.json` | `./config.json` | Configuration (read-only) |

### Database files

- `data/synaptomind.db` — main database (thoughts, edges, projects)
- `data/logs.db` — session logs
- `data/huggingface/` — cached embedding models (~150MB after first run)

---

## Backup

```bash
# Stop container
docker compose stop

# Backup database
cp data/synaptomind.db data/synaptomind.db.bak

# Restart
docker compose start
```

Or hot backup without stopping:

```bash
docker compose exec synaptomind sqlite3 /app/data/synaptomind.db ".backup '/app/data/backup.db'"
docker compose cp synaptomind:/app/data/backup.db ./backup.db
```

---

## Health Check

```bash
curl http://127.0.0.1:3005/health
```

Response:

```json
{
  "status": "ok",
  "version": "0.3.0",
  "checks": {
    "database": "ok",
    "embedder": "ok"
  }
}
```

Docker health check is configured — container shows `(healthy)` in `docker compose ps`.

---

## Logs

```bash
# Follow logs
docker compose logs -f

# Last 100 lines
docker compose logs --tail 100

# Since specific time
docker compose logs --since 10m
```

---

## Troubleshooting

### Container won't start

```bash
docker compose logs
```

Common issues:
- Missing `.env` file → create with `SYNAPTOMIND_SECRET=your-token`
- Port already in use → change `BIND_ADDR` or ports in `docker-compose.yml`
- Permission denied on `./data` → `chmod 777 ./data`

### Embedder not loading

First run downloads the model (~150MB). Check progress:

```bash
docker compose logs -f | grep -i embedder
```

### Reset database

```bash
docker compose stop
rm -f data/synaptomind.db data/synaptomind.db-wal data/synaptomind.db-shm
docker compose start
```

### Container shows unhealthy

```bash
docker compose exec synaptomind curl -s http://127.0.0.1:3005/health
```

Check if the process is running:

```bash
docker compose exec synaptomind ps aux
```

---

## Docker Compose Reference

```yaml
services:
  synaptomind:
    image: ${SYNAPTOMIND_IMAGE:-ghcr.io/zumik3-del/synaptomind:local}
    build:
      context: .
      args:
        VERSION: ${GIT_DESCRIBE:-dev}
        COMMIT_SHA: ${GIT_COMMIT:-}
    container_name: synaptomind
    restart: unless-stopped
    ports:
      - "${BIND_ADDR:-127.0.0.1}:3005:3005"
      - "${BIND_ADDR:-127.0.0.1}:3006:3006"
    volumes:
      - ./data:/app/data
      - ./config.json:/app/config.json:ro
    env_file:
      - .env
    environment:
      - SYNAPTOMIND_DB_PATH=/app/data/synaptomind.db
      - SYNAPTOMIND_LOG_DB_PATH=/app/data/logs.db
      - SYNAPTOMIND_EMBEDDER_CACHE_DIR=/app/data/huggingface
    healthcheck:
      test: ["CMD", "curl", "-f", "http://127.0.0.1:3005/health"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 10s
```

This mirrors `docker-compose.yml`; `SYNAPTOMIND_IMAGE` is set by
`scripts/deploy.sh` for tagged releases and defaults to a local build from
source (see [Using published image](#using-published-image-recommended)).
