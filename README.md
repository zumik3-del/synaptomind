# SynaptoMind

[![CI](https://github.com/zumik3-del/synaptomind/actions/workflows/ci.yml/badge.svg)](https://github.com/zumik3-del/synaptomind/actions/workflows/ci.yml)
[![CodeQL](https://github.com/zumik3-del/synaptomind/actions/workflows/codeql.yml/badge.svg)](https://github.com/zumik3-del/synaptomind/actions/workflows/codeql.yml)
[![Security Audit](https://github.com/zumik3-del/synaptomind/actions/workflows/security.yml/badge.svg)](https://github.com/zumik3-del/synaptomind/actions/workflows/security.yml)
[![Coverage Status](https://coveralls.io/repos/github/zumik3-del/synaptomind/badge.svg?branch=main)](https://coveralls.io/github/zumik3-del/synaptomind?branch=main)
[![GitHub Release](https://img.shields.io/github/v/release/zumik3-del/synaptomind?label=latest)](https://github.com/zumik3-del/synaptomind/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Docker](https://img.shields.io/badge/docker-ghcr.io-blue?logo=docker)](https://ghcr.io/zumik3-del/synaptomind)
[![Bun](https://img.shields.io/badge/bun-runtime-%23000000?logo=bun)](https://bun.sh)

**Local persistent memory for AI agents.** Your agent remembers decisions, goals, and context across sessions — via MCP or HTTP API. Data stays on your machine.

<p align="center">
  <img src="docs/images/synaptomind-hero.png" alt="SynaptoMind" width="100%" />
</p>

**Works with** Claude Desktop · Cursor · OpenCode · Codex · any MCP client

---

## Quick Start

```bash
curl -fsSL https://raw.githubusercontent.com/zumik3-del/synaptomind/main/scripts/install.sh | bash
```

Server starts on `http://127.0.0.1:3005`. MCP endpoint: `http://127.0.0.1:3006/mcp`.

Connect your client — add to Claude Desktop config (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "synaptomind": {
      "url": "http://127.0.0.1:3006/mcp",
      "headers": { "Authorization": "Bearer YOUR_TOKEN" }
    }
  }
}
```

The token is printed at the end of installation. That's it — your agent now has persistent memory.

---

## Use Cases

- **Coding agent memory** — architecture decisions, bug root causes, TODOs persist between sessions
- **Project journal** — decisions and goals as a connected graph, not scattered notes
- **Idea graph** — capture thoughts, let semantic search find connections you missed
- **MCP memory backend** — plug persistent memory into any MCP-compatible agent

---

## Example: Auth Decision Across Sessions

```
You: "Remember: we chose JWT for auth, refresh tokens in httpOnly cookies"

Agent: [memory_store action=create — tags: auth, jwt, security]

--- new session ---

You: "What did we decide about auth?"

Agent: [memory_recall action=search "auth decision" → finds JWT thought with full context]

You: "What should I do next?"

Agent: [memory_status action=frontier → "Implement refresh token rotation" ranked #1]
```

Core loop: **capture → link → retrieve → act**. No manual organization — the graph connects related thoughts automatically.

```mermaid
sequenceDiagram
    participant U as You
    participant A as Agent
    participant S as SynaptoMind

    U->>A: "Remember JWT for auth"
    A->>S: memory_store(action=create, content, tags)
    S-->>A: thought_id
    
    Note over U,A: --- new session ---
    
    U->>A: "What about auth?"
    A->>S: memory_recall(action=search, "auth")
    S-->>A: JWT thought + context chain
    A->>S: memory_status(action=frontier)
    S-->>A: ranked next actions
```

---

## SynaptoMind vs Alternatives

| Feature | SynaptoMind | Basic Memory | Mem0 | Zep | Cognee |
|---------|:-----------:|:------------:|:----:|:---:|:------:|
| **Self-hosted** | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Local-first** | ✅ | ✅ | ❌ | ❌ | ❌ |
| **No API keys needed** | ✅ | ✅ | ❌ | ❌ | ❌ |
| **Knowledge graph** | ✅ | ✅ | ❌ | ❌ | ❌ |
| **Vector search** | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Full-text search** | ✅ | ✅ | ❌ | ❌ | ❌ |
| **MCP server** | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Smart notes (auto-surfacing)** | ✅ | ❌ | ❌ | ❌ | ❌ |
| **Frontier (next-action ranking)** | ✅ | ❌ | ❌ | ❌ | ❌ |
| **Local embeddings** | ✅ | ✅ | ❌ | ❌ | ❌ |
| **Runtime** | Bun | Python | Python | Python | Python |
| **License** | MIT | AGPL-3.0 | Apache-2.0 | Apache-2.0 | Apache-2.0 |

**What makes SynaptoMind different:** Graph-native thought storage with semantic search, smart notes that auto-surface when relevant, and Frontier ranking — all running locally with zero external dependencies. MIT licensed.

---

## Features

<details>
<summary><strong>Core concepts — what makes this more than a note app</strong></summary>

| Concept | What it does |
|---------|-------------|
| **Thoughts** | Individual notes/ideas. Each gets an embedding for semantic search and links to other thoughts. |
| **Smart Notes** | Thoughts with surface conditions. They auto-surface when relevant context arrives — e.g., "remind me about auth when I start a session" — and self-promote when enough evidence accumulates. |
| **Slots** | Context windows summarizing your state: persona, goals, architecture decisions. Agents read these on startup. |
| **Frontier** | Ranks "what to do next" based on your thought graph. Most actionable, connected, timely items first. |
| **Primer** | Compact project summary for quick context injection. Promotes the most relevant thoughts into one document. |
| **Crystals** | Compressed markdown from thought clusters — runbooks, decision logs, overviews. |

</details>

<details>
<summary><strong>Technical capabilities</strong></summary>

- **Graph storage** — thoughts, edges, projects, tags, smart notes in SQLite
- **Hybrid search** — vector (vec0) + BM25 (FTS5) via Reciprocal Rank Fusion
- **Local embeddings** — `@huggingface/transformers`, no API keys
- **MCP server** — stdio + HTTP transport
- **Auto-clustering** — batch grouping by embedding proximity
- **Background jobs** — decay, dreamer, self-improve, TTL cleanup

</details>

---

## Architecture

SynaptoMind runs as a single Bun process: the HTTP API on port 3005, the MCP
server on port 3006 (stdio or HTTP), and a child process that serves local
embeddings over IPC. Storage is one SQLite database using the `vec0` extension
for vector search, FTS5 for full-text search, and an edges table for the graph.

```mermaid
graph LR
    A[AI Agent] -->|MCP / HTTP| B[SynaptoMind]
    B --> C[(SQLite)]
    C --> D[vec0 — vector search]
    C --> E[FTS5 — full-text search]
    C --> F[Graph — edges & links]
```

---

## Connecting MCP Clients

<details>
<summary><strong>Claude Desktop</strong></summary>

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "synaptomind": {
      "url": "http://127.0.0.1:3006/mcp",
      "headers": { "Authorization": "Bearer YOUR_TOKEN" }
    }
  }
}
```

</details>

<details>
<summary><strong>Cursor</strong></summary>

Add to `.cursor/mcp.json` in your project or global config:

```json
{
  "mcpServers": {
    "synaptomind": {
      "url": "http://127.0.0.1:3006/mcp",
      "headers": { "Authorization": "Bearer YOUR_TOKEN" }
    }
  }
}
```

</details>

<details>
<summary><strong>OpenCode</strong></summary>

Add to `~/.config/opencode/opencode.json`:

```json
{
  "mcp": {
    "synaptomind": {
      "type": "remote",
      "url": "http://127.0.0.1:3006/mcp",
      "headers": { "Authorization": "Bearer YOUR_TOKEN" }
    }
  }
}
```

</details>

<details>
<summary><strong>Stdio transport</strong></summary>

For clients that prefer stdio:

```json
{
  "command": "bun",
  "args": ["run", "/path/to/synaptomind/src/index.ts", "--stdio"],
  "env": { "SYNAPTOMIND_SECRET": "your-token" }
}
```

By default the stdio process is a **single-owner client**: it opens an MCP
session against the shared database but does **not** start its own embedder
child process or the decay / dreamer / self-improve / TTL-cleanup jobs. Those
are owned by the standalone HTTP server, so N stdio clients no longer spawn N
embedders and N schedulers against one DB.

If you run stdio with no separate server, opt into local ownership with the
`--stdio-standalone` flag (`args: ["run", "...", "--stdio", "--stdio-standalone"]`)
or `SYNAPTOMIND_MCP_STDIO_STANDALONE=true` / `"mcp": { "stdioStandalone": true }`
in `config.json`.

</details>

<details>
<summary><strong>Codex (OpenAI)</strong></summary>

See [docs/codex-plugin.md](docs/codex-plugin.md) for installation and usage.

</details>

<details>
<summary><strong>ChatGPT (OpenAI Secure MCP Tunnel)</strong></summary>

Connect web ChatGPT to a private SynaptoMind MCP server without exposing an
inbound network port. See
[docs/secure-mcp-tunnel.md](docs/secure-mcp-tunnel.md) for setup, validation,
and the security boundary.

</details>

---

## Configuration

All settings in `config.json`. Priority: env vars > config.json > defaults.

The HTTP API port resolves in that order too: `SYNAPTOMIND_PORT` overrides
`config.json` `server.port`, which overrides the built-in `3005`
(`src/config.ts:105-108`).

| Setting | Default | Description |
|---------|---------|-------------|
| `server.port` | 3005 | HTTP API port |
| `server.host` | 127.0.0.1 | Bind address |
| `mcp.httpPort` | 3006 | MCP HTTP transport port |
| `mcp.stdioStandalone` | false | Let a `--stdio` process own the embedder + background jobs (default: shared HTTP server owns them) |
| `embedder.model` | Xenova/multilingual-e5-small | HuggingFace embedding model |
| `db.path` | ./data/synaptomind.db | SQLite database path |

Auth tokens via env vars only:

| Env var | Purpose |
|---------|---------|
| `SYNAPTOMIND_SECRET` | Primary auth token (API + MCP) |
| `SYNAPTOMIND_SERVICE_TOKEN` | Secondary token (optional) |

Without these, the server fails closed: authenticated API and MCP requests are
rejected with `401` and a warning is logged at startup. For local development
only, `SYNAPTOMIND_ALLOW_INSECURE=true` disables auth entirely.

See `config.json.example` for all options. Full reference: [docs/CONFIG.md](docs/CONFIG.md). Custom MCP instructions: [docs below](#custom-instructions).

---

<details>
<summary><strong>Docker</strong></summary>

### From source (development)

```bash
docker compose up -d --build
```

Volumes mount `./data` and `./config.json`.

### Published image (production)

The compose file resolves the image via the `SYNAPTOMIND_IMAGE` variable (default `:local`, built from source):

```bash
SYNAPTOMIND_IMAGE=ghcr.io/zumik3-del/synaptomind:latest docker compose pull && docker compose up -d
```

`scripts/deploy.sh` sets and persists this variable automatically for tagged releases.

### Container user

The container runs as a non-root user (uid/gid `10001`). Make sure the mounted paths are writable/readable by that uid:

```bash
sudo chown -R 10001:10001 data   # required once when upgrading from older (root-run) images
chmod 644 config.json            # config.json must be readable by uid 10001
```

### Auth

```bash
echo "SYNAPTOMIND_SECRET=your-secret-token" > .env
```

See `.env.example` for all variables. Without a token (`SYNAPTOMIND_SECRET`, or
`SYNAPTOMIND_SERVICE_TOKEN`) the server fails closed — authenticated requests
are rejected with `401`. Use `SYNAPTOMIND_ALLOW_INSECURE=true` for local
development only.

For full Docker guide (updating, backup, troubleshooting), see [docs/DOCKER.md](docs/DOCKER.md).

</details>

<details>
<summary><strong>Server installation</strong></summary>

### One-line install

```bash
curl -fsSL https://raw.githubusercontent.com/zumik3-del/synaptomind/main/scripts/install.sh | bash
```

Installs Bun, clones the repo to `/opt/synaptomind`, creates a systemd service, and starts it.

```bash
curl -fsSL ... | bash -s -- --dir /custom/path   # custom install directory
curl -fsSL ... | bash -s -- --port 3005           # custom port
curl -fsSL ... | bash -s -- --no-service          # skip systemd service
```

Token and URL are printed at the end.

### Updating

```bash
bash /opt/synaptomind/scripts/update.sh          # latest stable
bash /opt/synaptomind/scripts/update.sh --alpha  # latest prerelease (alpha/beta/rc)
```

`update.sh` is self-verifying and upgrade-safe:

1. Backs up every configured database with a WAL-safe `sqlite3 .backup` before
   switching code (skipped when no database exists yet; aborts the update if an
   existing database cannot be backed up).
2. Checks out the newest release tag, reinstalls production dependencies, and
   restarts the systemd service if it is running.
3. When the service was restarted, polls `/health` until it reports the target
   version; on timeout or version mismatch it exits non-zero and prints recovery
   instructions — the previous revision (`v<version>`) and the exact backup
   path(s) — without reverting automatically. If no systemd service is running,
   health verification is skipped with a notice.

The health URL is resolved from `config.json`/`SYNAPTOMIND_PORT` (default
`http://127.0.0.1:3005/health`), so the poll targets the configured port rather
than a hardcoded one; override it with `SYNAPTOMIND_HEALTH_URL`.

#### Rollback

Schema migrations are **forward-only** (`src/db/init.ts:127`): the server applies
every migration it has not seen and never reverses one. Checking out an older
tag against a database that a newer version has already migrated is therefore
**unsafe**. The supported rollback restores the pre-upgrade backup that
`update.sh` created and then returns to the previous revision it printed:

```bash
sudo systemctl stop synaptomind
cd /opt/synaptomind
sudo cp data/backup/synaptomind.db.<timestamp>.bak data/synaptomind.db
rm -f data/synaptomind.db-wal data/synaptomind.db-shm
git checkout <previous-tag>
bun install --frozen-lockfile --production
sudo systemctl start synaptomind
```

The backup filename, directory and timestamp follow the configured database
paths; `update.sh` prints the exact paths (`Database backed up: …`) and repeats
them in the recovery block. `SYNAPTOMIND_BACKUP_DIR` overrides the backup
directory (default: `backup/` next to each database, i.e. `data/backup/` for the
default configuration).

### Uninstall

```bash
sudo bash /opt/synaptomind/scripts/uninstall.sh
```

Removes the systemd unit (`/etc/systemd/system/synaptomind.service`, stopped and
disabled first), the install directory (`/opt/synaptomind`), and the versioned
CLI at `${SYNAPTOMIND_BIN_DIR:-/usr/local/bin}/synaptomind` if present. It asks
separately before deleting the data directory (`/var/lib/synaptomind`).

### Docker alternative

```bash
bash scripts/deploy.sh              # latest stable release
bash scripts/deploy.sh --alpha      # latest prerelease (alpha/beta/rc)
bash scripts/deploy.sh 0.3.0        # specific version
bash scripts/deploy.sh --dev        # main branch (development)
```

`scripts/deploy.sh` is non-interactive and self-verifying — it force-checks out
the target tag, migrates `./data` to uid 10001, waits until `/health` reports the
expected version (non-zero exit on mismatch/timeout), and then best-effort
installs/refreshes the versioned CLI to `${SYNAPTOMIND_BIN_DIR:-/usr/local/bin}`.

For day-to-day use:

```bash
synaptomind upgrade --alpha   # deploy + verified version
synaptomind status            # container status + running version
```

If the CLI is not on PATH, install it manually (or let deploy.sh do it):

```bash
sudo install -m 0755 scripts/synaptomind /usr/local/bin/synaptomind
```

See [docs/DOCKER.md](docs/DOCKER.md) for full Docker guide.

</details>

<details>
<summary><strong>API examples</strong></summary>

All `/api/*` endpoints require `Authorization: Bearer <token>` header.
Full endpoint reference: [docs/API.md](docs/API.md).

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

</details>

<details>
<summary><strong>MCP tools</strong></summary>

| Category | Tools |
|----------|-------|
| Recall | `memory_recall` (search, get, context, chain, clusters) |
| Store | `memory_store` (create, update, link, smart_note_*) |
| Supersede | `memory_supersede` (archive, merge) |
| Status | `memory_status` (slots, frontier, profile, config, health, cleanup) |
| Projects | `memory_manage` (list, create, update, delete, resolve) |
| Consolidate | `memory_crystallize` (crystallize, graph, cluster, auto_cluster) |
| Reflect | `memory_reflect` (reflect, timeline) |
| Telemetry | `memory_telemetry` (query, analyze, primers) |
| Guide | `memory_guide` |

</details>

---

## Custom Instructions

The MCP server sends instructions to the AI agent on startup. To customize:

1. Create a markdown file (e.g., `instructions.md`)
2. Set the path in `config.json`:

```json
"mcp": {
  "instructionsFile": "./instructions.md"
}
```

Or via env var:

```bash
export SYNAPTOMIND_MCP_INSTRUCTIONS_FILE=./instructions.md
```

Falls back to default instructions if file not found.

---

## Development

```bash
bun test                 # run tests
bun run eval             # memory evaluation harness (recall@k, MRR, baselines)
bunx biome check src/ eval/   # lint (advisory)
```

For step-by-step usage scenarios, see [docs/SCENARIOS.md](docs/SCENARIOS.md).

For performance benchmarks (search latency, write throughput, embedding speed), see [docs/BENCHMARK.md](docs/BENCHMARK.md).

For the memory evaluation harness (metrics, datasets, thresholds), see [docs/EVAL.md](docs/EVAL.md).

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)

---

## Topics

`mcp` `mcp-server` `ai-memory` `agent-memory` `llm-memory` `persistent-memory` `self-hosted` `local-first` `knowledge-graph` `semantic-search` `ai-agents` `sqlite` `rag`
