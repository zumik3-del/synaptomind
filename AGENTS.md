# SynaptoMind

## 1. Overview

Thought-graph engine. Capture, link, cluster, retrieve thoughts via HTTP API or MCP.
Bun + Hono + SQLite (vec0 + FTS5); local embeddings via `@huggingface/transformers`.

## 2. Stack & toolchain

- Runtime: Bun (latest stable); TypeScript strict (no `any` unless unavoidable)
- DB: SQLite via `bun:sqlite` (vec0 vector search + FTS5)
- API: Hono (HTTP :3005) + MCP server (stdio + HTTP :3006)
- Embeddings: `@huggingface/transformers` in a child process (IPC)
- Lint: Biome (`bunx biome check src/`) — advisory; hooks: Husky + commitlint
- `bun`/`bunx` in `~/.bun/bin`, symlinked to `/usr/local/bin` (already on PATH)

## 3. Verification

- tests: `bun run test` (`bun test src`, canonical "done" gate); full suite via `bun run test:all`
- lint (advisory): `bunx biome check src/`
- typecheck: `bun run tsc --noEmit`

## 4. Code conventions

- SOLID, KISS, DRY where they matter; one thing per function; files ≤350 lines; clear names
- Tests alongside source (`*.test.ts`)

**Database DI.** Exported service functions take `d: Database = getDb()` as trailing param;
`getDb()` is called nowhere else in `services/`. db-layer functions take `db: Database` as required
first param. Inside `d.transaction(...)` pass `d` to every call. Tests: `beforeEach(createTestDb)`;
pass `db` only for specific instances (file-backed DB for vec0). Never mock `Database`.
Two documented deviations resolve the connection lazily inside the body, because the callers run
before `initDb()` or must observe db unavailability instead of throwing:
`settings.service.ts getAdvertisedSoftLimitService(d?)` and `health.service.ts getHealthService(d?)`.
Test-only fixtures live in `src/test/` — never in `services/`, where a `bun:test` import would pull
into the production path.

**Layering.** `api/mcp → services → db`; routes stay thin (parse/serialize only, validation +
orchestration in services). Error classes in `src/errors.ts` (neutral, cycle-free).

## 5. Testing setup

- Helpers: `src/test/helpers.ts` — `createTestDb()`, `seedThought()`, `seedEdge()`, `seedEmbedding()`
- Fresh DB per suite: `beforeEach(createTestDb)`
- Glob: `*.test.ts` runs; `*.suite.ts` is excluded (isolated subprocess suites)
- Gotchas → §8

## 6. Branching, release & deploy

- Repo `zumik3-del/synaptomind` (GitHub): `main` (stable, release target), `dev` (active dev);
  author `zumik3-del <zumik3@gmail.com>`
- CI on PRs and pushes to `main`; `dev` → `main` PRs are merged with a **merge commit**, never
  squash (rationale → §8)

**Flow:** work on `dev` → push `origin/dev` → back-merge `main` into `dev` → open PR `dev` → `main`
→ **the user** merges with a merge commit (agents never merge PRs, §9) → back-merge `main` into `dev`
(never reset/force-push): `git fetch origin main:main` → `git merge origin/main` → `git push origin dev`.

