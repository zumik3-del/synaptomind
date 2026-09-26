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
      goals_delta: ["MVP API", "IDE plugin", "CLI utility"],
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
  sees persona (from profile thoughts),
  active_goals,
  project_context (previous reflections),
  pending_items (due pending thoughts),
  architecture_decisions (from examples)
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
  → each pending thought is created as a draft tagged `pending`
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
  goals_delta: ["closed:auth refactoring", "migrate to sessions"],
  decisions: ["Use server-side sessions instead of JWT", "Redis for session storage"],
  pending: ["Load test sessions", "Update API docs"],
  wake_days: 14
)
```

What happens inside:
- `summary` → appended to `project_context` slot (with timestamp)
- `goals_delta` → updates `active_goals` (new ones added, `closed:` — removed)
- `decisions` → creates **active** thoughts with tag `decision` (knowledge graph, not in frontier — frontier only surfaces `directive`/`todo`/`pending` thoughts)
- `pending` → creates **draft** thoughts with tag `pending` and `surface_after = now + wake_days` (they join the frontier once due)

## Scenario 6: Frontier — What to Do Next

```
memory_status(action=frontier)
  → candidates: active/draft thoughts tagged directive, todo or pending
    whose surface_after delay has elapsed (or is unset)
  → excluded: clusters, crystals, profile summaries, replaced thoughts
  → priority = 0.5·importance + 0.15·unblocked + age bonus
    (age ≤ 7d: +0.1, ≤ 30d: +0.05, else 0)
  → depends_on: blocked items lose the 0.15 unblocked bonus but still surface with lower priority and blocked_by metadata
```

## Scenario 7: Grouping and Compression

```
memory_crystallize(action=auto_cluster) → similar thoughts merged into clusters (Union-Find)
memory_crystallize(action=crystallize, cluster_id=..., style="runbook") →
  cluster compressed into markdown: Procedure + Gotchas + Open questions
  → crystal thought created (source="crystal"), excluded from frontier
```

## Scenario 8: Profile (Persona)

```
memory_store(action=create, "Prefer TypeScript", is_profile=true, tags=["@profile", "@profile-preferences"])
memory_store(action=create, "Work at night", is_profile=true, tags=["@profile", "@profile-work"])
  → these thoughts are never archived
  → summarizer groups by @profile-* subtags
  → persona slot = profile summary → available to agent via memory_status(action=slots)
```

## Scenario 9: Self-Cleanup

```
decay job → importance decreases by rate (0.95) every 24h
  → importance < 0.1 + age > 30 days + active → auto-archive

thought_verify → re-embeds content, flags drift (cosine distance > driftThreshold) or staleness (> staleWarnDays)

self-improve → detects:
  orphan_writes → thoughts created without project binding (advisory only)
  low_activation_rate → many drafts, few promotions (auto-promotes old drafts)
  zero_clusters → no clusters with a large thought count (auto-triggers clustering)
  → some checks auto-fix, others recommend manual review
```

---

**Key idea:** thoughts are not static records — they are living objects with status `draft → active → archived`, importance that decays, and pending deferrals that control *when* a thought becomes relevant. Reflection is the point where an agent records decisions and defers future tasks. The frontier is a deterministic answer to "what to do now".
