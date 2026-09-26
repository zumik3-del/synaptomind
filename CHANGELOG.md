# Changelog

## v0.8.0-beta.1

> September 26, 2026

- [`2a948bc`](https://github.com/zumik3-del/synaptomind/commit/2a948bcb39681a2dba47bc98aa2bdf28137ded17): feat(deploy): adopt bun-templates/deploy as canonical install/update framework (#856)
- [`383ff4e`](https://github.com/zumik3-del/synaptomind/commit/383ff4e29f84db19b3d922073516289c254f253b): refactor: move SQL into db layer, complete DI and telemetry coverage (#845)
- [`a823b72`](https://github.com/zumik3-del/synaptomind/commit/a823b72e905e76976c1e113d5a66a1d3c50679d0): refactor: harden core consistency per SOLID/KISS/DRY audit (#845)

## v0.8.0-beta.0

> September 26, 2026

- [`8d48aad`](https://github.com/zumik3-del/synaptomind/commit/8d48aad004721fb8e42d6b1ceb3755bdf121cfd1): chore: drop unused db re-exports and dead export surface
- [`e1a59e0`](https://github.com/zumik3-del/synaptomind/commit/e1a59e0b729e43583fa41331e4092702359acc5e): test: raise eval isolation test timeout above subprocess runtime
- [`8bd3c85`](https://github.com/zumik3-del/synaptomind/commit/8bd3c85d31a99e12db23b7a5dc1c938b8856280f): refactor: remove smart notes; fold pending surfacing into frontier (#148)
- [`0835fd9`](https://github.com/zumik3-del/synaptomind/commit/0835fd9490db18ec6a476024d8af53aede00b23b): chore: ignore scripts/quick_deploy.sh
- [`202d638`](https://github.com/zumik3-del/synaptomind/commit/202d638442f3d9bab9a05be4c7cbfd0496926856): refactor: remove dead code and unused entity-linking feature
- [`ce92e27`](https://github.com/zumik3-del/synaptomind/commit/ce92e2740f98b2aa0bd1a081025113c88c2f32d2): test: eval scenarios for relevance signals and opt-in recency boost (#143, #145)

## v0.7.3

> September 25, 2026

- [`f8300a5`](https://github.com/zumik3-del/synaptomind/commit/f8300a5c1cb92584e13a6b56d66eca078d481db3): feat: expose ranking signals and opt-in recency boost in search (#146)
- [`aa944a2`](https://github.com/zumik3-del/synaptomind/commit/aa944a27b34ffd7e723e706fb9f4a3122ad23104): feat: expose rrf/bm25 scores and match_source in search results (#144)

## v0.7.2

> September 21, 2026

- [`5aebf41`](https://github.com/zumik3-del/synaptomind/commit/5aebf414deafb2d7c3ba47b67fe28f7aa8bafb64): fix: spawn embedder via process.execPath for Windows IPC; bump to 0.7.2 (#142)
- [`f0566b9`](https://github.com/zumik3-del/synaptomind/commit/f0566b9360f165a4bc5af0fc31cab8dfcf5a5519): chore: bump adm-zip override to 0.6.1 (fixes CVE-2026-77301) (#140)
- [`f2723f8`](https://github.com/zumik3-del/synaptomind/commit/f2723f89efb192b5f1d8308316315648133ce5b6): fix(docker): publish ports reliably and clarify recall context error (#138)
- [`70f032e`](https://github.com/zumik3-del/synaptomind/commit/70f032e75dd933f20311b3c01ec7bdeaf1a620c5): fix(deploy): harden install/update paths, Docker/CI hygiene, and deploy docs (#137)

## v0.7.1

> September 16, 2026

- [`83a7040`](https://github.com/zumik3-del/synaptomind/commit/83a7040cc03db150448233a10f99e29ea45f9fe3): fix(memory): keep archived thoughts out of frontier and smart-note wake-ups (#134)

## v0.7.0-beta.0

> September 12, 2026

- [`0d09d3e`](https://github.com/zumik3-del/synaptomind/commit/0d09d3e71aa601bb6e8e119b56cf46413faaf671): fix(mcp): harden MCP architecture — telemetry, transport safety, layering (#131)
- [`7669e0b`](https://github.com/zumik3-del/synaptomind/commit/7669e0b771a491a1b10a04b967b378336cc377f8): feat(deploy): self-verifying upgrade flow and versioned synaptomind CLI (#129)

## v0.7.0-alpha.2

> September 12, 2026

- [`e232b8f`](https://github.com/zumik3-del/synaptomind/commit/e232b8faa0ddf6ee25252246e671503f25f19d16): fix(health-check): exclude archived duplicates and long prose from content finders (#128)

## v0.7.0-alpha.1

> September 12, 2026

- [`cce108c`](https://github.com/zumik3-del/synaptomind/commit/cce108c8cad9bdb7a6345748f3d6e85edcaaeb6f): fix(health-check): correct replaces_chains off-by-one; prerelease release CI (#127) (#126)

## v0.7.0-alpha.0

> September 12, 2026

- [`924aa58`](https://github.com/zumik3-del/synaptomind/commit/924aa580459ce84b27d019e48b63ff19b2bffc3b): feat: memory evaluation, contradiction edges, supersession-aware retrieval (#124) (#125)

## v0.6.1

> September 11, 2026

- [`fa2e98c`](https://github.com/zumik3-del/synaptomind/commit/fa2e98c37b24ca990153f11a6507d012581ce5ac): feat(thoughts): derive hard limit from soft limit + buffer percent (#122)
- [`36bcb53`](https://github.com/zumik3-del/synaptomind/commit/36bcb53979beb76d90b37bd3840f000e9dd1286f): docs: add hero image and rework README (#121)
- [`504fda4`](https://github.com/zumik3-del/synaptomind/commit/504fda4b6ef7b2595152cb4b12d0d90e443698c6): Update LICENSE
- [`8bcc6f1`](https://github.com/zumik3-del/synaptomind/commit/8bcc6f1c83f7e3334bcaf786e854c1368a67721c): refactor: extract canonicalTagName helper + fix MCP tool consistency (#118) (#119)
- [`844cef1`](https://github.com/zumik3-del/synaptomind/commit/844cef1302289038710f2c75389f8565c3b7509e): chore: pin secure versions of adm-zip and sharp via overrides (#117)
- [`3593391`](https://github.com/zumik3-del/synaptomind/commit/359339141076ea65a3d9f76cfc1a5fbcc5e03df0): feat: core audit backlog — P0 fixes, service layering, drift verify, embedder polish (#111-#113) (#114)

## v0.6.0

> September 6, 2026

- [`9089550`](https://github.com/zumik3-del/synaptomind/commit/9089550d94186b6b3508bedda1cd8209339ada95): fix: resolve stability audit issues — code, docs, CI (#107, #108, #109) (#110)
- [`5ce0ccc`](https://github.com/zumik3-del/synaptomind/commit/5ce0ccce15c4918056a249876aeb497ca17ad0c6): ci: fix release tags, and group release notes by commit type (#106)

## v0.6.0-beta.0

> September 6, 2026

- [`c6fb9ed`](https://github.com/zumik3-del/synaptomind/commit/c6fb9ede7c56988d5e1ec5db6824cb6826c2faed): chore(ci): group release notes by commit type
- [`8f5ac10`](https://github.com/zumik3-del/synaptomind/commit/8f5ac10c0f6a9e156c5d151f983187857fb35360): fix: handle v-prefixed tags in update.sh version comparison
- [`d45432b`](https://github.com/zumik3-del/synaptomind/commit/d45432bda92bb8f1090915e5fe281f5c2838904d): ci: use v-prefixed tags in release workflow and release script
- [`7b8d490`](https://github.com/zumik3-del/synaptomind/commit/7b8d49096b2597a2a6b3c884a8dc6fa16544f45d): refactor: architecture revision — 16 fixes across SOLID, type safety, layers (#104)
- [`fe7aa7f`](https://github.com/zumik3-del/synaptomind/commit/fe7aa7fedbf0d54b4d18ca206efd165c9f5fceb4): refactor: core layer cleanup — domain types, validation, DI, search facade (#103)
- [`1aee757`](https://github.com/zumik3-del/synaptomind/commit/1aee757678be3f00f356db81be19b26722412e4b): test: add release artifact smoke test for MCP round-trip (#101)
- [`ed9fe8d`](https://github.com/zumik3-del/synaptomind/commit/ed9fe8dc11d0f740c67862b0849b8d4051907705): feat: harden install script with auto deps, health verification, and alpha updates (#99)
- [`8f0c5e9`](https://github.com/zumik3-del/synaptomind/commit/8f0c5e90d72a1e2dae9c796084d07cf123f3c0d0): docs: simplify quick start with one-line install (#97)
- [`b402131`](https://github.com/zumik3-del/synaptomind/commit/b4021312132004fec7b0f5f9ff0508b743af9955): feat: add one-line install script (#96)
- [`767d4c1`](https://github.com/zumik3-del/synaptomind/commit/767d4c16086d63f26d49749d541413b181d2c8de): feat: add AI-native authoring rules to MCP instructions (#95)

## v0.6.0-alpha.0

> September 6, 2026

- [`9213528`](https://github.com/zumik3-del/synaptomind/commit/9213528ea0e1c0e95772f561a682742b197d5477): feat: ai-native thought authoring and memory-behavior rules in MCP instructions (#93)
- [`9d3423a`](https://github.com/zumik3-del/synaptomind/commit/9d3423a165807462149d59ab1850c472b10e9025): feat: is_protected flag to prevent auto-deletion (#87)
- [`b7be84c`](https://github.com/zumik3-del/synaptomind/commit/b7be84c80205850c1a5fedfb5b1230f96e212bfa): fix: create replaces edge on merge (#88)
- [`7446214`](https://github.com/zumik3-del/synaptomind/commit/744621490e5befb2e674efe044e63facd57a05f4): feat: mcp tests, atomicity, ttl cleanup (#86)
- [`d323ad8`](https://github.com/zumik3-del/synaptomind/commit/d323ad8a3d00565471a750b3ba44b55fe2adbe63): docs(plugins): add Secure MCP Tunnel setup (#81)
- [`1cfb6c1`](https://github.com/zumik3-del/synaptomind/commit/1cfb6c1ff481dfe8d758f231966dd4318ed3b3f1): fix: production readiness — merge signature, archive idempotent, embedder hash check (#85)
- [`d73a92d`](https://github.com/zumik3-del/synaptomind/commit/d73a92d2189873b0d76ac09ee46be899601f3a67): test: real MCP tool contract tests (#84)
- [`8799eac`](https://github.com/zumik3-del/synaptomind/commit/8799eac96fd402131d035ee015e3118fd61a907f): fix(search): scoped retrieval and scope fail-open (#75) (#79)
- [`34229b1`](https://github.com/zumik3-del/synaptomind/commit/34229b12b625a7c4b7abf3c7a385da08608c8309): fix: audit #74 — merge args, idempotent archive, content_hash, depends_on, CI, stdio (#78)
- [`3d7c936`](https://github.com/zumik3-del/synaptomind/commit/3d7c93671f377007ea0afb95f4ef0824f8998728): feat: bulk import, embedder toggle, configurable rate limit & busy timeout (#73)
- [`3147088`](https://github.com/zumik3-del/synaptomind/commit/31470887167711e65047dd0de6024924cba30764): refactor: mcp tool improvements — handler maps, parameter descriptions, git removal (#70)
- [`6323ad1`](https://github.com/zumik3-del/synaptomind/commit/6323ad18e1bd42941f3cbfa53071b11fbccf7f2a): refactor: remove git commits storage mechanism (#67) (#68)
- [`db7b9fe`](https://github.com/zumik3-del/synaptomind/commit/db7b9fe8cf7d07490de94732e5ce6cc5836ca02d): fix(graph): cap edge expansion degree in getThoughtEdges (#59) (#66)
- [`8706b47`](https://github.com/zumik3-del/synaptomind/commit/8706b472f2497bfaa4e75303fb631821fb9e0dda): feat(db): add content-hash deduplication on thought creation (#58) (#65)

## v0.5.0

> September 5, 2026

- [`6d25796`](https://github.com/zumik3-del/synaptomind/commit/6d257963548489c7c09c8871ed83a7398e80f915): fix: remove v prefix from release tags
- [`0c26d84`](https://github.com/zumik3-del/synaptomind/commit/0c26d84dc013e3d15ff3897e59967c7f18ea5f3e): docs: clean CHANGELOG.md for v0.5.0
- [`41b1d99`](https://github.com/zumik3-del/synaptomind/commit/41b1d99d8f3d58ba3f8801d204ffa250fae1bbd0): fix: use --no-verify in changelog commit
- [`e23a1bb`](https://github.com/zumik3-del/synaptomind/commit/e23a1bba2f34ef407e151ec391d04992a9ccf1a9): fix: quote git log format strings in changelog.cjs
- [`931889e`](https://github.com/zumik3-del/synaptomind/commit/931889e3bf58f3b04635ac88df1796d2c902d4b9): fix: rename changelog.js to .cjs for ES module compatibility
- [`7adafc5`](https://github.com/zumik3-del/synaptomind/commit/7adafc56c7559235f518024d4f87c2ce70323b53): chore: migrate from release-please to manual release workflow
- [`a0e8bfd`](https://github.com/zumik3-del/synaptomind/commit/a0e8bfd0f17c8fda1ded2db73f56a06b1312fc1a): ci: remove duplicate release.yml workflow
- [`daf32a8`](https://github.com/zumik3-del/synaptomind/commit/daf32a854f67cc05fb4285ea049a01b8a1a1282c): chore(main): release synaptomind 0.5.0 (#62)
- [`d847443`](https://github.com/zumik3-del/synaptomind/commit/d84744396cdd8fe801131cecf793bc9b16e7557f): refactor: consolidate 37 MCP tools into 10 unified operations (#61)

## v0.4.0

> September 4, 2026

- [`a522d4b`](https://github.com/zumik3-del/synaptomind/commit/a522d4bbd155b121380756a0b6a40e332d111ad8): chore(main): release synaptomind 0.4.0 (#55)
- [`748cdb4`](https://github.com/zumik3-del/synaptomind/commit/748cdb425527aef00f6cd4d8f90d83b93f4434e9): chore: bootstrap release-please config on main (manifest at 0.3.1) (#54)
- [`2781a9b`](https://github.com/zumik3-del/synaptomind/commit/2781a9baeebc684b6a2f3ffe75f58bcacb4a45a6): chore: release 0.4.0 (#52)
- [`54c786c`](https://github.com/zumik3-del/synaptomind/commit/54c786ce55d90b9f88484c90aaa3c861fefc8011): docs(readme): restructure for conversion — hero, comparison table, folding sections (#50)
- [`5f43987`](https://github.com/zumik3-del/synaptomind/commit/5f43987d7a6e8f9c1b8d097031c99296f87a7caa): ci: extract release version via gh cli (#49)

## v0.3.1

> September 4, 2026

- [`b7c7f2b`](https://github.com/zumik3-del/synaptomind/commit/b7c7f2b8f4ff34b09feb83c4a2de5917751f66f8): chore(main): release synaptomind 0.3.1 (#48)
- [`cd9af1e`](https://github.com/zumik3-del/synaptomind/commit/cd9af1e33637134fa9d64c0f8122b03b029c8590): fix: correct release-please version output and rename CI workflow (#47)
- [`7dfeabc`](https://github.com/zumik3-del/synaptomind/commit/7dfeabc9754f5710ba2ffb882191465a4aec3bd4): ci: upload coverage only on main (#46)
- [`c2e6028`](https://github.com/zumik3-del/synaptomind/commit/c2e602864f4ee626829e16fdf3b97aab722e63e7): ci: run coverage on push to main (#45)
- [`e9c2f5b`](https://github.com/zumik3-del/synaptomind/commit/e9c2f5b2653284ec4bd5e3c98d62cd579af6fca1): ci: switch from Codecov to Coveralls (#44)
- [`3cd9be7`](https://github.com/zumik3-del/synaptomind/commit/3cd9be77d3bfe1ef59a9e7dc3b4ce3e01baef953): ci: generate lcov report for Codecov upload (#43)
- [`ac2a5a4`](https://github.com/zumik3-del/synaptomind/commit/ac2a5a4447a74fc750cd375f9e22d6c03de38f5a): ci: add test coverage reporting with Codecov (#42)
