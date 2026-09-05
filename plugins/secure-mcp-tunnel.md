# ChatGPT via OpenAI Secure MCP Tunnel

This optional integration connects web ChatGPT to a private SynaptoMind MCP
server without changing SynaptoMind or exposing an inbound network port.

```text
ChatGPT -> OpenAI Secure MCP Tunnel -> tunnel-client -> SynaptoMind stdio MCP
```

The tunnel is transport only. It starts the normal SynaptoMind server and
exposes its complete unified `memory_*` tool surface without a mobile or
restricted profile.

## Prerequisites

- A working SynaptoMind checkout with `bun install` already completed
- The current official OpenAI `tunnel-client` release
- An OpenAI Platform tunnel associated with the intended ChatGPT workspace
- A restricted runtime API key with the tunnel permissions documented by OpenAI

Install `tunnel-client` only from the official OpenAI documentation or OpenAI
GitHub organization, then verify the installed version and current CLI syntax:

```bash
tunnel-client --version
tunnel-client help quickstart
tunnel-client help doctor
```

## Configure

Store the runtime key outside this repository:

```bash
mkdir -p ~/.config/tunnel-client/secrets
chmod 700 ~/.config/tunnel-client/secrets
printf '%s' "$OPENAI_TUNNEL_RUNTIME_KEY" > ~/.config/tunnel-client/secrets/synaptomind-runtime-key
chmod 600 ~/.config/tunnel-client/secrets/synaptomind-runtime-key
unset OPENAI_TUNNEL_RUNTIME_KEY
```

Generate a stdio profile. Replace every uppercase placeholder with the actual
value. All filesystem paths must be absolute because the tunnel runtime may use
a different working directory.

```bash
tunnel-client init \
  --profile synaptomind \
  --tunnel-id TUNNEL_ID \
  --control-plane-api-key-ref file:/home/USER/.config/tunnel-client/secrets/synaptomind-runtime-key \
  --health-listen-addr 127.0.0.1:0 \
  --mcp-command "/usr/bin/env SYNAPTOMIND_DB_PATH=SYNAPTOMIND_DIR/data/synaptomind.db SYNAPTOMIND_LOG_DB_PATH=SYNAPTOMIND_DIR/data/logs.db SYNAPTOMIND_EMBEDDER_CACHE_DIR=SYNAPTOMIND_DIR/data/huggingface BUN_BIN run SYNAPTOMIND_DIR/src/index.ts --stdio"
```

Review `~/.config/tunnel-client/synaptomind.yaml`. Keep the health/admin listener
on loopback. When using an ephemeral health port, add a URL file if the generated
profile does not include one:

```yaml
health:
  listen_addr: 127.0.0.1:0
  url_file: /home/USER/.local/state/tunnel-client/health/synaptomind.url
```

Never commit the runtime key, tunnel ID, workspace ID, or a machine-specific
profile to this repository.

## Validate and run

Run preflight diagnostics:

```bash
tunnel-client doctor \
  --profile-dir "$HOME/.config/tunnel-client" \
  --profile synaptomind \
  --explain
```

For a long-lived local runtime, use the lifecycle mechanism provided by the
installed tunnel-client. For a foreground validation run:

```bash
tunnel-client run \
  --profile-dir "$HOME/.config/tunnel-client" \
  --profile synaptomind
```

Verify liveness and readiness using the URL written by the profile:

```bash
HEALTH_URL=$(cat ~/.local/state/tunnel-client/health/synaptomind.url)
curl --fail "$HEALTH_URL/healthz"
curl --fail "$HEALTH_URL/readyz"
```

`healthz` confirms that tunnel-client is alive. `readyz` confirms that its
startup and downstream readiness checks passed. Use `tunnel-client health` with
the installed version's control-plane-poll option when strict runtime validation
is required.

## Connect ChatGPT

1. Open **ChatGPT -> Settings -> Apps / Connectors -> Create**.
2. Select **Tunnel** as the connection type.
3. Select the SynaptoMind tunnel.
4. Select the MCP authentication mode actually used by the local deployment.
5. Save the connector and start a new conversation.

Verify that ChatGPT discovers the complete current SynaptoMind tool set. At the
time this integration was written, it consists of:

- `memory_recall`
- `memory_store`
- `memory_supersede`
- `memory_status`
- `memory_manage`
- `memory_crystallize`
- `memory_reflect`
- `memory_telemetry`
- `memory_guide`

Web ChatGPT does not have a reliable local filesystem working directory. It
should call `memory_manage` with `action=list`, select a canonical project ID,
and pass `project_id` instead of inventing `cwd`.

## Security boundary

All tools advertised by the normal SynaptoMind MCP server are available through
this integration, including write, destructive, and batch actions. Secure MCP
Tunnel does not add operation-level authorization. Do not test connectivity with
a destructive or bulk action, and require explicit user approval before such an
operation.

The Codex plugin in `plugins/synaptomind/` is separate. It helps Codex discover
an already configured MCP server; it does not create, configure, or authorize
this tunnel.
