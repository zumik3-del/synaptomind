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

Define all machine-specific values once. `$HOME` is expanded by the shell before
the profile is written, so tunnel-client receives absolute paths.

```bash
export SYNAPTOMIND_DIR="/absolute/path/to/synaptomind"
export BUN_BIN="/absolute/path/to/bun"
export TUNNEL_ID="tunnel_REPLACE_ME"
export TUNNEL_PROFILE_DIR="$HOME/.config/tunnel-client"
```

`SYNAPTOMIND_DIR` must be the repository root, and `BUN_BIN` must point to the
real Bun executable rather than a version-manager shim. Store the runtime key
outside the repository:

```bash
mkdir -p "$TUNNEL_PROFILE_DIR/secrets"
chmod 700 "$TUNNEL_PROFILE_DIR/secrets"
printf '%s' "$OPENAI_TUNNEL_RUNTIME_KEY" > "$TUNNEL_PROFILE_DIR/secrets/synaptomind-runtime-key"
chmod 600 "$TUNNEL_PROFILE_DIR/secrets/synaptomind-runtime-key"
unset OPENAI_TUNNEL_RUNTIME_KEY
```

Generate a stdio profile. The MCP command explicitly sets every runtime path
that would otherwise depend on the tunnel process's working directory.

```bash
tunnel-client init \
  --profile-dir "$TUNNEL_PROFILE_DIR" \
  --profile synaptomind \
  --tunnel-id "$TUNNEL_ID" \
  --control-plane-api-key-ref "file:$TUNNEL_PROFILE_DIR/secrets/synaptomind-runtime-key" \
  --health-listen-addr 127.0.0.1:8080 \
  --mcp-command "/usr/bin/env SYNAPTOMIND_DB_PATH=$SYNAPTOMIND_DIR/data/synaptomind.db SYNAPTOMIND_LOG_DB_PATH=$SYNAPTOMIND_DIR/data/logs.db SYNAPTOMIND_EMBEDDER_CACHE_DIR=$SYNAPTOMIND_DIR/data/huggingface $BUN_BIN run $SYNAPTOMIND_DIR/src/index.ts --stdio"
```

Review `$TUNNEL_PROFILE_DIR/synaptomind.yaml`. Keep the health/admin listener on
loopback. Port `8080` is fixed here so every later health command uses the same
address; choose another unused loopback port consistently if required.

Never commit the runtime key, tunnel ID, workspace ID, or a machine-specific
profile to this repository.

## Validate and run

Run preflight diagnostics:

```bash
tunnel-client doctor \
  --profile-dir "$TUNNEL_PROFILE_DIR" \
  --profile synaptomind \
  --explain
```

For a long-lived local runtime, use the lifecycle mechanism provided by the
installed tunnel-client. For a foreground validation run:

```bash
tunnel-client run \
  --profile-dir "$TUNNEL_PROFILE_DIR" \
  --profile synaptomind
```

Verify liveness and readiness using the fixed loopback address:

```bash
curl --fail http://127.0.0.1:8080/healthz
curl --fail http://127.0.0.1:8080/readyz
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
