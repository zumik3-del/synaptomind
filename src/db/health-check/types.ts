export interface OrphanEdge {
  id: string
  source_id: string
  target_id: string
  type: string
  missing_side: 'source' | 'target' | 'both'
}

export interface SelfLoopEdge {
  id: string
  source_id: string
  type: string
}

export interface DuplicateEdge {
  source_id: string
  target_id: string
  type: string
  count: number
}

export interface ClusterViolation {
  thought_id: string
  content: string
  edge_type: string
  other_id: string
}

export interface EmptyCluster {
  id: string
  content: string
}

export interface SingletonCluster {
  id: string
  content: string
  member_count: number
}

export interface OrphanedClusterMember {
  thought_id: string
  content: string
  cluster_edge_id: string
}

export interface ClusterlessDense {
  id: string
  content: string
  edge_count: number
}

export interface IslandThought {
  id: string
  content: string
  status: string
}

export interface OverlinkedThought {
  id: string
  content: string
  edge_count: number
}

export interface DuplicateContent {
  id_a: string
  id_b: string
  content_a: string
  content_b: string
  similarity: number
}

export interface TooShortThought {
  id: string
  content: string
  length: number
}

export interface TestRemnant {
  id: string
  content: string
}

export interface StaleDraft {
  id: string
  content: string
  created_at: string
  age_days: number
}

export interface UntaggedThought {
  id: string
  content: string
  status: string
}

export interface CircularChain {
  cycle: string[]
}

export interface BrokenParentChain {
  edge_id: string
  source_id: string
  target_id: string
  target_status: string
}

export interface ReplacesChain {
  chain: string[]
}

export interface ContradictsWithHierarchy {
  edge_id: string
  source_id: string
  target_id: string
}

export interface ContradictsRedundantWithReplaces {
  contradicts_edge_id: string
  replaces_edge_id: string
  source_id: string
  target_id: string
}

export interface ContradictionInCluster {
  cluster_id: string
  member_a: string
  member_b: string
  contradicts_edge_id: string
}

export interface ContradictsToArchived {
  edge_id: string
  source_id: string
  target_id: string
}

export interface SupportsSelfConflict {
  supports_edge_id: string
  contradicts_edge_id: string
  source_id: string
  target_id: string
}

export interface MissingEmbedding {
  id: string
  content: string
}

export interface DeadPrimer {
  thought_id: string
  content: string
  hit_count: number
}

export interface ImportanceOutlier {
  id: string
  content: string
  importance: number
  direction: 'low' | 'high'
}
