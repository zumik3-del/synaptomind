# Changelog

## v0.20.0

> October 26, 2026

- [`9e303db`](https://github.com/zumik3-del/synaptomind/commit/9e303dbefd3ee2ba5a53029af62efcd34b30794a): test(mcp): pin the update-status enum split
- [`18c9286`](https://github.com/zumik3-del/synaptomind/commit/18c92863a9382ee110d1c25f96b28496f1333b1a): fix(mcp): apply review fixes for docs, store text and enum message
- [`2ca2572`](https://github.com/zumik3-del/synaptomind/commit/2ca25720d0a7ab6f785b39a6b33e474a6bd8af95): test(api): pin all 43 removed routes as plain 404s
- [`2428264`](https://github.com/zumik3-del/synaptomind/commit/2428264257692761fffd20e420190346aea52e75): test(mcp): pin the update->archived gate and repair the url-link tests
- [`8688a67`](https://github.com/zumik3-del/synaptomind/commit/8688a67a9c87fa7e5b1e154df30dcbfd3d13b75c): fix(mcp): reject update -> archived; archive only via supersede
- [`734cebf`](https://github.com/zumik3-del/synaptomind/commit/734cebf907f9f62fb646d687b8f0457b776aa42c): test(api): move the HTTP suite to MCP and pin the removed routes
- [`39cb65e`](https://github.com/zumik3-del/synaptomind/commit/39cb65ef7895f716f47b2f0c9d8f9ff9651d234c): docs(api): shrink the HTTP reference to the ops plane and document include_url_links
- [`37a196f`](https://github.com/zumik3-del/synaptomind/commit/37a196f49b0cef00367ad4bd8fdfc35467307751): feat(api)!: shrink HTTP to three ops endpoints and add include_url_links to MCP
- [`8ff997f`](https://github.com/zumik3-del/synaptomind/commit/8ff997f547c884c5bf68cd467d276cdabd0fac73): test(profiles): pin the profile-vestige removal and v047
- [`0716a85`](https://github.com/zumik3-del/synaptomind/commit/0716a852fa84dd76cece9c046f2f199b8edf24d3): test(cleanup): pin the #2201 removals
- [`86def54`](https://github.com/zumik3-del/synaptomind/commit/86def54d2bbecfebac1f4ee82cfddbe450441766): chore(config): set retention_review importanceFloor default to 0.3
- [`0b00d71`](https://github.com/zumik3-del/synaptomind/commit/0b00d717725df61e5ce5cb5bd96c2bb263e173a4): refactor(profiles): clear is_profile in v047 and remove the retired profile surface
- [`81bfb8b`](https://github.com/zumik3-del/synaptomind/commit/81bfb8b3b902b708f72da94ab6f24d01d96ea84a): refactor(cleanup): remove dead exports, write-only meta and inert knobs
- [`ad27e41`](https://github.com/zumik3-del/synaptomind/commit/ad27e41fd4ae94b6b8b51426fd0608658526c9ca): test(search,mcp): pin the gate-vs-id rule and harden two brittle assertions
- [`ec29554`](https://github.com/zumik3-del/synaptomind/commit/ec29554616fc3c821a8a45b26a95d54ac7742f30): chore(eval,docs): round-3 review nits
- [`3340922`](https://github.com/zumik3-del/synaptomind/commit/3340922c22821e108ccf0d0bd1d3eba123076ac3): test(db): amortise the vec test database setup with a migrated template
- [`7f9d961`](https://github.com/zumik3-del/synaptomind/commit/7f9d9617c8a085302fa90f12bd60e342beae17e3): test(search,eval): pin prefix scope isolation and the gated eval pass
- [`f3f4153`](https://github.com/zumik3-del/synaptomind/commit/f3f41535e457e1ed9e01c3df059e2113032ef058): docs: prefix scoping, clusters id rule and low_confidence semantics
- [`40f154b`](https://github.com/zumik3-del/synaptomind/commit/40f154b824d617808590f35e1ae434c123e7e953): fix(search): scope prefix lookups and close the round-2 review findings
- [`036c1f3`](https://github.com/zumik3-del/synaptomind/commit/036c1f3f3d09eca4fd655c5127481600aa581081): feat(eval): report-only gated pass beside the ungated baseline
- [`9a5e284`](https://github.com/zumik3-del/synaptomind/commit/9a5e28446c192afe385870864b177e6df883c02d): docs: align the id-lookup, context and counts contracts with the fixes
- [`cf2ee11`](https://github.com/zumik3-del/synaptomind/commit/cf2ee1136c67325450da5af6cd46457c5e8c5a6b): test(search,mcp): pin the id-lookup fallback, prefix cap and scope warnings
- [`f0ccd5b`](https://github.com/zumik3-del/synaptomind/commit/f0ccd5b70a36a7e76b4e46d534e528a07326904f): fix(search): id-lookup fallback, 13-hex prefix floor and standing on id hits
- [`34c077d`](https://github.com/zumik3-del/synaptomind/commit/34c077dacff6192578d1966c0634c8224c6c6891): fix(mcp): context gate opt-out, scope warnings and envelope polish
- [`4894817`](https://github.com/zumik3-del/synaptomind/commit/4894817973ed98373595668f97fa2d6cfcc76ec1): fix(mcp): envelope for primers delete and hygiene for reflect timeline
- [`3dd8e27`](https://github.com/zumik3-del/synaptomind/commit/3dd8e2727d26192a122768086b9832467bf5c8f5): docs(mcp): response envelope, id lookup, relevance gate and the cwd rule
- [`9d0592c`](https://github.com/zumik3-del/synaptomind/commit/9d0592c39314dc213f16e34fa0f2035d91e7b10a): test(mcp): table-driven envelope conformance for all action tools
- [`a7f1369`](https://github.com/zumik3-del/synaptomind/commit/a7f1369dd7b5acf38d9726d52accb7b8826e8fb3): feat(mcp)!: unified response envelope for write-side tools
- [`58f08ff`](https://github.com/zumik3-del/synaptomind/commit/58f08ff36628ab6577dffc667d92c2216fc94f08): feat(mcp)!: unified response envelope for read-side tools
- [`3dc2291`](https://github.com/zumik3-del/synaptomind/commit/3dc229128f2a314e66673809031f63f96f540021): test(search): lock id lookup, calibrated relevance and the default gate
- [`682afad`](https://github.com/zumik3-del/synaptomind/commit/682afad486de68bf5dc1965983f124e85b51406d): feat(search): exact thought-id lookup, calibrated relevance and a default noise gate

## v0.19.1

> October 25, 2026

- [`38a31a1`](https://github.com/zumik3-del/synaptomind/commit/38a31a1c9877c668480f2fa9f37c567b7126cc59): fix(db): address v046 review findings (task #2174)
- [`c447a2c`](https://github.com/zumik3-del/synaptomind/commit/c447a2c9e28cca703ded872940480ea082717c05): fix(db): close DB on shutdown for WAL checkpoint (task #2155)
- [`d1e19bf`](https://github.com/zumik3-del/synaptomind/commit/d1e19bf1ccff5a8c10ba3cb621f4fc6ec9239e0f): feat(db): v046 invariants, boot guard, atomic preview tokens (task #2154)
- [`9c43e7c`](https://github.com/zumik3-del/synaptomind/commit/9c43e7c28178491b5a03cb790d42f0d4e8d3dbc4): refactor(embedder): single-flight supervision hardening (task #2153)
- [`82c9789`](https://github.com/zumik3-del/synaptomind/commit/82c9789a7a1498ee1ca2c29fc071b1fff7b0df28): feat(search): semantic context + observable degraded signal (task #2152)
- [`6c9979e`](https://github.com/zumik3-del/synaptomind/commit/6c9979e5ce9cc4a5779564aa47e90c2329ca640f): feat(health): remove writes from read surfaces, add repair endpoint (task #2151)
- [`2e97e1f`](https://github.com/zumik3-del/synaptomind/commit/2e97e1f1b65c0c3c310e174c65c313d5e2931f04): refactor(mcp): remove `any` from MCP tool layer (health, recall, review, retention, event-store)
- [`c35bfb1`](https://github.com/zumik3-del/synaptomind/commit/c35bfb1706f43ae2ad549c467ba2bf5c70479d58): refactor(services): split placement-proposals.service.ts under 350 lines
- [`a2fa9ba`](https://github.com/zumik3-del/synaptomind/commit/a2fa9bae47ffcf1352ab204fa0782bd4e370a76e): refactor: apply audit improvements (auth, rate-limit, config path, validation, typing, DRY)
- [`12ff415`](https://github.com/zumik3-del/synaptomind/commit/12ff415b80ab1e0a7addd8b9c549bae00b5895a9): refactor: remove unused exports, dead types and fast-uri dependency
- [`52a42c6`](https://github.com/zumik3-del/synaptomind/commit/52a42c62ea6813a1ccfd3fe89b3121a644e9b049): refactor: remove dead partitionFields helper
- [`9e53307`](https://github.com/zumik3-del/synaptomind/commit/9e533071a89a737e5d1f9d367c24d7b50083afd8): refactor: remove dead code (9 unused functions)

## v0.19.0

> October 24, 2026

- [`b905b02`](https://github.com/zumik3-del/synaptomind/commit/b905b02aac14fc071946eead5c3dd7a3da30725c): docs(mcp): v0.19 MCP UX cleanup examples and migration notes (#2147)
- [`82b6d7a`](https://github.com/zumik3-del/synaptomind/commit/82b6d7a9ec8ac7fd10fd2f0decd7daffdcb84174): test(mcp): update tests for v0.19 breaking changes (#2148)
- [`65ad655`](https://github.com/zumik3-del/synaptomind/commit/65ad6556127c83b76f018db8096b0c59ba1d5b1e): feat(mcp): add compact/fields shaping to retention review list (t2146)
- [`c509d02`](https://github.com/zumik3-del/synaptomind/commit/c509d02168265d3291b981ae55f1b383c0a5b9e3): feat(mcp): default memory_status propose output to slim (t2145)
- [`ce66bdf`](https://github.com/zumik3-del/synaptomind/commit/ce66bdf7b504790afe82c3c9be43e3a0a82db2f8): refactor(mcp)!: drop the project_id argument in favour of cwd (#2144)
- [`1d777e8`](https://github.com/zumik3-del/synaptomind/commit/1d777e880585cde94cc1060f4b2e81ee89b44ed0): feat(mcp): make health check details opt-in via include_details (#2143)
- [`30e7ace`](https://github.com/zumik3-del/synaptomind/commit/30e7acefcf070bd69deaf3d264c2b635536f95eb): refactor(mcp): trim edge_review list response to canonical keys (#2142)
- [`eb60646`](https://github.com/zumik3-del/synaptomind/commit/eb60646d36ddac82db778f29dac7516c6eefa4df): feat(mcp): default compact output for memory_recall actions (#2141)
- [`5218e4c`](https://github.com/zumik3-del/synaptomind/commit/5218e4c76219843c833ff939ffdddeea484b25d1): refactor(mcp): collapse compact plumbing aliases into single typed API (#2140)
- [`dc88c00`](https://github.com/zumik3-del/synaptomind/commit/dc88c0052a391451958894b4ead08c5082cbec3d): chore: fix biome noImplicitAnyLet in retention-review test
- [`c4c7a6b`](https://github.com/zumik3-del/synaptomind/commit/c4c7a6b02b86cb076a73db6a81831b9bc8aead88): chore: fix biome warnings (useConst, optional chain)
- [`c2d280f`](https://github.com/zumik3-del/synaptomind/commit/c2d280f146d3c99ed53e2d515fbe14a1ede4f4e6): feat(mcp): require preview token for destructive operations (#2132)
- [`5484cae`](https://github.com/zumik3-del/synaptomind/commit/5484caebcc392f8e0f7c4fd0cadfc578e562bbcd): feat(mcp): add preview-token infrastructure and pilot on unlink/archive (#2130)
- [`24ca2ce`](https://github.com/zumik3-del/synaptomind/commit/24ca2ce6563ab894ad223ff198c6e4a97491479e): feat(mcp): wire compact and fields output controls into read tools (#2131)
- [`6d4a888`](https://github.com/zumik3-del/synaptomind/commit/6d4a88843a57d372c1d5071ef1e38c789e6a1211): feat(mcp): default recall status per action (search/clusters active, list all) (#2129)
- [`60a010b`](https://github.com/zumik3-del/synaptomind/commit/60a010bde9e52375ea482923985b743c5adc5aab): fix(db): hydrate project_name in thought search results (#2128)
- [`adb067c`](https://github.com/zumik3-del/synaptomind/commit/adb067c908f9fab6993adaf3902195cb7aa5f74f): feat(mcp): add compact/fields plumbing for read tools (#2122)
- [`b33857e`](https://github.com/zumik3-del/synaptomind/commit/b33857e2f0e81d91acc0b869625894d551d93c61): test(mcp): update edge-review contract tests to object response shape (#2125)
- [`7d43038`](https://github.com/zumik3-del/synaptomind/commit/7d43038e28f65e73e125527f53b20a2bdce7ef1d): fix(mcp): restore layering guard after #2125 (re-export isLegacyItemKind via service)
- [`192152d`](https://github.com/zumik3-del/synaptomind/commit/192152d3f203c361274008e1d0dd4df813d982ce): feat(mcp): add bulk_create action to memory_store
- [`8a9314e`](https://github.com/zumik3-del/synaptomind/commit/8a9314e89936df9a3a9942dd0aadc9c4645dc3b2): feat(review): hide retired proposal kinds by default
- [`3edfdd7`](https://github.com/zumik3-del/synaptomind/commit/3edfdd76ea695786e519608721f14a49e1e479a9): feat(mcp): add compact, max_edges and include_signals to status propose
- [`bdbd369`](https://github.com/zumik3-del/synaptomind/commit/bdbd369270aec292b3360d16a925337902de6b3d): feat(mcp): slim memory_status health output for MCP callers
- [`7d19353`](https://github.com/zumik3-del/synaptomind/commit/7d1935398690e27ddc5add5360a7fe63bb5b5f5d): feat(mcp): unify result envelope: wrap bare strings as {text} (#2126)
- [`f5385a6`](https://github.com/zumik3-del/synaptomind/commit/f5385a626cc7b42b1a506b2ef69d056b759c306a): refactor: address code quality audit findings
- [`cb78c0e`](https://github.com/zumik3-del/synaptomind/commit/cb78c0ea935cc023b4b42e341a0362c30342ff3b): test(config): verify retention bounds end to end (#2104)
- [`8d8a698`](https://github.com/zumik3-del/synaptomind/commit/8d8a698130ae12943b5c252e950d435a1269e934): test(retention): cover profile HTTP MCP boundaries (#2103)
- [`0742a4e`](https://github.com/zumik3-del/synaptomind/commit/0742a4e7aa969e507310d3e1ebe3d5768d8e56e3): test(retention): prove profile service safeguards (#2101)
- [`bc502f5`](https://github.com/zumik3-del/synaptomind/commit/bc502f554c3a7abab05f03df7f72459d0fd31a6a): test(retention): cover caps previews and config bounds (#2085)
- [`7687f14`](https://github.com/zumik3-del/synaptomind/commit/7687f147c533b3a0be49b43ee6b32246b92ae1e5): test(retention): prove audit log outcomes (#2102)
- [`32d2ec9`](https://github.com/zumik3-del/synaptomind/commit/32d2ec9375262da75145689a41715f444b688b2b): docs(retention): document final review contract (#2086)
- [`26843c6`](https://github.com/zumik3-del/synaptomind/commit/26843c6ac8779cbd450d31613c6da0681bf4354d): test(retention): prove cascades and service DI (#2081)
- [`c5dc8d2`](https://github.com/zumik3-del/synaptomind/commit/c5dc8d2d3da94b1d45e33e8f84213eed4da38336): feat(retention): log committed review actions (#2084)
- [`b19d570`](https://github.com/zumik3-del/synaptomind/commit/b19d5705d230658e1d3818e88fbbd07193e5bc5d): fix(retention): cap compact inputs and default delete preview (#2083)
- [`2479778`](https://github.com/zumik3-del/synaptomind/commit/2479778536bd5615d3ca06aab3ef849e34042402): fix(retention): exclude profile thoughts (#2082)
- [`75c9a36`](https://github.com/zumik3-del/synaptomind/commit/75c9a36693bac7e41cfdf1959c89ea4e56747a9b): refactor(retention): remove temporary action exports (#2100)
- [`e8411f8`](https://github.com/zumik3-del/synaptomind/commit/e8411f8a2bd1f7cc7ddd4c8b6f7d72ded9af4014): test(retention): migrate action service imports (#2099)
- [`a9e56c6`](https://github.com/zumik3-del/synaptomind/commit/a9e56c6b0cde091170f4ff763412049b5895298d): refactor(retention): split action services and use FK cascades (#2090)
- [`53cb7d2`](https://github.com/zumik3-del/synaptomind/commit/53cb7d23802b0c07b6d111787379de00665bdd18): refactor(retention): remove temporary error export (#2098)
- [`7a145de`](https://github.com/zumik3-del/synaptomind/commit/7a145decae2798dbba345178b21fdf683f4a7c61): test(retention): import shared ineligible error (#2097)
- [`7ebe8a9`](https://github.com/zumik3-del/synaptomind/commit/7ebe8a908104f1db35d2970dc4250bd6433a46e2): refactor(retention): remove dead service API (#2095)
- [`06d440a`](https://github.com/zumik3-del/synaptomind/commit/06d440a80f2f07f4df4eac23575ce9f2549c1b75): refactor(retention): type delete protect DI (#2096)
- [`7545dc0`](https://github.com/zumik3-del/synaptomind/commit/7545dc07397a67525dcd7b060c9b0dfd60df2e7d): refactor(retention): type candidate list DI (#2089)
- [`a00e5d1`](https://github.com/zumik3-del/synaptomind/commit/a00e5d1a214f78feffdda604c1665059c671b36d): test(retention): use canonical service arguments (#2094)
- [`4c5b3ba`](https://github.com/zumik3-del/synaptomind/commit/4c5b3ba6de0c577b98452fe29116ac6a1bb630da): refactor(retention): extract compact lookups (#2093)
- [`03ec589`](https://github.com/zumik3-del/synaptomind/commit/03ec589dbeef81053b9bf2b4c47a423e0b228518): refactor(retention): move dependent counts to DB layer (#2092)
- [`f9e43c9`](https://github.com/zumik3-del/synaptomind/commit/f9e43c9cad8b1a25fe25762e06e08f107445b140): refactor(retention): extract eligibility reads (#2091)
- [`1f9f43c`](https://github.com/zumik3-del/synaptomind/commit/1f9f43c431d04fa11b071bfbb75e3d34a22839e2): refactor(retention): move candidate queries to DB layer (#2088)
- [`e0e4e6e`](https://github.com/zumik3-del/synaptomind/commit/e0e4e6eceba8286e62c28c0d3d35678a918c234d): fix(config): sanitize retention review bounds (#2080)
- [`91da756`](https://github.com/zumik3-del/synaptomind/commit/91da75648d839f50f772e85fd3aec1154b5af313): test(retention): cover retention-review behavior (#2070)
- [`edf0b9f`](https://github.com/zumik3-del/synaptomind/commit/edf0b9f6ccf5a4cb76e481013864c04d48c158ce): fix(retention): revalidate candidate before protect (#2075)
- [`d967294`](https://github.com/zumik3-del/synaptomind/commit/d96729474b3b762d4c02d1083e6db1aed974ba76): fix(retention): allow archived compact sources (#2074)
- [`a397453`](https://github.com/zumik3-del/synaptomind/commit/a3974537a7184fb6848683073c8ac7f51945359b): docs(retention): document unified retention review (#2071)
- [`5b2d04b`](https://github.com/zumik3-del/synaptomind/commit/5b2d04b1df7bb3b23ce2855482103f593ddc6eb9): feat(mcp): add retention-review tool (#2069)
- [`e75e8d7`](https://github.com/zumik3-del/synaptomind/commit/e75e8d7b0efc25931f378f2967dd4b74feec2c0c): feat(api): add retention-review endpoints (#2072)
- [`6c347a0`](https://github.com/zumik3-del/synaptomind/commit/6c347a070ede984f9fd1341bc83d84dd82c333e0): feat(retention): accept compact summary object (#2073)
- [`d3968c5`](https://github.com/zumik3-del/synaptomind/commit/d3968c52a8682061ebc740dec8f2b9e636aca42a): feat(retention): add safe compact service (#2068)
- [`d68da9b`](https://github.com/zumik3-del/synaptomind/commit/d68da9b8923aee7cfe6d9d742a50a9220a44cb4b): feat(retention): hard delete (cascade) and protect actions (#2067)
- [`f3afc6a`](https://github.com/zumik3-del/synaptomind/commit/f3afc6ab427d02ec9d450f428b64ad4bb8e40e40): feat(retention): candidate query, config block, and DB indexes (#2066)
- [`5ab7bc4`](https://github.com/zumik3-del/synaptomind/commit/5ab7bc4fc07b0f8e45ac44373fabbe68f184155c): refactor(review): rename memory_review to edge_review
- [`e1564e3`](https://github.com/zumik3-del/synaptomind/commit/e1564e3abd64f318eb36ef255a747fded90b228e): refactor(ttl): remove TTL cleanup mechanism (retention-review is sole deletion path)

## v0.18.0

> October 23, 2026

- [`cb78c0e`](https://github.com/zumik3-del/synaptomind/commit/cb78c0ea935cc023b4b42e341a0362c30342ff3b): test(config): verify retention bounds end to end (#2104)
- [`8d8a698`](https://github.com/zumik3-del/synaptomind/commit/8d8a698130ae12943b5c252e950d435a1269e934): test(retention): cover profile HTTP MCP boundaries (#2103)
- [`0742a4e`](https://github.com/zumik3-del/synaptomind/commit/0742a4e7aa969e507310d3e1ebe3d5768d8e56e3): test(retention): prove profile service safeguards (#2101)
- [`bc502f5`](https://github.com/zumik3-del/synaptomind/commit/bc502f554c3a7abab05f03df7f72459d0fd31a6a): test(retention): cover caps previews and config bounds (#2085)
- [`7687f14`](https://github.com/zumik3-del/synaptomind/commit/7687f147c533b3a0be49b43ee6b32246b92ae1e5): test(retention): prove audit log outcomes (#2102)
- [`32d2ec9`](https://github.com/zumik3-del/synaptomind/commit/32d2ec9375262da75145689a41715f444b688b2b): docs(retention): document final review contract (#2086)
- [`26843c6`](https://github.com/zumik3-del/synaptomind/commit/26843c6ac8779cbd450d31613c6da0681bf4354d): test(retention): prove cascades and service DI (#2081)
- [`c5dc8d2`](https://github.com/zumik3-del/synaptomind/commit/c5dc8d2d3da94b1d45e33e8f84213eed4da38336): feat(retention): log committed review actions (#2084)
- [`b19d570`](https://github.com/zumik3-del/synaptomind/commit/b19d5705d230658e1d3818e88fbbd07193e5bc5d): fix(retention): cap compact inputs and default delete preview (#2083)
- [`2479778`](https://github.com/zumik3-del/synaptomind/commit/2479778536bd5615d3ca06aab3ef849e34042402): fix(retention): exclude profile thoughts (#2082)
- [`75c9a36`](https://github.com/zumik3-del/synaptomind/commit/75c9a36693bac7e41cfdf1959c89ea4e56747a9b): refactor(retention): remove temporary action exports (#2100)
- [`e8411f8`](https://github.com/zumik3-del/synaptomind/commit/e8411f8a2bd1f7cc7ddd4c8b6f7d72ded9af4014): test(retention): migrate action service imports (#2099)
- [`a9e56c6`](https://github.com/zumik3-del/synaptomind/commit/a9e56c6b0cde091170f4ff763412049b5895298d): refactor(retention): split action services and use FK cascades (#2090)
- [`53cb7d2`](https://github.com/zumik3-del/synaptomind/commit/53cb7d23802b0c07b6d111787379de00665bdd18): refactor(retention): remove temporary error export (#2098)
- [`7a145de`](https://github.com/zumik3-del/synaptomind/commit/7a145decae2798dbba345178b21fdf683f4a7c61): test(retention): import shared ineligible error (#2097)
- [`7ebe8a9`](https://github.com/zumik3-del/synaptomind/commit/7ebe8a908104f1db35d2970dc4250bd6433a46e2): refactor(retention): remove dead service API (#2095)
- [`06d440a`](https://github.com/zumik3-del/synaptomind/commit/06d440a80f2f07f4df4eac23575ce9f2549c1b75): refactor(retention): type delete protect DI (#2096)
- [`7545dc0`](https://github.com/zumik3-del/synaptomind/commit/7545dc07397a67525dcd7b060c9b0dfd60df2e7d): refactor(retention): type candidate list DI (#2089)
- [`a00e5d1`](https://github.com/zumik3-del/synaptomind/commit/a00e5d1a214f78feffdda604c1665059c671b36d): test(retention): use canonical service arguments (#2094)
- [`4c5b3ba`](https://github.com/zumik3-del/synaptomind/commit/4c5b3ba6de0c577b98452fe29116ac6a1bb630da): refactor(retention): extract compact lookups (#2093)
- [`03ec589`](https://github.com/zumik3-del/synaptomind/commit/03ec589dbeef81053b9bf2b4c47a423e0b228518): refactor(retention): move dependent counts to DB layer (#2092)
- [`f9e43c9`](https://github.com/zumik3-del/synaptomind/commit/f9e43c9cad8b1a25fe25762e06e08f107445b140): refactor(retention): extract eligibility reads (#2091)
- [`1f9f43c`](https://github.com/zumik3-del/synaptomind/commit/1f9f43c431d04fa11b071bfbb75e3d34a22839e2): refactor(retention): move candidate queries to DB layer (#2088)
- [`e0e4e6e`](https://github.com/zumik3-del/synaptomind/commit/e0e4e6eceba8286e62c28c0d3d35678a918c234d): fix(config): sanitize retention review bounds (#2080)
- [`91da756`](https://github.com/zumik3-del/synaptomind/commit/91da75648d839f50f772e85fd3aec1154b5af313): test(retention): cover retention-review behavior (#2070)
- [`edf0b9f`](https://github.com/zumik3-del/synaptomind/commit/edf0b9f6ccf5a4cb76e481013864c04d48c158ce): fix(retention): revalidate candidate before protect (#2075)
- [`d967294`](https://github.com/zumik3-del/synaptomind/commit/d96729474b3b762d4c02d1083e6db1aed974ba76): fix(retention): allow archived compact sources (#2074)
- [`a397453`](https://github.com/zumik3-del/synaptomind/commit/a3974537a7184fb6848683073c8ac7f51945359b): docs(retention): document unified retention review (#2071)
- [`5b2d04b`](https://github.com/zumik3-del/synaptomind/commit/5b2d04b1df7bb3b23ce2855482103f593ddc6eb9): feat(mcp): add retention-review tool (#2069)
- [`e75e8d7`](https://github.com/zumik3-del/synaptomind/commit/e75e8d7b0efc25931f378f2967dd4b74feec2c0c): feat(api): add retention-review endpoints (#2072)
- [`6c347a0`](https://github.com/zumik3-del/synaptomind/commit/6c347a070ede984f9fd1341bc83d84dd82c333e0): feat(retention): accept compact summary object (#2073)
- [`d3968c5`](https://github.com/zumik3-del/synaptomind/commit/d3968c52a8682061ebc740dec8f2b9e636aca42a): feat(retention): add safe compact service (#2068)
- [`d68da9b`](https://github.com/zumik3-del/synaptomind/commit/d68da9b8923aee7cfe6d9d742a50a9220a44cb4b): feat(retention): hard delete (cascade) and protect actions (#2067)
- [`f3afc6a`](https://github.com/zumik3-del/synaptomind/commit/f3afc6ab427d02ec9d450f428b64ad4bb8e40e40): feat(retention): candidate query, config block, and DB indexes (#2066)
- [`5ab7bc4`](https://github.com/zumik3-del/synaptomind/commit/5ab7bc4fc07b0f8e45ac44373fabbe68f184155c): refactor(review): rename memory_review to edge_review
- [`e1564e3`](https://github.com/zumik3-del/synaptomind/commit/e1564e3abd64f318eb36ef255a747fded90b228e): refactor(ttl): remove TTL cleanup mechanism (retention-review is sole deletion path)

## v0.17.0

> October 23, 2026

- [`a9e47c0`](https://github.com/zumik3-del/synaptomind/commit/a9e47c013b20d63ffa7d970224379d7770643587): chore(logging): clean up stale logs.db references and config example
- [`e88a03f`](https://github.com/zumik3-del/synaptomind/commit/e88a03f25b96bf5ef92a40e0abc3d615d2a3da3a): refactor(logging): remove logs.db and finalise stdout/stderr logging (#2059)
- [`f656fd7`](https://github.com/zumik3-del/synaptomind/commit/f656fd789cb565a959c901ff4ea41bcfb61b3b24): chore(logging): export Logger sinks and types from logging barrel (#2058)
- [`02f352f`](https://github.com/zumik3-del/synaptomind/commit/02f352fee4c3bb12c4d62b55525737751f113c68): docs(deploy): route logs to stdout/stderr and make logs.db optional (#2057)
- [`ad40fa7`](https://github.com/zumik3-del/synaptomind/commit/ad40fa74aca3a794f3b93fbe2167d91e86e11179): feat(logging): add forward-only legacy logs.db migration (#2056)
- [`9fadbc4`](https://github.com/zumik3-del/synaptomind/commit/9fadbc4b0134c233112ad45986758ac384d76cf1): feat(config): add log.* settings and deprecated logDbPath alias (#2055)
- [`ddb76eb`](https://github.com/zumik3-del/synaptomind/commit/ddb76ebe88a1aa908980dcf81a7d5718432c5617): feat(logging): introduce sink-based Logger with stdout/stderr/file sinks (#2054)
- [`350befb`](https://github.com/zumik3-del/synaptomind/commit/350befb906571689af7fac9de552a7f723663998): docs(mcp): standardize action-specific MCP input requirement labels (#2051)
- [`00a555f`](https://github.com/zumik3-del/synaptomind/commit/00a555f39403a985084597343d175bac413e36d4): style(mcp): restore trailing newline in store.ts
- [`68ff555`](https://github.com/zumik3-del/synaptomind/commit/68ff55574cf122e592d46eda12aed0e0e5558da7): fix(mcp): validate ISO datetime MCP parameters consistently (#2050)
- [`fd2bb43`](https://github.com/zumik3-del/synaptomind/commit/fd2bb43c29a3d835b6e041d309650a4fef412b9f): fix(mcp): clarify memory_recall action-specific parameter behavior (#2047)
- [`677f233`](https://github.com/zumik3-del/synaptomind/commit/677f23387461f20c60556b80d46a0ca41482b188): docs(mcp): clarify memory_store parameter action scopes (#2049)
- [`51fd6f2`](https://github.com/zumik3-del/synaptomind/commit/51fd6f2e18aac6b8209d2853061634e4ec579e19): fix(mcp): align memory_status limit schema with frontier cap (#2048)
- [`60d9ecc`](https://github.com/zumik3-del/synaptomind/commit/60d9ecc63af0cd5e18649ab156a0f2d342b6dcaa): fix(mcp): align MCP search mode contract and documentation (#2046)
- [`208ec3c`](https://github.com/zumik3-del/synaptomind/commit/208ec3c72f798f0d96e377c0603333eba4b9398d): feat(thoughts): allow clearing surface_after via memory_store update
- [`423a954`](https://github.com/zumik3-del/synaptomind/commit/423a954b4a8deac4082fa290f90710bb430ec7d0): docs(mcp): correct link thought_id guidance
- [`942d6f5`](https://github.com/zumik3-del/synaptomind/commit/942d6f59007f8c6803552e706c8bee1734dcb551): test(mcp): cover retired input schema contracts
- [`1073603`](https://github.com/zumik3-del/synaptomind/commit/1073603276c7f468b83ae25f42fb001cbcda80b2): docs(mcp): document is_profile removal without replacement
- [`beab0f0`](https://github.com/zumik3-del/synaptomind/commit/beab0f07c10810d6597749c998c583fa6355c477): test(mcp): assert retired-argument tombstones carry precise hints
- [`b2d51cf`](https://github.com/zumik3-del/synaptomind/commit/b2d51cf7e928d1b8ebbfa9abd7f0bd5b4443a734): docs(mcp): document retired-argument tombstones and client validation
- [`c049291`](https://github.com/zumik3-del/synaptomind/commit/c0492916a377744b3428b9a3bbe6d3ae2a798b6d): fix(mcp): reject retired is_profile at validation and scope thought_id
- [`30de4e8`](https://github.com/zumik3-del/synaptomind/commit/30de4e817ee0867135a4dd6bbfccc8d936c6a5b3): docs(mcp): describe retired parameters with removal guidance

## v0.16.3

> October 22, 2026

- [`423a954`](https://github.com/zumik3-del/synaptomind/commit/423a954b4a8deac4082fa290f90710bb430ec7d0): docs(mcp): correct link thought_id guidance
- [`942d6f5`](https://github.com/zumik3-del/synaptomind/commit/942d6f59007f8c6803552e706c8bee1734dcb551): test(mcp): cover retired input schema contracts
- [`1073603`](https://github.com/zumik3-del/synaptomind/commit/1073603276c7f468b83ae25f42fb001cbcda80b2): docs(mcp): document is_profile removal without replacement
- [`beab0f0`](https://github.com/zumik3-del/synaptomind/commit/beab0f07c10810d6597749c998c583fa6355c477): test(mcp): assert retired-argument tombstones carry precise hints
- [`b2d51cf`](https://github.com/zumik3-del/synaptomind/commit/b2d51cf7e928d1b8ebbfa9abd7f0bd5b4443a734): docs(mcp): document retired-argument tombstones and client validation
- [`c049291`](https://github.com/zumik3-del/synaptomind/commit/c0492916a377744b3428b9a3bbe6d3ae2a798b6d): fix(mcp): reject retired is_profile at validation and scope thought_id
- [`30de4e8`](https://github.com/zumik3-del/synaptomind/commit/30de4e817ee0867135a4dd6bbfccc8d936c6a5b3): docs(mcp): describe retired parameters with removal guidance

## v0.16.2

> October 22, 2026

- [`398fc5e`](https://github.com/zumik3-del/synaptomind/commit/398fc5e15bf10517d289297b3a3a1dd063c5c8c1): test(mcp): verify bounded merge preview retrieval
- [`0a332a6`](https://github.com/zumik3-del/synaptomind/commit/0a332a68eb990bba049ab76c54dd0857366bc724): perf(mcp): bound merge preview edge retrieval
- [`51342d5`](https://github.com/zumik3-del/synaptomind/commit/51342d50ad852add2c3394dd2047c4ba984b4f15): test(mcp): cover supersede confirmation contract
- [`94e1958`](https://github.com/zumik3-del/synaptomind/commit/94e1958ba1dd6362384c32c48b6beeb749fce8b0): docs(mcp): document supersede confirmation contract
- [`c23245f`](https://github.com/zumik3-del/synaptomind/commit/c23245f43befee1cca47e9e431c3ef38884f1d13): fix(mcp): require confirmation for supersede writes
- [`a3fc395`](https://github.com/zumik3-del/synaptomind/commit/a3fc395de33ed816da72f6bb66588de75b0237b9): test(review): cover proposal enqueue contracts
- [`ac704ac`](https://github.com/zumik3-del/synaptomind/commit/ac704ac57fe0b0a8ab237184cad9dfec389c70ff): test(mcp): cover canonical recall and confirmation contracts
- [`442551f`](https://github.com/zumik3-del/synaptomind/commit/442551f3db169931685c542334d96214d7fade35): test(reflect): cover canonical goal parameters
- [`f87ad06`](https://github.com/zumik3-del/synaptomind/commit/f87ad06ccb5cfa13e2ae5d58b3a52d53a4468ec3): test(mcp): cover link and frontier validation fixes
- [`78c4977`](https://github.com/zumik3-del/synaptomind/commit/78c4977a02c6eb42c734530674229cf70302f23a): fix(mcp): validate retired link alias and frontier limit
- [`2c09c99`](https://github.com/zumik3-del/synaptomind/commit/2c09c99c0bf652900c4f09323d8034bbd714ee9a): docs(mcp): correct cleanup confirmation guide
- [`5535b16`](https://github.com/zumik3-del/synaptomind/commit/5535b168fde245d7b4536dead91d50be10caa5f2): docs(mcp): document canonical tool parameters
- [`596f8f8`](https://github.com/zumik3-del/synaptomind/commit/596f8f884f8d2830546dc8264fe1e1027021cc04): refactor(mcp)!: reject retired parameters with migration hints
- [`42f9904`](https://github.com/zumik3-del/synaptomind/commit/42f990449ef92b2947f1570e1746c7e558cef9cb): refactor(mcp)!: crystallize auto_cluster gated behind confirm
- [`6bef0f7`](https://github.com/zumik3-del/synaptomind/commit/6bef0f78023f21f04a8dbb4a758c266d32eb2865): refactor(mcp)!: review enqueue capped by max_proposals only
- [`c83ab08`](https://github.com/zumik3-del/synaptomind/commit/c83ab08eb4ea200a037673cd28f16e8e2a8e088e): refactor(reflect)!: explicit goals_add/goals_remove replace goals_delta
- [`9f61ca5`](https://github.com/zumik3-del/synaptomind/commit/9f61ca5796cb7c756e06284a2c0d0ab96980b543): refactor(mcp)!: store link requires source_id and target_id
- [`5c7612e`](https://github.com/zumik3-del/synaptomind/commit/5c7612ef1a1eadcbf8cff06099a4efc206f02435): refactor(mcp)!: status frontier limit and confirm-gated cleanup
- [`df992e2`](https://github.com/zumik3-del/synaptomind/commit/df992e25b3afaa2ef5fceae5d813cd0fbc807a5c): refactor(mcp)!: recall limits and cluster filter: canonical names only
- [`77a729f`](https://github.com/zumik3-del/synaptomind/commit/77a729f6071700467f848d7097702340bcdb32b6): docs(synaptomind): refresh skill for current MCP surface
- [`7083cc4`](https://github.com/zumik3-del/synaptomind/commit/7083cc4a24645bd934beaa482e2510dc5a61d9cf): chore: remove leftover _repro.test.ts debug file
- [`6f815ee`](https://github.com/zumik3-del/synaptomind/commit/6f815ee5580492386934fffa08552d26d29dfa51): feat(mcp): context accepts thought_id (task #1978)
- [`1d18af8`](https://github.com/zumik3-del/synaptomind/commit/1d18af894b45b1b0eb4495439d25c224b795b009): feat(search): rename vector->embedding in match_source, omit similarity for BM25-only (task #1977)
- [`1509570`](https://github.com/zumik3-del/synaptomind/commit/150957035b2b8400c936061ed7ba89d09d92062c): feat(mcp): add include_edges to memory_recall get (task #1976)
- [`283290e`](https://github.com/zumik3-del/synaptomind/commit/283290ed6805f47adf50c062b78ba33ce0b4d53d): docs(mcp): document confirm, slots, manage vs status, list params (tasks #1975,#1979,#1980,#1981)
- [`b2d6572`](https://github.com/zumik3-del/synaptomind/commit/b2d65722d0e0c4a69ba2d09ad360d61b26326772): feat(mcp): add pagination to memory_crystallize graph (task #1973)
- [`9d19b54`](https://github.com/zumik3-del/synaptomind/commit/9d19b54c4f3ff8287813ef709edc242ee6e040f6): feat(mcp): add unlink_batch action to memory_store (task #1972)
- [`addd8f8`](https://github.com/zumik3-del/synaptomind/commit/addd8f8aaad41dc3ef93bf18080d7c5261bb9b18): test(embedder): pin backoff isolation and mutation matrix of the batch loop (task #1970)
- [`88c61be`](https://github.com/zumik3-del/synaptomind/commit/88c61be9df3837fba949e0ae411dc7dc184d6bc1): docs(mcp): document memory_recall actions and list example

## v0.16.1

> October 22, 2026

- [`f010636`](https://github.com/zumik3-del/synaptomind/commit/f010636659c70c702b9480718b5924292309010f): chore: retrigger ci after pr title fix
- [`000a261`](https://github.com/zumik3-del/synaptomind/commit/000a261283a0b18205f4e312b88f0cda9a71bf70): docs+feat(reflect): document and tag reflect-created thoughts (#1969)
- [`c786e9a`](https://github.com/zumik3-del/synaptomind/commit/c786e9ae482d8e8c486a2672d0151c4f971d2065): feat(mcp): report transferred edge count on merge (#1968)
- [`56570da`](https://github.com/zumik3-del/synaptomind/commit/56570daad05a88e27ce439aa932b2c3a30066781): fix(health): don't score island thoughts (#1967)
- [`92531fa`](https://github.com/zumik3-del/synaptomind/commit/92531fa5c471873c2df555ada57c8b8b302a31fa): feat(mcp): add list thoughts action with filters and pagination (#1965)
- [`0e75fab`](https://github.com/zumik3-del/synaptomind/commit/0e75fab08d0d914949e0b4ef92cddae6b80e0f4c): fix(mcp): accept source_id alias for link (#1966)
- [`ae65359`](https://github.com/zumik3-del/synaptomind/commit/ae653597bee3885311c544a1876e576069953d54): feat(mcp): add batch archive and link operations (#1964)

## v0.16.0

> October 22, 2026

- [`2b202c7`](https://github.com/zumik3-del/synaptomind/commit/2b202c7f3cdd378c3af09b3772665210f88723e2): test: pin the pruned surface found by the batch verification (task #1953)
- [`bf6c5b3`](https://github.com/zumik3-del/synaptomind/commit/bf6c5b363c667a63431c2c28baf219111e3f1e89): docs: sync README, docs and memory_guide with the pruned surface (task #1952)
- [`fbc187d`](https://github.com/zumik3-del/synaptomind/commit/fbc187deeb20eba112e9d9047103b81c8beac67c): test: pin duplicate_drafts, the batch and run refusals and legacy triage apply (task #1962)
- [`31a7b6d`](https://github.com/zumik3-del/synaptomind/commit/31a7b6d33692b8bbc92bb1249d26c56963249fe2): fix(apply): restore the per-run edge cap (task #1961)
- [`bc365a8`](https://github.com/zumik3-del/synaptomind/commit/bc365a87331a5bcde528309ed2806421216bcb34): refactor(config): remove the config surface left dead by the pruning batch (task #1951)
- [`dbc7001`](https://github.com/zumik3-del/synaptomind/commit/dbc700108f3c373ada995ebfdb1dadd2a34eb102): refactor(triage): retire the triage subsystem in favour of a duplicate_drafts finding (task #1946)
- [`fe927a6`](https://github.com/zumik3-del/synaptomind/commit/fe927a646dacf7a4c4848ad79325df62be0cc32c): refactor(search): always include global thoughts and drop the include_global toggle (task #1954)
- [`c20693d`](https://github.com/zumik3-del/synaptomind/commit/c20693dc485e7e965caf80b35dc6fe2192c97b5a): test(ttl): pin the disabled archived-TTL direction (task #1957)
- [`ef2c5e5`](https://github.com/zumik3-del/synaptomind/commit/ef2c5e54c6d3deaab652ea960a3c28fdf099ba8c): refactor(api): remove HTTP-only admin and duplicate endpoints (task #1940)
- [`8badaaf`](https://github.com/zumik3-del/synaptomind/commit/8badaaf7d6d158b077b58fd2b38118dc7c060334): fix(ttl): disable archived-thought deletion for a zero or negative TTL (task #1960)
- [`fb380f9`](https://github.com/zumik3-del/synaptomind/commit/fb380f9d0f39a80b17f4a883ff757b5202d17202): refactor(review): shrink the placement queue to the live item kinds (task #1942)
- [`57782c1`](https://github.com/zumik3-del/synaptomind/commit/57782c1ad6560c266e6d1a6cf7a8763526be3132): refactor(memory): drop cluster_remove and cluster_dissolve actions (task #1938)
- [`8e3a8bd`](https://github.com/zumik3-del/synaptomind/commit/8e3a8bd8fa19481044ca2a200dc2ef214ea11fdd): ci: drop the per-PR Docker build job (task #1955)
- [`78d7ce6`](https://github.com/zumik3-del/synaptomind/commit/78d7ce612177f172d3cc8aafa91c34dbb09f508a): refactor(memory): retire the profile/persona surface (task #1939)
- [`03db3d5`](https://github.com/zumik3-del/synaptomind/commit/03db3d582c45087f9fec315217b3f16ccac90465): refactor(db): drop thought_verify and retired tombstones (task #1941)
- [`94f5f74`](https://github.com/zumik3-del/synaptomind/commit/94f5f7468a6722e640953f897f6640667c53a675): refactor(decay): remove the unreachable auto-archive branch (task #1943)
- [`a984738`](https://github.com/zumik3-del/synaptomind/commit/a984738c4b2ef5bc247c706fe50f2629e4857464): refactor(memory): remove the auto-link and edge-detect surfaces (task #1937)
- [`1778928`](https://github.com/zumik3-del/synaptomind/commit/1778928dc2c5f6f06a6893fbc600538c5fa9e925): fix(ttl): make archived-thought TTL deletion opt-in (task #1944)
- [`7c383d7`](https://github.com/zumik3-del/synaptomind/commit/7c383d735c604a19db687a7d4d1277d95cfed3e9): test: resolve vec0.so from the main checkout in a fresh worktree (task #1935)

## v0.15.0

> October 22, 2026

- [`2f5cc28`](https://github.com/zumik3-del/synaptomind/commit/2f5cc28421fcf51e289097960720ab9a4bd25da7): test: isolate the projects.service mock and the log store singleton (task #1932)
- [`224c0cb`](https://github.com/zumik3-del/synaptomind/commit/224c0cb4cf80626753cb79f8faf076f0735ad3fd): refactor: delete the caller-less src/services/utils.ts (task #1929)
- [`ec6efc8`](https://github.com/zumik3-del/synaptomind/commit/ec6efc809c8f4a339140a806c042d77135811f3e): docs: drop trailing slashes from collection routes in docs/API.md and README (task #1928)
- [`6026eae`](https://github.com/zumik3-del/synaptomind/commit/6026eae87d55e0ca022bb717a3a333e972a21b64): feat(api)!: remove the self-improve subsystem (routes, job, config) (task #1918)
- [`11a9043`](https://github.com/zumik3-del/synaptomind/commit/11a9043b05f3a4c0fe22c9ba3c4f712f5bc7813e): feat(mcp)!: remove the telemetry analytics subsystem (task #1905)
- [`9a148a7`](https://github.com/zumik3-del/synaptomind/commit/9a148a74bb20aab0b7b7afa20c0db55b18c43776): test: pin the primer knob bounds (task #1902)
- [`a92142c`](https://github.com/zumik3-del/synaptomind/commit/a92142ce9fca407c6b4d107590d18ca97294be74): fix(config): clamp the primer knobs so a negative value cannot mean unlimited (task #1901)
- [`67beec7`](https://github.com/zumik3-del/synaptomind/commit/67beec728bc188a41e9b4df849067276adaa5875): fix(health-check): do not flag archived short content in findTooShort
- [`5a1e742`](https://github.com/zumik3-del/synaptomind/commit/5a1e742bae1073aea199a58969a6ef776bb48c25): fix(search): honour primer config thresholds instead of the hardcoded 5
- [`2320a0b`](https://github.com/zumik3-del/synaptomind/commit/2320a0b25becd0f3511aca1e22d214324dc80f39): feat(mcp): default tags merge, add created_after filter, condense guide

## v0.14.1

> October 20, 2026

- [`8bda21c`](https://github.com/zumik3-del/synaptomind/commit/8bda21c346251fe9e9e6f030be747d15db7f4a15): docs(mcp): keep key nuances in review tool description
- [`4047d1a`](https://github.com/zumik3-del/synaptomind/commit/4047d1ad731f12fe5a1af7a173fa63abc102f1e1): docs(mcp): condense tool descriptions for consistency
- [`4cab6fc`](https://github.com/zumik3-del/synaptomind/commit/4cab6fc29c13621a67b4a6574ccc6989ffaab661): docs(mcp): condense memory_guide without losing meaning
- [`628de41`](https://github.com/zumik3-del/synaptomind/commit/628de41a109aebcd8614b7e873694853926c2de1): chore: remove stray _httptest.test.ts accidentally added in #1838
- [`c28114b`](https://github.com/zumik3-del/synaptomind/commit/c28114bd4c8d3c22da0900d00658ff53b2d7f2d3): feat(mcp): configurable per-enqueue proposal cap + grouped output (#1839)
- [`dfbdbf2`](https://github.com/zumik3-del/synaptomind/commit/dfbdbf2e3fb3454fee4c1a6503565ae7068a92c9): feat(mcp): add limit/offset pagination to pending_items slot (#1838)
- [`342df6e`](https://github.com/zumik3-del/synaptomind/commit/342df6ed298cbb0d005d3b638ea298094c80ba42): feat(mcp): retype response includes old_edge_id and new_edge_id (#1837)
- [`d2258a3`](https://github.com/zumik3-del/synaptomind/commit/d2258a37ab5644d4bf017dcdb9426bde00afe745): feat(mcp): add tags_mode (replace/merge) to memory_store update (#1836)
- [`5ec4cd1`](https://github.com/zumik3-del/synaptomind/commit/5ec4cd16ce75072e9648fee277d69dacc9de9198): feat(mcp): clarify health score breakdown (critical/warning/info) (#1835)
- [`72dc96f`](https://github.com/zumik3-del/synaptomind/commit/72dc96f0b6d61088c6fe457764c1377dd6723225): feat(mcp): add source_thought_id filter to memory_review list (#1834)
- [`869c895`](https://github.com/zumik3-del/synaptomind/commit/869c895f1aab5c667935ec834a2f276f657526db): docs(mcp): group SynaptoMind MCP tools into Runtime/Nightly in memory_guide (#1840)

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
