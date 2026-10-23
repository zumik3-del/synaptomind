# Thought Scenarios

## Scenario 1: Creating a New Project

```
1. memory_manage(action=create, name="my-app", description="Project description", local_path="/path/to/project")
   → project created, bound to a local path

2. memory_status(action=slots, cwd="/path/to/project")
   → agent sees the project and its context via cwd
   → project_id resolves automatically

3. memory_reflect(
      action=reflect,
      summary: "Project created. Stack chosen, core modules defined.",
      goals_add: ["MVP API", "IDE plugin", "CLI utility"],
      decisions: ["PostgreSQL for storage", "Fastify as HTTP framework"],
      cwd="/path/to/project"
    )
    → project context is persisted
    → goals and decisions available via memory_status(action=slots)
    → next: create todo/directive thoughts to populate frontier
```

## Scenario 2: Session Start — Context Loading

```
Agent boots → memory_status(action=slots) →
  pending_items (due pending thoughts),
  architecture_decisions (from primers),
  project_context (previous reflections),
  active_goals
→ understands what was decided before and what's on the queue
```

## Scenario 3: Working on a Task

```
1. memory_recall(action=search, "how we did X") → find existing thoughts, avoid duplicates
2. memory_store(action=create, "decided to use Y", tags=["decision"]) → record the decision
3. memory_store(action=link, thought_id=new_thought, target_id=existing, edge_type="develops") → grow the graph
4. memory_store(action=create, "need to do Z", tags=["todo", "pending"]) → plan the next step
```

## Scenario 4: Sleeping Thoughts (Deferred Surfacing)

```
memory_reflect(action=reflect, pending=["write auth tests", "update docs"], wake_days=7)
  → each pending thought is created as a draft tagged `pending` + `reflect`
    with surface_after = now + 7 days
  → nothing surfaces for 7 days...
  → once due, the thought appears in the frontier (reason `pending`)
    and in the pending_items slot
  → it stays a draft until the agent acts on it (activate or archive)
```

## Scenario 5: Task Completion — Reflection

```
memory_reflect(
  action=reflect,
  summary: "Auth module refactoring complete. JWT replaced with sessions.",
  goals_remove: ["auth refactoring"],
  goals_add: ["migrate to sessions"],
  decisions: ["Use server-side sessions instead of JWT", "Redis for session storage"],
  pending: ["Load test sessions", "Update API docs"],
  wake_days: 14
)
```

What happens inside:
- `summary` → appended to `project_context` slot (with timestamp)
- `goals_add` → adds entries to `active_goals`; `goals_remove` removes stored goal lines
  matching case-insensitively by substring
- `decisions` → creates **active** thoughts with tags `decision` + `reflect` (knowledge graph, not in frontier — frontier only surfaces `directive`/`todo`/`pending` thoughts)
- `pending` → creates **draft** thoughts with tags `pending` + `reflect` and `surface_after = now + wake_days` (they join the frontier once due)

The `reflect` tag marks every thought reflect created, so reflect output can be filtered or
cleaned up without touching hand-created thoughts.

## Scenario 6: Frontier — What to Do Next

```
memory_status(action=frontier)
  → candidates: active/draft thoughts tagged directive, todo or pending
    whose surface_after delay has elapsed (or is unset)
  → excluded: clusters, thoughts replaced by a `replaces` edge, and legacy
    `profile-summary` sourced rows
  → priority = 0.5·importance + 0.15·unblocked + age bonus
    (age ≤ 7d: +0.1, ≤ 30d: +0.05, else 0)
  → depends_on: blocked items lose the 0.15 unblocked bonus but still surface with lower priority and blocked_by metadata
```

## Scenario 7: Grouping and Cluster Maintenance

```
memory_crystallize(action=auto_cluster) → similar thoughts grouped into clusters (Union-Find)
memory_crystallize(action=graph) → inspect thoughts and edges
memory_crystallize(action=cluster) → create a cluster thought from thought_ids

contradiction_in_cluster remediation (memory_status(action=health)):
  memory_store(action=unlink) on the contradicts edge — preview, then confirm=true
  memory_store(action=retype, new_type="supports") — preview, then confirm=true
  memory_supersede(action=archive) on the cluster thought — members are untouched
```

Cluster membership needs no dedicated action: the `cluster` edges are ordinary edges,
so `memory_store` `link`/`unlink` add and remove members.

## Scenario 8: Self-Cleanup

```
decay job → importance decreases by rate (0.95) every 24h
  → nothing else: decay never archives a thought

archiving → explicit only (memory_supersede(action=archive) or status=archived)
  → deletion of archived thoughts is handled by retention-review (sole deletion path)

search path → promotes frequently-hit thoughts to primers once hit_count reaches
              primer.promoteThreshold (default 5)
```

`exclude_flagged` is an ordinary query parameter: HTTP search and MCP recall
search/clusters ignore it (it is no longer part of the MCP schema), so previously
flagged thoughts may appear in default search results. Removals from earlier
releases, including the retired verification job and its data, are listed in
[CHANGELOG.md](../CHANGELOG.md).

---

**Key idea:** thoughts are not static records — they are living objects with status `draft → active → archived`, importance that decays, and pending deferrals that control *when* a thought becomes relevant. Reflection is the point where an agent records decisions and defers future tasks. The frontier is a deterministic answer to "what to do now".
