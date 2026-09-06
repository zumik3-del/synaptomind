# Docker Deployment

Run SynaptoMind as a Docker container for production or development.

---

## Quick Start

```bash
git clone https://github.com/zumik3-del/synaptomind.git && cd synaptomind
cp .env.example .env   # edit SYNAPTOMIND_SECRET
docker compose up -d
```

Server starts on `http://127.0.0.1:3005`. MCP endpoint: `http://127.0.0.1:3006/mcp`.

---

## Production Deployment

### Using published image (recommended)

Edit `docker-compose.yml`:

```yaml
services:
  synaptomind:
    image: ghcr.io/zumik3-del/synaptomind:0.6.0-alpha.0
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
bash scripts/deploy.sh 0.6.0-alpha.0  # specific version
bash scripts/deploy.sh --dev        # main branch (builds from source)
```

The script:
1. Clones/updates repo to `/opt/synaptomind`
2. Checks out the target version
3. Updates `docker-compose.yml` image tag (for tagged releases)
4. Starts the container

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

Without `SYNAPTOMIND_SECRET`, a random UUID is generated at startup and printed to stderr.

For full configuration reference (all settings, env vars, defaults), see [CONFIG.md](CONFIG.md).

### Config file

Mount a custom `config.json`:

```yaml
volumes:
  - ./config.json:/app/config.json:ro
```

Priority: env vars > config.json > defaults. See `config.json.example` for all options.

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

### With deploy script

```bash
bash scripts/deploy.sh 0.6.0-alpha.0
```

### Manual update

```bash
cd /opt/synaptomind
git fetch origin
git checkout 0.6.0-alpha.0
sed -i "s|image: ghcr.io/zumik3-del/synaptomind:.*|image: ghcr.io/zumik3-del/synaptomind:0.6.0-alpha.0|" docker-compose.yml
docker compose up -d
```

### Check running version

```bash
curl http://127.0.0.1:3005/health
# {"status":"ok","version":"0.6.0-alpha.0","checks":{"database":"ok","embedder":"ok"}}
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
  "version": "0.6.0-alpha.0",
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
    image: ghcr.io/zumik3-del/synaptomind:<version>
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
