# Contributing to SynaptoMind

Thanks for your interest in contributing! This document explains how to get started.

## Code of Conduct

This project follows the [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md). By participating, you agree to uphold it.

## How to Contribute

### Reporting Bugs

1. Check [existing issues](https://github.com/zumik3-del/synaptomind/issues) to avoid duplicates.
2. Open a new issue with:
   - Clear title and description
   - Steps to reproduce
   - Expected vs actual behavior
   - Your environment (OS, Bun version, etc.)

### Suggesting Features

Open an issue with the `enhancement` label. Describe the problem you want to solve and your proposed solution.

### Submitting Changes

1. Fork the repo and create a feature branch from `main`.
2. Make your changes following the code conventions below.
3. Run `bun test` to make sure tests pass.
4. Run `bunx biome check src/` for lint (advisory, not blocking).
5. Open a pull request against `main` with a **Conventional Commit title** (see below).
6. PRs are squash-merged — the PR title becomes the commit message on `main`.

## Commit Convention

This project uses [Conventional Commits](https://www.conventionalcommits.org/). The PR title (used as the squash-merge commit message) must follow this format:

```
<type>(<optional scope>): <description>
```

### Allowed types

| Type | Version bump | When to use |
|------|-------------|-------------|
| `fix` | patch (`0.2.0 → 0.2.1`) | Bug fix |
| `feat` | minor (`0.2.0 → 0.3.0`) | New feature |
| `feat!` / `BREAKING CHANGE:` | major (`0.2.0 → 1.0.0`) | Breaking change |
| `chore`, `docs`, `refactor`, `test`, `ci`, `build` | none | Maintenance |

### Examples

- `fix: crash on empty database`
- `feat: add thought clustering`
- `feat!: redesign MCP protocol`
- `chore: update dependencies`
- `docs: add installation guide`

### Invalid

- `Fixed bug` (not imperative mood)
- `✨ Added feature` (emoji, not conventional)
- `update stuff` (no type prefix)

## Code Conventions

- **SOLID, KISS, DRY** — apply where it matters, skip where it doesn't.
- **TypeScript strict** — no `any` unless unavoidable.
- **Functions do one thing**, files are short, names are clear.
- **Tests alongside source** — `.test.ts` suffix, same directory.

## Project Structure

```
src/
  api/          HTTP routes (Hono)
  config/       Configuration loading
  db/           SQLite schema, migrations, queries
  mcp/          MCP server + tools
  services/     Business logic
```

## Development Setup

```bash
bun install
bun test                    # run tests
bunx biome check src/       # lint
bun run dev                 # start dev server
```

## Pull Request Guidelines

- Keep PRs focused on a single change.
- Reference related issues (e.g., `closes #12`).
- Describe what changed and why.
- Ensure CI passes before requesting review.
