# SynaptoMind

Self-hosted persistent memory for AI assistants. Capture, link, cluster, and retrieve thoughts via HTTP API or MCP server. Remembers project decisions, goals, and unfinished tasks across sessions, finds related context, and keeps all data locally. Ships as an MCP server, so your AI agents can directly capture, search, and traverse your thought graph.

## Use Cases

- **Coding agent memory** — your AI assistant remembers architecture decisions, bug root causes, and TODO items between sessions. No more re-explaining context.
- **Project journal** — track decisions, goals, and unfinished work as a connected graph instead of scattered notes and chat history.
- **Idea graph** — capture thoughts and let SynaptoMind find connections you missed. Related ideas surface automatically through semantic search.
- **MCP memory backend** — plug persistent memory into any AI agent via MCP or HTTP API. Works with Cursor, Claude Desktop, OpenCode, and any MCP-compatible client.

## Example: Auth Decision Across Sessions

```
You: "Remember: we chose JWT for auth, refresh tokens stored in httpOnly cookies"

Agent: [creates thought, tags: auth, jwt, security]

--- new session ---

You: "What did we decide about auth?"

Agent: [semantic search → finds the JWT thought]

You: "What should I do next?"

Agent: [uses Frontier → ranks "Implement refresh token rotation" as the top action]
```

This is the core loop: **capture → link → retrieve → act**. No manual organization needed — the graph connects related thoughts automatically.

## Architecture

SynaptoMind runs as **two processes**:

1. **Main process** — HTTP API (Hono) + MCP server (stdio/HTTP) + background jobs
2. **Embedder subprocess** — local embedding generation via `@huggingface/transformers` (IPC)

The embedder runs as a child process spawned by the main process. It communicates via Bun IPC (Inter-Process Communication) and handles model loading, embedding generation, and idle timeout. The main process manages all HTTP/IO, database operations, and background tasks.

## Quick Start

### Prerequisites

- [Bun](https://bun.sh/) runtime
- Internet connection (for initial setup)

### 1. Install dependencies

```bash
bun install
```

This also runs `postinstall`, which downloads the `vec0.so` SQLite extension from [sqlite-vec releases](https://github.com/asg017/sqlite-vec). The binary is platform-specific (Linux/macOS, x86_64/aarch64) and is not committed to the repository.

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

If neither is set, a random UUID token is generated at startup and shared by both the API and MCP transport. The generated token is printed to stderr on startup.

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
- **MCP server** — stdio + HTTP transport
- **Auto-clustering** — batch grouping by embedding proximity
- **Background jobs** — decay, dreamer, self-improve, git sync

## Key Concepts

These are the building blocks that make SynaptoMind more than a note-taking app:

| Concept | What it does |
|---------|-------------|
| **Thoughts** | Individual notes or ideas. Each gets an embedding for semantic search and can be linked to other thoughts. |
| **Smart Notes** | Thoughts with surface conditions. They automatically surface when relevant context arrives — e.g., "remind me about auth when I start a new session" — and promote themselves when enough evidence accumulates. |
| **Slots** | Context windows that summarize your state: who you are (persona), what you're working on (goals), what decisions were made (architecture_decisions). AI agents read these on startup to get oriented. |
| **Frontier** | A ranking of "what to do next" based on your thought graph. Surfaces the most actionable, connected, and timely items. |
| **Primer** | A compact summary of your project designed for quick context injection. Promotes the most relevant thoughts into a single document. |
| **Crystals** | Compressed markdown documents generated from clusters of thoughts — runbooks, decision logs, or overviews. Useful for sharing or documenting. |

## Connecting MCP Clients

SynaptoMind ships as an MCP server. Here's how to connect popular clients:

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

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

### Cursor

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

### OpenCode

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

### Stdio Transport

For clients that prefer stdio, point to the source directly:

```json
{
  "command": "bun",
  "args": ["run", "/path/to/synaptomind/src/index.ts", "--stdio"],
  "env": { "SYNAPTOMIND_SECRET": "your-token" }
}
```

## Docker

```bash
docker compose up -d
```

The Docker image builds from source. Volumes are mounted for `./data` and `./config.json`.

Set `SYNAPTOMIND_SECRET` in a `.env` file for persistent auth:

```bash
echo "SYNAPTOMIND_SECRET=your-secret-token" > .env
```

See `.env.example` for all available environment variables. Without a `.env` file, a random token is generated on each restart and printed to `docker logs`.

## Config

All settings are in `config.json`. Priority: env vars > config.json > defaults.

See `config.json.example` for all options. Auth tokens are configured via env vars only (`SYNAPTOMIND_SECRET`, `SYNAPTOMIND_SERVICE_TOKEN`).

## Custom Instructions

The MCP server sends instructions to the AI agent on startup. By default, it uses built-in instructions. To customize them:

1. Create a markdown file (e.g., `instructions.md`)
2. Set the path in `config.json`:

```json
"mcp": {
  "instructionsFile": "./instructions.md"
}
```

Or via environment variable:

```bash
export SYNAPTOMIND_MCP_INSTRUCTIONS_FILE=./instructions.md
```

If the file is not found, the server falls back to default instructions and logs a warning.

## API Examples

All `/api/*` endpoints require an `Authorization: Bearer <token>` header. See [Authentication](#authentication) above.

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

The MCP server exposes tools organized by domain:

| Category | Tools |
|----------|-------|
| Thoughts | `create_thought`, `get_thought`, `update_thought`, `search_thoughts`, `get_thought_timeline`, `archive_thought`, `assign_thought_to_project` |
| Graph | `link_thoughts`, `merge_thoughts`, `get_chain`, `get_context`, `get_thought_graph` |
| Clusters | `cluster`, `auto_cluster`, `recall_clusters` |
| Projects | `create_project`, `list_projects`, `update_project`, `delete_project` |
| Smart Notes | `create_smart_note`, `list_smart_notes`, `eval_smart_notes`, `promote_smart_note`, `delete_smart_note` |
| Context | `get_slots`, `get_frontier`, `get_profile` |
| Primers | `manage_primers` |
| Crystals | `crystallize` |
| Telemetry | `get_telemetry`, `analyze_telemetry` |
| Health | `health_check` |
| Git | `git_index_commits` |
| Guide | `guide_thoughts` |
| Config | `get_config` |

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