**Commits:** [Conventional Commits](https://www.conventionalcommits.org/); PR titles become the
merge-commit subject and must be `<type>(<scope>): <desc>`
(`fix`/`feat`/`chore`/`docs`/`refactor`/`test`/`ci`/`build`; `feat!:` or `BREAKING CHANGE:` = breaking).
No `Fixed bug`/`update stuff`/emoji-only.

**Release:** on a clean `dev`, `bash scripts/release.sh <version>` (validates semver, bumps
`package.json`, regenerates `CHANGELOG.md`; no tag/commit/push) → commit
`chore: bump version to <version>` → push → open release PR `dev` → `main` → user merges. The push to
`main` triggers `.github/workflows/release.yml`: `detect` (only if the version changed and
`v<version>` is absent; `-` = prerelease) → `verify` (`bun install --frozen-lockfile`, `tsc`,
`bun test`) → `release` (tag + GitHub Release) + parallel `publish-docker` (ghcr; not gating).
Commit types group notes into Features / Fixes / Other.

**Deploy (`deploy/`)** — the supported install path; full guide in `docs/DEPLOY.md`, values in
`deploy/app.env` (source of truth). Install `sudo bash deploy/install.sh`; update
`bash ${HOME}/.synaptomind/scripts/update.sh [--version TAG] [--yes]` (backs up each DB, restarts the
unit, polls `/health`); channel via `CHECKOUT_POLICY` (`stable`/`latest`/`prerelease`/branch).
Rollback is never automatic: restore the pre-update DB backup, then check out the printed revision
(migrations are forward-only).

## 7. Memory conventions

- Project slug `synaptomind`; always pass `cwd`
- Common tags: `decision`, `fact`, `gotcha`, `testing`, `architecture`
- Durable knowledge ≤600 chars → `memory_store` (orchestrator only); search first
  (`memory_recall` search, `limit=5` — `top_k` was removed in 0.20 and is rejected
  by the schema)

## 8. Known pitfalls & test gotchas

- **vec0 + `:memory:`** — vec0 unavailable; use a file-backed DB or a manual `vec_thoughts` table
  (`thought_verify.service.test.ts`).
- **`bun:sqlite` typing** — mixing string/number bindings → "datatype mismatch" (esp. `LIMIT`); use
  consistent types or `Math.floor`-guarded interpolation.
- **`bun test` output** — writes to STDERR; file filters need a `./` prefix.
- **`mock.module` leakage** — `bun:test`'s `mock.module` leaks through `export *`. Run such suites
  isolated: unmocked specifier (`client-core.ts`), suite without `.test`, wrapper spawns
  `bun test ./src/embedder/client.suite.ts`. `thought_verify.service.test.ts` /
  `auto-link.service.test.ts` log expected `console.error` — intentional.
- **Live prod shares the dev host** — `synaptomind` (3105/3106) runs on the same machine, and `sudo`
  keeps its own `PATH`, so stubbing `systemctl` via `PATH` does NOT intercept it. Never call real
  `sudo`/`systemctl` from a scratch demo — neutralize them in a copied tree (or a container).
- **Piped install needs the shared helper on `main`** — `deploy/install.sh` in `curl | bash` mode
  fetches `deploy/lib/common.sh` from the `main` raw URL, so both must land on `main` together.
- **Prod runs as the same unprivileged user as the agents** — `synaptomind` runs as `opencode`, so
  any agent-owned process can `kill` it with no privilege; `Restart=on-failure` won't restart a clean
  exit and the handler records no signaller. Never signal outside your scratch root, never
  `pkill`/`killall` by name, verify stubs intercept. Restore: `sudo systemctl start synaptomind`
  (DB survives; shutdown checkpoints the WAL).
- **Agent scratch shares prod's filesystem** — `/tmp/opencode` is on `/`, same as
  `/var/lib/synaptomind`; a full `/` breaks agents' tool outputs and prod's DB writes. Copy mutants
  **without** `node_modules`, clean `/tmp/opencode/*` between tasks. A full disk reads as *empty tool
  output* (`df -h /` first); `/health: embedder "not ready"` with no child is the designed idle
  unload — never signal it.
- **Squash-merge + back-merge grows a phantom PR commit list** — with a long-lived `dev`,
  squash-merge then back-merge leaves already-merged commits reachable from `dev` but not `main`, so
  `git rev-list main..dev` (GitHub PR commit count) grows every release (2026-10-07 PR #177: 80
  commits vs an 11-file diff; the diff was always correct). Fix: merge `dev` → `main` with a merge
  commit (§6). Never reset/force-push `dev`.

## 9. Delegation map

- **architect** — architecture audits, design, ADRs
- **analyst** — requirements analysis, epic decomposition, acceptance criteria (specs → `plan` artifacts)
- **developer** — implementation, refactoring, bugfixes (no commits)
- **tester** — test writing, runs, audits
- **devops** — CI, Docker/compose, deploy (asks before destructive actions)
- **git** — commits, pushes, PRs, issues (no merge/close PRs, no direct pushes to `main`; dev sync =
  back-merge `origin/main`, never reset/force-push)
- **docwriter** — README, docs, ADRs, changelogs, docstrings

**Defer rules:** commits/pushes → `git`; tests → `tester`; never merge/close PRs (the user does);
never close issues unless asked; follow `.github/ISSUE_TEMPLATE/`; never commit secrets.

## 10. Workspace & communication

- Documents → the Forgejo artifacts repository `authelia/artifacts` under `synaptomind/`,
  through the `forgejo_artifacts` MCP tools (`project: synaptomind`, `plan` for analyst specs,
  `adr`/`draft` for design docs). Pre-2026-10 documents were imported into this repository on
  2026-10-16 (`tasks/` + `result-*.md` were pre-tracker legacy and were not imported —
  the tracker is the only task channel.)
- Code → repo `/mnt/external/zum/PROJECTS/remote/synaptomind/`
- Plan/design artifacts → artifacts repo; ephemeral state ≤600 chars → SynaptoMind memory
