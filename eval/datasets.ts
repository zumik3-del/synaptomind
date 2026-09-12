// Labeled scenarios covering the eight categories from GitHub issue #124.
//
// Scenarios whose underlying feature is not implemented yet are marked
// `outcome: 'xfail'` — they are still executed and reported, but can never
// fail the run:
//   - supersession-aware retrieval is issue #124 item 3
//   - contradiction edges/handling is issue #124 item 2
//
// Distractors keep precision@k meaningful (the corpora are larger than top-k).

import type { EvalScenario, EvalThought } from './types'

const DISTRACTORS: EvalThought[] = [
  { id: 'd1', content: 'The marketing crew launched a newsletter campaign for autumn.' },
  { id: 'd2', content: 'Kubernetes cluster autoscaling thresholds were tuned last week.' },
  { id: 'd3', content: 'The office espresso machine needs a replacement water filter.' },
  { id: 'd4', content: 'A rare bird species was observed near the northern lake.' },
  { id: 'd5', content: 'The quarterly budget review is scheduled for Friday afternoon.' },
  { id: 'd6', content: 'Ancient Roman aqueducts used gravity to transport water across valleys.' }
]

export const EVAL_SCENARIOS: EvalScenario[] = [
  {
    name: 'explicit-fact-recall',
    category: 'explicit-fact',
    description: 'A distinctive single fact is retrieved for a direct query.',
    thoughts: [
      { id: 'port-api', content: 'The production API server listens on port 3005.', projectId: 'infra' },
      { id: 'port-mcp', content: 'The MCP server listens on port 3006.', projectId: 'infra' },
      {
        id: 'db-file',
        content: 'The production SQLite database file path is data/synaptomind.db.',
        projectId: 'infra'
      },
      ...DISTRACTORS
    ],
    queries: [
      { query: 'production api server port', relevant: ['port-api'] },
      { query: 'mcp server port', relevant: ['port-mcp'] },
      { query: 'production sqlite database file path', relevant: ['db-file'] }
    ]
  },
  {
    name: 'compositional-multi-hop',
    category: 'multi-hop',
    description: 'A compositional query surfaces every supporting fact.',
    thoughts: [
      { id: 'hop-alice', content: 'Alice leads the platform team.', projectId: 'org' },
      { id: 'hop-owner', content: 'The platform team owns the billing service.', projectId: 'org' },
      { id: 'hop-db', content: 'The billing service uses the PostgreSQL database.', projectId: 'org' },
      ...DISTRACTORS
    ],
    queries: [
      { query: 'platform team billing service database', relevant: ['hop-owner', 'hop-db'], topK: 5 },
      { query: 'who leads the platform team', relevant: ['hop-alice'] }
    ]
  },
  {
    name: 'temporal-current-vs-old',
    category: 'temporal',
    description: 'Current facts contain the distinguishing current-state terms.',
    thoughts: [
      { id: 't-current', content: 'As of 2026 the deploy target image tag is release-7000.' },
      { id: 't-old', content: 'Before 2025 the deploy target image tag was release-1000.' },
      ...DISTRACTORS
    ],
    queries: [
      {
        query: '2026 deploy target image tag',
        relevant: ['t-current'],
        rankBefore: { before: 't-current', after: 't-old' }
      },
      {
        query: 'before 2025 deploy target image tag',
        relevant: ['t-old'],
        rankBefore: { before: 't-old', after: 't-current' }
      }
    ]
  },
  {
    name: 'supersession-old-not-current',
    category: 'supersession',
    description: 'A superseded thought must not be returned as current (item 3, not implemented).',
    outcome: 'xfail',
    thoughts: [
      { id: 's-old', content: 'The primary database engine is MySQL.' },
      { id: 's-new', content: 'The primary database engine is PostgreSQL now.' }
    ],
    edges: [{ source: 's-new', target: 's-old', type: 'replaces' }],
    queries: [{ query: 'primary database engine', relevant: ['s-new'], forbid: ['s-old'] }]
  },
  {
    name: 'contradiction-resolution',
    category: 'contradiction',
    description: 'Contradicting facts cannot be resolved without contradiction edges (item 2).',
    outcome: 'xfail',
    thoughts: [
      { id: 'c-a', content: 'The service region is us-east-1.' },
      { id: 'c-b', content: 'The service region is eu-west-1.' }
    ],
    queries: [{ query: 'service region', relevant: ['c-a'], forbid: ['c-b'] }]
  },
  {
    name: 'consolidated-knowledge',
    category: 'consolidation',
    description: 'A consolidated cluster thought is retrievable from the cluster content.',
    thoughts: [
      { id: 'm1', content: 'Deploy pipeline note: builds run on every push.' },
      { id: 'm2', content: 'Deploy pipeline note: releases are tagged manually.' },
      {
        id: 'cluster',
        content: 'Consolidated knowledge: deploy pipeline notes covering builds and releases.',
        isCluster: true
      },
      ...DISTRACTORS
    ],
    edges: [
      { source: 'cluster', target: 'm1', type: 'cluster' },
      { source: 'cluster', target: 'm2', type: 'cluster' }
    ],
    queries: [{ query: 'consolidated deploy pipeline notes', relevant: ['cluster'] }]
  },
  {
    name: 'project-scope-isolation',
    category: 'project-scope',
    description: 'Project filters never leak thoughts from another project.',
    thoughts: [
      {
        id: 'alpha-roadmap',
        content: 'Alpha project secret roadmap includes launching the new pricing plan.',
        projectId: 'alpha'
      },
      {
        id: 'beta-roadmap',
        content: 'Beta project secret roadmap includes migrating the legacy billing system.',
        projectId: 'beta'
      },
      ...DISTRACTORS
    ],
    queries: [
      {
        query: 'secret roadmap',
        relevant: ['alpha-roadmap'],
        projectFilter: 'alpha',
        forbid: ['beta-roadmap']
      },
      {
        query: 'secret roadmap',
        relevant: ['beta-roadmap'],
        projectFilter: 'beta',
        forbid: ['alpha-roadmap']
      }
    ]
  },
  {
    name: 'retrieval-quality',
    category: 'retrieval-quality',
    description: 'Mixed queries measure recall, precision, MRR and hit rate together.',
    thoughts: [
      { id: 'rq-api', content: 'The HTTP API exposes a thoughts endpoint on port 3005.' },
      { id: 'rq-mcp', content: 'The MCP server exposes memory tools over stdio.' },
      { id: 'rq-db', content: 'Thoughts are stored in SQLite using vector and full-text indexes.' },
      { id: 'rq-embed', content: 'Embeddings are produced by a local huggingface model in a child process.' },
      { id: 'rq-decay', content: 'Importance decays over time and stale thoughts are archived.' },
      ...DISTRACTORS
    ],
    queries: [
      { query: 'http api thoughts endpoint port', relevant: ['rq-api'] },
      { query: 'mcp server memory tools stdio', relevant: ['rq-mcp'] },
      { query: 'sqlite vector full-text indexes', relevant: ['rq-db'] },
      { query: 'local huggingface embeddings child process', relevant: ['rq-embed'] },
      { query: 'importance decay archived stale thoughts', relevant: ['rq-decay'] }
    ]
  }
]
