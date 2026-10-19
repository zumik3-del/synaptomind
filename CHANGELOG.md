# Changelog

## v0.14.0

> October 19, 2026

- [`806ecc0`](https://github.com/zumik3-del/synaptomind/commit/806ecc0d4c8543300013740b6878b5e6d14b4bc1): docs(agents): update canonical test command after suite split
- [`3f2553e`](https://github.com/zumik3-del/synaptomind/commit/3f2553eff89dfe07bd5fad19a24948ead8b6ffab): chore(test): split canonical and extended test commands
- [`c5601f4`](https://github.com/zumik3-del/synaptomind/commit/c5601f464157bb767eb075f057c7cad3ace93bec): test(eval): stabilize datasets behaviour test under full suite load
- [`143099e`](https://github.com/zumik3-del/synaptomind/commit/143099e6fd42d020d7393e1a877dc59af3ddbba2): feat(memory)!: retire crystals and thought verification

## v0.12.1

> October 19, 2026

- [`5d32f76`](https://github.com/zumik3-del/synaptomind/commit/5d32f76af763e3077a9fd351557e9e2710b131b9): test(api): align proposal error assertion
- [`ac56042`](https://github.com/zumik3-del/synaptomind/commit/ac560427f0c29dab73da2d00cf7b17b7dab8fa1e): fix(api): resolve auto-cluster schema merge
- [`c05eecf`](https://github.com/zumik3-del/synaptomind/commit/c05eecfb7d31c5092ed17ef62e1f3347754a8cd1): test(api): cover optional body validation
- [`7c090c2`](https://github.com/zumik3-del/synaptomind/commit/7c090c24af9414e67a9801ea8423af75afda9815): fix(api): bound auto-cluster options
- [`67e1c1d`](https://github.com/zumik3-del/synaptomind/commit/67e1c1d79b51b45a7b0a1492caccdf78d39939ec): fix(api): validate optional request bodies
- [`ba3bb3c`](https://github.com/zumik3-del/synaptomind/commit/ba3bb3cd6ab5e60822c26f6f9062901b1d7458b3): test(api): pin residual M8 body/limit validation (#1790)
- [`3a792a8`](https://github.com/zumik3-del/synaptomind/commit/3a792a8491617235a6c341740a191901e4a20b54): feat(api): close residual M8 raw-body/limit paths (#1783, fix #1795)
- [`ca3dfc2`](https://github.com/zumik3-del/synaptomind/commit/ca3dfc2b73254a470becaf3130cfaadba9f93a9b): test(api): pin request contract + null-body/offset fixes (#1781, #1789)
- [`1e89d62`](https://github.com/zumik3-del/synaptomind/commit/1e89d628cbbef07bdf1c0032667a465ff812e8ca): feat(api): shared request contract, malformed body -> 400 (#1758, fix #1787)
- [`0be1f69`](https://github.com/zumik3-del/synaptomind/commit/0be1f69b5e7582cb3a193caf89ec98bb61ea2122): test(embedder): prove superseded child stays inert (#1785)
- [`a99e0f7`](https://github.com/zumik3-del/synaptomind/commit/a99e0f7028d979e6c7b23f6d438ef3f4be21d46e): fix(embedder): guard superseded children with a per-spawn generation token (#1784)
- [`c7f12a9`](https://github.com/zumik3-del/synaptomind/commit/c7f12a9b800476cd36d093e6ea41633517c711d7): test(docs): cover deploy/ and docs/adr/ lint cases
- [`73b47ed`](https://github.com/zumik3-del/synaptomind/commit/73b47ed671878df6cfbf5dbc67ec67da7d6cfe17): chore(docs): widen doc-ref lint to deploy/ and repair deploy ADR links (#1780)
- [`69e0cd4`](https://github.com/zumik3-del/synaptomind/commit/69e0cd46509761901f61670109a244c4c177ce04): test(embedder): cover EmbedderUnavailableError paths (#1778)
- [`c9bf8f8`](https://github.com/zumik3-del/synaptomind/commit/c9bf8f86805d886874e3375974c5bb2308f2dcd7): fix(embedder): type idle/crash/teardown reject paths as 503 (#1773)
- [`60a39eb`](https://github.com/zumik3-del/synaptomind/commit/60a39eb97b302567913f05b5d04c48acbb317739): docs: document the MCP result and error envelope (#1774)
- [`9cf9769`](https://github.com/zumik3-del/synaptomind/commit/9cf976911708f4ce732910d02bf6551d3a9e177a): ci: run the doc-ref lint (bun run lint:docs) in CI (#1777)
- [`230eff9`](https://github.com/zumik3-del/synaptomind/commit/230eff91a0aac490726ba5e484c6ca95bb70ee68): test(docs): pin the ai-workdir doc-ref lint (#1775)
- [`b1ccac7`](https://github.com/zumik3-del/synaptomind/commit/b1ccac701c9725958209ac9de9f87070880166e6): docs: repair dead ADR links and add offline doc-ref lint (#1757)
- [`69d5692`](https://github.com/zumik3-del/synaptomind/commit/69d5692ed47cd152f5cb29b6f80a5bba936029a3): test(embedder): cover typed 503 + MCP retryable envelope (#1768)
- [`22117d9`](https://github.com/zumik3-del/synaptomind/commit/22117d9c6a3585b5ff535337158e9feafe4a8e25): feat(embedder): typed 503 errors + retryable MCP envelope (#1756)
- [`99be78b`](https://github.com/zumik3-del/synaptomind/commit/99be78b10e23c07d640ebe627f07504346a08f3b): test(logging): assert LogStore retry after failed migration (#1771)
- [`4a92b25`](https://github.com/zumik3-del/synaptomind/commit/4a92b258ad400f707027ac849222f066fbd1af9a): fix(logging): reset poisoned LogStore handle after a failed migration (#1770)
- [`cd53e68`](https://github.com/zumik3-del/synaptomind/commit/cd53e68fcb57c7ead7a64deb62b2c831446114de): test(telemetry): parity + window/limit coverage (#1763)
- [`2741115`](https://github.com/zumik3-del/synaptomind/commit/2741115e88917a27c0bed200ef2a6a32cdc2357f): refactor(telemetry): single query service for HTTP and MCP (#1755)
- [`c6c8512`](https://github.com/zumik3-del/synaptomind/commit/c6c8512ba98c2f09bf20768aa1c4634537668c1c): test(db): db-level coverage for findUntriagedDrafts (#1765)
- [`a36672a`](https://github.com/zumik3-del/synaptomind/commit/a36672a77c19423909922018336d3472339a0b4d): test(logging): cover versioned logs.db migration policy (#1766)
- [`3ecbf4e`](https://github.com/zumik3-del/synaptomind/commit/3ecbf4ea180288934efc2d69ac8d40b3556f4a88): feat(logging): version logs.db schema with micro-migrations (#1752)
- [`e0ab25f`](https://github.com/zumik3-del/synaptomind/commit/e0ab25fb35b21ba90675c3e9b628241f01c91b2e): refactor(db): move findUntriagedDrafts into placement-proposals (#1754)
- [`0d2e554`](https://github.com/zumik3-del/synaptomind/commit/0d2e5541a63dbae20db1ce828374efd9c8a3d029): refactor(embedder): consolidate IPC contract into ipc-protocol.ts (#1753)
- [`90ac56d`](https://github.com/zumik3-del/synaptomind/commit/90ac56d92785cd886450521edceb836fb6114cec): test(db): regression coverage for migration apply+stamp atomicity (#1759)
- [`16a4729`](https://github.com/zumik3-del/synaptomind/commit/16a47294b3579f48fa0d0d5456141cd02af654ba): fix(db): make migration apply + schema_version stamp atomic (#1751)
- [`75c1270`](https://github.com/zumik3-del/synaptomind/commit/75c1270cb583c99200ce991ccecf834f4889cb24): style: apply biome import-type fixes and drop an unused test binding
- [`9af4813`](https://github.com/zumik3-del/synaptomind/commit/9af4813afdd28d3f381e981706851e8db937bad7): refactor(db): unify migration default-export shape (#1689)
- [`b4f2ae8`](https://github.com/zumik3-del/synaptomind/commit/b4f2ae8c696af15ddc7cc9931b000b04ed94345f): fix(services): restore prose and telemetry names mangled by the rename (#1690)
- [`5f51928`](https://github.com/zumik3-del/synaptomind/commit/5f51928c5b7a069f64f3e35fc0fe40961d2bc746): refactor(db,services): split oversized modules along existing seams (#1688)
- [`0594ded`](https://github.com/zumik3-del/synaptomind/commit/0594ded30af20c9c0eac9023d4158054c9ad01a8): refactor(services): fix Database DI signatures and move test fixtures to src/test (#1687)
- [`a84e8bb`](https://github.com/zumik3-del/synaptomind/commit/a84e8bbfe2afe77e3806f482dd7395b3cb07237c): refactor(services): add Service suffix to exported functions (#1686)
- [`11b5a0e`](https://github.com/zumik3-del/synaptomind/commit/11b5a0ec61ec3f31bd9d1e4ea8609ef538d334ac): refactor(services): remove backward-compat re-exports from thoughts.service (#1685)

## v0.12.0

> October 15, 2026

- [`c7863a1`](https://github.com/zumik3-del/synaptomind/commit/c7863a13111305b7026aadfbdb466c03348abecd): test(embedder): assert the warning's intent instead of pinning its sentence
- [`e357f31`](https://github.com/zumik3-del/synaptomind/commit/e357f31e4c48cc8139b1b9e9893e3fcf6f1f72e7): fix(embedder): make the stale-sibling warning name the price of deleting it
- [`3bc5e7f`](https://github.com/zumik3-del/synaptomind/commit/3bc5e7f4a9ecf9ea86e4f2b11b8f937538e6fca4): test(embedder): pin the stale-sibling ONNX warning and the dtype error source label
- [`17f6fe4`](https://github.com/zumik3-del/synaptomind/commit/17f6fe45e85e452d3bb6539fa78ddbb36a58da2b): test(embedder): drive the batch-loop dtype assertion with fp32 so it catches a hardcoded literal
- [`84952c6`](https://github.com/zumik3-del/synaptomind/commit/84952c6a7797d54b18aaeea60e04da167bd1c100): fix(embedder): warn on stale sibling ONNX and name the dtype error source
- [`11de684`](https://github.com/zumik3-del/synaptomind/commit/11de6841b50c584d8082e1362ad0440222474cf5): test(embedder): pin the dtype contract and measure fp32-to-q8 embedding drift
- [`0b53091`](https://github.com/zumik3-del/synaptomind/commit/0b5309152136215e82325dd3d7d5f0d5c7b166a8): feat(embedder): make embedder.dtype configurable with q8 default
- [`c0f41d5`](https://github.com/zumik3-del/synaptomind/commit/c0f41d5fe32b11eaff891e7c41923caa7b098bd4): refactor(mcp): extract InMemoryEventStore into its own module
- [`810b60a`](https://github.com/zumik3-del/synaptomind/commit/810b60a26a330a3506eb64f3c32b1281d773f721): refactor(db): drop importance barrel re-export from thoughts
- [`b571249`](https://github.com/zumik3-del/synaptomind/commit/b57124952d936720c628743ac3f155883c1e7a6b): refactor(projects): move isDefaultProjectService to services layer
- [`5c3358e`](https://github.com/zumik3-del/synaptomind/commit/5c3358ef64945158ea6ce206a0383606e1962062): refactor(embedder): move queue module to db/pending-embeddings
- [`9bbbe8c`](https://github.com/zumik3-del/synaptomind/commit/9bbbe8c607a03f78782482c4b4a2508a1ddaedf6): refactor(settings): db-first accessors and service wrappers
- [`4b51194`](https://github.com/zumik3-del/synaptomind/commit/4b511944b18a3b33077421008b15de05ebdc1de6): refactor(embedder): extract IPC pending-request bookkeeping into ipc-client.ts

## v0.11.0

> October 13, 2026

- [`524c872`](https://github.com/zumik3-del/synaptomind/commit/524c872d2659db02b9e42150174dcec1865d7422): chore(repo): ignore agent scratch and worktree dirs
- [`1032c5e`](https://github.com/zumik3-del/synaptomind/commit/1032c5e8ce387d79792ce432ebdfba3e95e6b127): test(placement): type the pin-probe fixture expectation
- [`cdcdd66`](https://github.com/zumik3-del/synaptomind/commit/cdcdd66e7d8b330a634b39eacfc3d5ee831210ab): perf(placement): reuse stored embeddings and drop per-candidate vec0 queries
- [`42392cb`](https://github.com/zumik3-del/synaptomind/commit/42392cbe92d834779b4391e8685338b05644a1d9): fix(embedder): keep the freshness signal when insertEmbedding skips a row
- [`99cbf0e`](https://github.com/zumik3-del/synaptomind/commit/99cbf0e36dada38b9f990b131a11395428342cf1): perf(embeddings): reuse stored vectors and drop per-candidate vec0 scans in cluster/edge jobs
- [`4d8008d`](https://github.com/zumik3-del/synaptomind/commit/4d8008db0ce09a3cef2300760bf5d8d8b4c32ea4): fix(embedder): pin transformers.js cache env before pipeline load
- [`0205802`](https://github.com/zumik3-del/synaptomind/commit/0205802f89897ed39c23482c30950a869c0dc528): refactor(mcp): typed errors + single-source Default-project rule
- [`259d62f`](https://github.com/zumik3-del/synaptomind/commit/259d62fda6d28b8ff87c967e25f57167c10d67b9): refactor(embedder): split EmbedderClient from client-core facade
- [`2656e33`](https://github.com/zumik3-del/synaptomind/commit/2656e3367df4795f841505b7dab1f945c29481d7): refactor(db): extract cluster-edges module and remove dead edge helpers

## v0.10.0

> October 9, 2026

- [`d14a4c9`](https://github.com/zumik3-del/synaptomind/commit/d14a4c96b7a986642b50e16bd4b216981903dfc7): feat(search): add is_global thought flag for global search inclusion
- [`f2d48aa`](https://github.com/zumik3-del/synaptomind/commit/f2d48aadbc13c888371a7b876d198997e35229eb): refactor: apply SOLID/KISS/DRY audit fixes (tasks #1473-#1483)
- [`672ba53`](https://github.com/zumik3-del/synaptomind/commit/672ba53c8f9cb286829daac684434b06a0f96367): fix(deps): add proxy-addr override to pin transitive express dependency (#176)
- [`ac01e20`](https://github.com/zumik3-del/synaptomind/commit/ac01e20d9d0423ada28c3891b90b2e6757075760): fix(deps): update MCP SDK, proxy-addr, and sharp to address new CVEs (#175)
- [`ccf7da5`](https://github.com/zumik3-del/synaptomind/commit/ccf7da588655c833db0cf7a939d3be6121bd91b8): fix(deps): pin fast-uri to 3.1.7 to address CVE-2026-84292 and CVE-2026-84394 (#174)
- [`48c438a`](https://github.com/zumik3-del/synaptomind/commit/48c438adf086547d828b1a98348bc90d385712cc): feat(deploy): generalize the deploy framework for multi-app reuse (#173)

## v0.9.0

> September 29, 2026

- [`dd6f92e`](https://github.com/zumik3-del/synaptomind/commit/dd6f92e1863dd689ce39207f8239957235421e88): feat(placement): review queue, propose-only policy engine and triage pipeline (#164)

## v0.8.0

> September 28, 2026

- [`3fae2bb`](https://github.com/zumik3-del/synaptomind/commit/3fae2bb0a069803f3ab0fc9e63834cafe6fce1b8): feat(deploy): add frozen updater.sh stable self-updating bootstrap (#162)

## v0.8.0-beta.2

> September 27, 2026

- [`e2900cf`](https://github.com/zumik3-del/synaptomind/commit/e2900cfff83f21a15cfdff9821e20ab3072181b3): fix(ci): create release tag with committer identity + manual re-trigger (#160) (#161)
- [`926ec2d`](https://github.com/zumik3-del/synaptomind/commit/926ec2d9c5e9f89351443d9ae6b26b0f0435717e): feat(search): relevance confidence + eval/vec test hardening (#154 #155 #156 #157) (#159)
- [`c0e547d`](https://github.com/zumik3-del/synaptomind/commit/c0e547dc6665bf7ebdff7f63c46823905af2a858): fix(deploy): fetch tags before explicit --version checkout in update.sh (#153)
- [`d3c139a`](https://github.com/zumik3-del/synaptomind/commit/d3c139afc434ed82f34a10f95093647dfa4915b8): feat(ci): create releases from main on version-bump merge (#152)

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
