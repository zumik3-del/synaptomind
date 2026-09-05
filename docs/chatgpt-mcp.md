# ChatGPT with Secure MCP Tunnel

OpenAI Secure MCP Tunnel lets ChatGPT reach a private SynaptoMind stdio process
through an outbound connection. SynaptoMind does not need a public listener or
an inbound firewall rule.

```text
ChatGPT -> OpenAI tunnel control plane -> tunnel-client -> SynaptoMind stdio MCP
```

The tunnel is a transport boundary. This configuration exposes the complete
SynaptoMind MCP surface, including write, destructive, and batch actions. The
server's tool contracts and the agent's confirmation policy remain responsible
for operation safety. Project deletion has a built-in preview/confirmation
flow; other destructive and batch actions are not generally protected by a
server-enforced confirmation boundary.

## Available tools

The tunneled process uses the normal SynaptoMind MCP server without a separate
profile. ChatGPT can discover every unified tool:

- `memory_recall`
- `memory_store`
- `memory_supersede`
- `memory_status`
- `memory_manage`
- `memory_crystallize`
- `memory_reflect`
- `memory_telemetry`
- `memory_guide`

## 1. Install SynaptoMind

Install Bun and clone SynaptoMind from its official repository:

```bash
git clone https://github.com/zumik3-del/synaptomind.git
cd synaptomind
bun install --frozen-lockfile
```

Create the database and verify the stdio server starts:

```bash
bun run src/index.ts --stdio
```

Stop the process after the startup message appears on stderr. MCP stdio reserves
stdout for JSON-RPC; SynaptoMind redirects ordinary console output to stderr in
this mode.

The included static launcher resolves the repository from its own location and
loads ChatGPT-specific MCP instructions:

```bash
./scripts/run-secure-tunnel-stdio.sh
```

If Bun is not available in the tunnel daemon's `PATH`, set its absolute path in
the daemon environment:

```bash
export SYNAPTOMIND_BUN_BIN=/absolute/path/to/bun
```

## 2. Install tunnel-client

Install the current official OpenAI `tunnel-client` release using the Secure MCP
Tunnel documentation on `developers.openai.com` or the official repository in
the OpenAI GitHub organization. Verify the source and current supported release
instead of copying an old version number.

Confirm the installation:

```bash
tunnel-client --version
tunnel-client help quickstart
tunnel-client help doctor
```

## 3. Create the tunnel and runtime key

In OpenAI Platform:

1. Open **Settings -> Organization -> Tunnels**.
2. Create a purpose-specific tunnel such as `synaptomind-chatgpt`.
3. Associate it with the ChatGPT workspace that will use it.
4. Create a separate restricted runtime API key.
5. Grant only the tunnel runtime permissions documented by OpenAI, currently
   **Tunnels Read + Use**.

Do not use an admin key as the long-lived runtime key. The runtime key connects
`tunnel-client` to the selected tunnel; it is separate from ChatGPT workspace
identity and any SynaptoMind application authentication.

Store the key outside the repository:

```bash
mkdir -p ~/.config/tunnel-client/secrets
chmod 700 ~/.config/tunnel-client/secrets
printf '%s' "$OPENAI_TUNNEL_RUNTIME_KEY" > ~/.config/tunnel-client/secrets/synaptomind-runtime-key
chmod 600 ~/.config/tunnel-client/secrets/synaptomind-runtime-key
unset OPENAI_TUNNEL_RUNTIME_KEY
```

## 4. Configure the stdio target

Start from the client-generated stdio profile so its current schema remains the
authority:

```bash
tunnel-client init \
  --profile synaptomind \
  --tunnel-id TUNNEL_ID \
  --mcp-command /absolute/path/to/synaptomind/scripts/run-secure-tunnel-stdio.sh \
  --control-plane-api-key-ref file:/home/USER/.config/tunnel-client/secrets/synaptomind-runtime-key \
  --health-listen-addr 127.0.0.1:0
```

Review the generated `~/.config/tunnel-client/synaptomind.yaml`. The following
complete example also configures a discoverable health URL and file logging.
Replace `TUNNEL_ID`, `/home/USER`, and the repository path for the target
machine. Do not put a literal API key in this file:

```yaml
config_version: 1
control_plane:
  base_url: https://api.openai.com
  tunnel_id: TUNNEL_ID
  api_key: file:/home/USER/.config/tunnel-client/secrets/synaptomind-runtime-key
health:
  listen_addr: 127.0.0.1:0
  url_file: /home/USER/.local/state/tunnel-client/health/synaptomind.url
admin_ui:
  open_browser: false
log:
  level: info
  format: json
  file: /home/USER/.local/state/tunnel-client/logs/synaptomind.log
mcp:
  commands:
    - channel: main
      command: /absolute/path/to/synaptomind/scripts/run-secure-tunnel-stdio.sh
```

The MCP command is static operator configuration. Never interpolate ChatGPT
input into it.

## 5. Diagnose and run

Run preflight diagnostics before registering the ChatGPT connector:

```bash
tunnel-client doctor \
  --profile-dir "$HOME/.config/tunnel-client" \
  --profile synaptomind \
  --explain
```

Then start the runtime:

```bash
tunnel-client run \
  --profile-dir "$HOME/.config/tunnel-client" \
  --profile synaptomind
```

Use a supervised runtime for long-lived operation. Do not rely on an improvised
`nohup` process when the installed tunnel-client provides lifecycle management.

The profile writes its local operator URL to `health.url_file`. Verify both
endpoints using that loopback URL:

```bash
HEALTH_URL=$(cat ~/.local/state/tunnel-client/health/synaptomind.url)
curl --fail "$HEALTH_URL/healthz"
curl --fail "$HEALTH_URL/readyz"
```

`healthz` proves the client is alive. `readyz` is the primary signal that tunnel
startup and downstream readiness checks passed.

## 6. Connect ChatGPT

After diagnostics and readiness pass:

1. Open **ChatGPT -> Settings -> Apps / Connectors -> Create**.
2. Choose **Tunnel** as the connection type.
3. Select the tunnel created for SynaptoMind.
4. Choose the MCP authentication mode that SynaptoMind actually supports. A
   local stdio deployment can intentionally use no additional MCP-level auth
   when the workspace, tunnel runtime, and local process boundary are sufficient.
5. Save the connector and start a new conversation.

ChatGPT does not have a reliable local filesystem working directory. The
included `config/secure-tunnel-mcp-instructions.md` tells it to call
`memory_manage` with `action=list` and use an explicit canonical `project_id`
instead of inventing `cwd`.

## 7. Verify end to end

In a new ChatGPT conversation:

1. Confirm tool discovery returns all nine tools listed above.
2. Call `memory_guide`.
3. Call `memory_manage` with `action=list` and select a test project.
4. Call `memory_status` with `action=slots` and that `project_id`.
5. Run `memory_recall` with `action=search` for a known test thought.
6. Only with explicit authorization, create a reversible test thought using
   `memory_store` with `action=create`, then verify it with `memory_recall`.

Do not use a destructive or batch operation merely to test connectivity.

## Codex plugin

The repository also ships `plugins/synaptomind`, a Codex routing plugin. It
makes an already configured SynaptoMind MCP discoverable to Codex's skill
catalog; it does not install tunnel-client, create a tunnel, start another MCP
server, or duplicate the MCP configuration.

For local Codex use:

```bash
codex plugin add ./plugins/synaptomind
codex plugin list
```

Codex has a real working directory and should pass `cwd` as described by the
plugin. ChatGPT over the tunnel should use explicit project IDs. See
[codex-plugin.md](codex-plugin.md) for plugin verification and troubleshooting.

## Updating

After updating SynaptoMind:

```bash
bun install --frozen-lockfile
bun test
```

Restart the tunnel runtime so its next stdio process uses the updated source.
Run `doctor`, `healthz`, `readyz`, tool discovery, and a representative read
again. Tool names and schemas are an MCP compatibility boundary; review release
notes before deploying updates.

## Troubleshooting order

1. Run the launcher directly and prove MCP initialization.
2. Run `tunnel-client doctor --explain`.
3. Verify the runtime key can read and use the exact tunnel.
4. Check `healthz`, then `readyz`.
5. Inspect the configured JSON log and local operator UI.
6. Verify the tunnel belongs to the intended ChatGPT workspace.
7. Verify ChatGPT connector authentication matches the MCP server.

Do not expose the local operator UI or SynaptoMind listener publicly to bypass a
tunnel configuration problem.
