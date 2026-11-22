import { z } from 'zod/v4'
import { thoughtStatusSchema, timelineLimitSchema } from '../../../validation'

export const RECALL_ARGS = {
  query: z
    .string()
    .optional()
    .describe(
      'Search query (REQUIRED for search/clusters; accepted by context as an alternative to thought_id). REJECTED for get/chain/list.'
    ),
  status: thoughtStatusSchema
    .optional()
    .describe(
      'Filter by status (search/clusters default: active; list default: all). REJECTED for get/context/chain.'
    ),
  project_id: z
    .never({ error: 'project_id was removed; use cwd' })
    .optional()
    .describe('Removed; use cwd.'),
  cwd: z
    .string()
    .optional()
    .describe(
      'Working directory — resolves the project scope reported in meta.scope. OPTIONAL for search/clusters/list/context: omitting it (or passing no registered path) answers across every project and says so in meta.warnings. ACCEPTED AND IGNORED for get/chain.'
    ),
  tag: z
    .string()
    .optional()
    .describe('Filter by tag (search/clusters/list). REJECTED for get/context/chain.'),
  is_cluster: z
    .boolean()
    .optional()
    .describe(
      'Cluster filter: true = cluster thoughts only, false = exclude cluster thoughts (search/clusters/list). REJECTED for get/context/chain.'
    ),
  group_by_cluster: z.boolean().optional().describe('Group results by cluster (search only).'),
  min_importance: z.coerce
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe('Minimum importance (0-1) (search/clusters only).'),
  hybrid: z
    .boolean()
    .optional()
    .describe(
      'Hybrid search: true (default) fuses the vector and BM25 legs via RRF; false restricts results to the vector (embedding) leg only. (search/clusters only).'
    ),
  mode: z
    .never({ error: 'mode was removed; use hybrid' })
    .optional()
    .describe('Removed; use hybrid.'),
  recency_weight: z.coerce
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe(
      'Opt-in recency boost weight (0-1). 0/default preserves relevance-only ranking; >0 adds recency_weight × 0.5^(ageDays/halfLifeDays) to the relevance score and returns recency_score + final_score (search/clusters only).'
    ),
  recency_half_life_days: z.coerce
    .number()
    .positive()
    .max(3650)
    .optional()
    .describe(
      'Recency decay half-life in days (default 30, 1-3650); only used when recency_weight > 0 (search/clusters only).'
    ),
  min_relevance: z.coerce
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe(
      'Relevance gate on the calibrated relevance scale (0-1). Omitted = the measured default 0.4 (a raw cosine of 0.84): cosine-only hits below the threshold are dropped, while BM25-anchored and explicit-id rows are never gated. An explicit 0 disables the gate and restores the fail-open result set. Dropped rows appear as meta.counts.filtered_out, not as a reason (search/clusters only; memory_recall action=context is exempt from the default gate and keeps its pre-gate best match, so a gate there is a service-level opt-in).'
    ),
  supersession_mode: z
    .enum(['off', 'flag', 'suppress'])
    .optional()
    .describe(
      'Superseded thoughts: off (no annotation), flag (annotate), suppress (drop). Agent default: suppress (search only).'
    ),
  contradiction_mode: z
    .enum(['off', 'flag'])
    .optional()
    .describe(
      'Contradicted thoughts: off or flag (default). Contradicted endpoints are never suppressed (search only).'
    ),
  thought_id: z
    .string()
    .optional()
    .describe(
      'REQUIRED for "get" and "chain"; also accepted by "context" (alternative to query). REJECTED for "search", "clusters", "list".'
    ),
  include_edges: z
    .boolean()
    .optional()
    .describe(
      'get only: when true, return incident edges inline (upstream/downstream with type and created_at). Default false.'
    ),
  include_url_links: z
    .boolean()
    .optional()
    .describe(
      "When true, every thought the answer emits carries url_links: [{text, url, label}] ordered by sort_order then creation (text is the stored link key that memory_store create and update set — update replaces the whole set, merge moves the source's links to the target — and label defaults to text). One batch query per response. Default false, where the key is absent; true with no links returns []. Never trimmed by fields and never hidden by compact. Applies to all six actions, including get's upstream/downstream neighbours and chain/context neighbourhoods."
    ),
  direction: z
    .enum(['upstream', 'downstream', 'both'])
    .optional()
    .describe('Traversal direction (default: both) (context/chain only).'),
  max_degree: z.coerce
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .describe(
      'Max edges to return for chain/context/get (default 50, 1-200). REJECTED for search/clusters/list.'
    ),
  limit: timelineLimitSchema
    .optional()
    .describe(
      'Max results for search/clusters (default 10) or list page size (default 50). REJECTED for get/context/chain.'
    ),
  offset: z.coerce
    .number()
    .int()
    .min(0)
    .max(1_000_000)
    .optional()
    .describe('list only: offset for pagination. REJECTED for all other actions.'),
  compact: z
    .boolean()
    .optional()
    .describe(
      'Compact output (default true): each hit keeps the minimal thought fields (id, content, status, tags as strings, project) and no score block, but safety annotations are never hidden — standing is emitted unless it is "current", and superseded_by/contradicted_by plus low_confidence: true whenever they apply. compact=false adds the opt-in ranking metadata: scores { similarity, distance, rrf_score, bm25_score, relevance, recency_score, final_score }, match_source, and the neutral standing: "current"/low_confidence: false values. Also shapes the thought objects of get/context/chain/list; get\'s include_edges output stays under both settings.'
    ),
  fields: z
    .array(z.string())
    .optional()
    .describe(
      "Thought columns to include in each output thought. Selects on the shaped thought only, so the ranking metadata (scores, match_source — which also drops the ['id'] label of an id-addressed hit) is dropped from search hits when set; safety annotations (standing, superseded_by, contradicted_by, low_confidence) and get's include_edges output are not thought columns and remain. Explicit fields win over compact. OPTIONAL for all actions."
    ),
  top_k: z
    .never({ error: 'top_k was removed; use limit' })
    .optional()
    .describe('Removed; use limit.'),
  cluster: z
    .never({ error: 'cluster was removed; use is_cluster' })
    .optional()
    .describe('Removed; use is_cluster.')
}
