# Codex Plugin

SynaptoMind ships a routing skill that makes it discoverable in Codex's skill catalog. Without it, Codex may not know SynaptoMind exists until after a tool call — a bootstrap problem because Codex does not reliably expose MCP server instructions as initial agent guidance ([openai/codex#29097](https://github.com/openai/codex/issues/29097)).

## What it does

The plugin contains a single routing skill. It does **not**:

- Start a second MCP server
- Configure an alternative database
- Duplicate the MCP declaration

The existing stdio MCP setup remains the primary integration. The skill only makes SynaptoMind visible in Codex's initial catalog so the model knows it exists before any tool call.

The plugin is independent of OpenAI Secure MCP Tunnel. ChatGPT uses the tunnel
to reach a private MCP process, while Codex uses this plugin only for routing and
discovery. Installing the plugin does not create a tunnel, start SynaptoMind, or
grant additional MCP capabilities.

## Prerequisites

- SynaptoMind MCP server already configured in Codex (stdio or HTTP)
- Codex CLI with plugin support

## Install

```bash
codex plugin add ./plugins/synaptomind
```

## Verify

1. Start a new Codex session
2. The skill catalog should list "SynaptoMind" with description "Search and save project memory, decisions, and context."
3. Ask "What did we previously decide about this project?" — Codex should load the skill and use MCP tools
4. Ask "hello" — SynaptoMind should NOT be invoked

## How it works

Codex uses progressive disclosure: the model initially sees each skill's name and description, then loads the full `SKILL.md` only when the skill is selected. The routing skill's description is written to trigger on questions about:

- Prior decisions or architecture choices
- Project context or history
- Unresolved work or next steps
- Searching memory for related discussions

It explicitly does **not** trigger on simple greetings or unrelated tasks.

## File structure

```
plugins/synaptomind/
├── .codex-plugin/
│   └── plugin.json          # Plugin metadata
└── skills/
    └── synaptomind/
        └── SKILL.md         # Routing skill instructions
```

## Troubleshooting

**Skill not appearing in catalog:**
- Verify the plugin is installed: `codex plugin list`
- Check that `plugin.json` is valid JSON
- Restart the Codex session

**Skill loads but MCP tools fail:**
- Ensure the SynaptoMind MCP server is running
- Verify the MCP server is configured in Codex (`~/.codex/config.json`)
- Check that the auth token matches

**Skill triggers on unrelated prompts:**
- The skill description may need refinement
- Edit `SKILL.md` frontmatter `description` to be more specific
