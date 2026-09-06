---
name: synaptomind
description: >-
  Use when the user asks about prior decisions, project context, past
  discussions, unresolved work, or what to do next. Also use when the user
  references previous conversations, architecture choices, or wants to search
  project memory. Do not use for simple greetings, unrelated tasks, or when
  the user has not mentioned anything about past work or context.
---

# SynaptoMind — Persistent Project Memory

SynaptoMind is a thought-graph engine that remembers decisions, context,
architecture choices, and unresolved work across sessions. It is available as
an MCP server with 9 tools. This skill routes you to the right tools.

## When to use this skill

Activate when the user's request involves:

- Past decisions or architecture choices ("what did we decide about...")
- Project context or history ("what do we know about...")
- Unresolved work or next steps ("what should I work on next...")
- Searching memory for related discussions ("have we discussed...")
- Saving a new decision or conclusion ("remember that we decided...")
- Linking related thoughts or finding prior context

Do **not** activate for:

- Simple greetings ("hello", "hi")
- Tasks unrelated to project memory
- Direct code edits or file operations

## How to use SynaptoMind

### 1. Load project context

At the start of a session, call `memory_status` (action=slots) to understand
current goals, pending work, and past decisions. If slots are empty, this is
a new project.

### 2. Search before answering

Before answering questions about the project, architecture, or past decisions,
search SynaptoMind first. Use `memory_recall` (action=search),
`memory_recall` (action=context), or `memory_recall` (action=clusters) to
check if this was discussed before. Do not guess when you can look it up.

### 3. Save when decisions are made

When the conversation reaches a conclusion, a decision is made, a problem is
solved, or an idea comes up, save it. First search for existing knowledge with
`memory_recall` to avoid duplicates. Then choose the right operation:
- **create** for genuinely new knowledge
- **update** when existing knowledge has materially evolved
- **merge** when multiple thoughts represent the same knowledge
- **archive** when knowledge is no longer current
- **link** when a relationship between thoughts carries useful information

### 4. Find what to do next

When the user asks what to work on next, or when you finish a task and are
unsure what comes next, use `memory_status` (action=frontier).

## Important notes

- **Thought quality:** Store durable knowledge, not conversation transcripts. Write one
  independently useful semantic unit per thought. Make content self-contained so it is
  understandable outside the source conversation. Preserve epistemic state — do not turn
  hypotheses into facts or proposals into decisions.
- Always pass the `cwd` parameter (current working directory) so SynaptoMind
  auto-resolves the correct project. Do not hardcode `project_id`.
- If SynaptoMind is unavailable (MCP server not running), say so explicitly.
  Do not treat a missing server as empty memory.
- If you find duplicate or outdated thoughts, merge them with
  `memory_supersede` (action=merge).
- If a thought's content has changed, update it with `memory_store` (action=update).
