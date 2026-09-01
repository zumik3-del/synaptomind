# SynaptoMind

Lightweight thought-graph engine. Capture, link, cluster, and retrieve thoughts via HTTP API or MCP server.

## Architecture

SynaptoMind runs as **two processes**:

1. **Main process** — HTTP API (Hono) + MCP server (stdio/HTTP) + background jobs
2. **Embedder subprocess** — local embedding generation via `@huggingface/transformers` (IPC)

The embedder runs as a child process spawned by the main process. It communicates via Bun IPC and handles model loading, embedding generation, and idle timeout. The main process manages all HTTP/IO, database operations, and background tasks.

## Quick Start

### Prerequisites

- [Bun](https://bun.sh/) runtime
- Internet connection (for initial setup)

### 1. Install dependencies

```bash
bun install
```

This also runs `postinstall` which downloads the `vec0.so` SQLite extension from [sqlite-vec releases](https://github.com/asg017/sqlite-vec). The binary is platform-specific (linux/macOS, x86_64/aarch64) and is not committed to the repository.

### 2. Configure

```bash
cp config.json.example config.json
```

Edit `config.json` to customize settings. Key options:

- `server.port` — HTTP API port (default: 3005)
- `server.host` — bind address (default: 127.0.0.1)
- `mcp.httpPort` — MCP HTTP transport port (default: 3006)
- `embedder.model` — HuggingFace model for embeddings (default: Xenova/multilingual-e5-small)
- `db.path` — SQLite database path (default: ./data/synaptomind.db)

All settings can be overridden via environment variables (see `src/config.ts` for the full mapping).

### 3. Start

```bash
bun run src/index.ts
```

## Authentication

Both the HTTP API and MCP HTTP transport require bearer token auth.

| Env var | Purpose |
|---------|---------|
| `SYNAPTOMIND_SECRET` | Primary auth token for API + MCP |
| `SYNAPTOMIND_SERVICE_TOKEN` | Secondary token (optional, for service-to-service) |

If neither is set, random UUID tokens are generated at startup — **one for the API, one for MCP** (they are separate). The generated tokens are printed to stderr on startup.

```bash
# Set a persistent token (recommended for production)
export SYNAPTOMIND_SECRET=my-secret-token
```

### Endpoints

| Endpoint | Description |
|----------|-------------|
| `http://127.0.0.1:3005` | HTTP API (requires auth) |
| `http://127.0.0.1:3006/mcp` | MCP HTTP transport (requires auth) |
| `http://127.0.0.1:3005/health` | Health check (no auth) |
| stdio | MCP stdio transport (`bun run src/index.ts --stdio`) |

## Features

- **Graph storage** — thoughts, edges, projects, tags, smart notes
- **Hybrid search** — vector (vec0) + BM25 (FTS5) + entity matching
- **Local embeddings** — `@huggingface/transformers`, no API keys
- **MCP server** — 30+ tools, stdio + HTTP transport
- **Auto-clustering** — batch grouping by embedding proximity
- **Background jobs** — decay, dreamer, self-improve, git sync

## Docker

```bash
docker compose up -d
```

The Docker image builds from source. Volumes mount `./data` and `./config.json`.

Set `SYNAPTOMIND_SECRET` in your docker-compose environment for persistent auth:

```yaml
environment:
  - SYNAPTOMIND_SECRET=your-secret-token
```

Without it, a random token is generated on each restart and printed to `docker logs`.

## Config

All settings in `config.json`. Priority: env vars > config.json > defaults.

See `config.json.example` for all options. Auth tokens are configured via env vars only (`SYNAPTOMIND_SECRET`, `SYNAPTOMIND_SERVICE_TOKEN`).

## API Examples

All `/api/*` endpoints require `Authorization: Bearer <token>` header. See [Authentication](#authentication) above.

### Create a thought

```bash
curl -X POST http://127.0.0.1:3005/api/thoughts \
  -H "Authorization: Bearer $SYNAPTOMIND_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"content": "First session went well", "tags": ["retrospective"]}'
```

### Search thoughts

```bash
curl "http://127.0.0.1:3005/api/thoughts/search?q=session+retrospective&limit=5" \
  -H "Authorization: Bearer $SYNAPTOMIND_SECRET"
```

### Health check

```bash
curl http://127.0.0.1:3005/health
```

## MCP Tools

The MCP server exposes 30+ tools organized by domain:

| Category | Tools |
|----------|-------|
| Thoughts | create, get, update, search, merge, archive, link, chain |
| Graph | thought_graph, cluster, auto_cluster |
| Projects | create, list, update, assign |
| Smart Notes | create, list, evaluate, promote |
| Slots | get context slots (persona, goals, decisions) |
| Frontier | what-to-do-next ranking |
| Profile | user profile stats |
| Telemetry | patterns, frequency, analytics |
| Health | graph health audit |

## Testing

```bash
bun test
```

## Linting

```bash
bunx biome check src/
```

## License

[MIT](LICENSE)
