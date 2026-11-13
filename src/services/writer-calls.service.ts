import type { PlacementProposalRow } from '../db/placement-proposals'
import type { PlannedEdge } from './apply-gates.service'

export type WriterDirection = 'apply' | 'rollback'

export type WriterCall =
  | { writer: 'createEdgeService'; args: { sourceId: string; targetId: string; type: string } }
  | { writer: 'deleteEdgeService'; args: { id: string } }

export type ApplyWriterCall = Exclude<WriterCall, { writer: 'deleteEdgeService' }>

export function parseResult(raw: string | null): Record<string, unknown> {
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function createdEdgeId(row: PlacementProposalRow): string | undefined {
  const value = parseResult(row.result).edge_id
  return typeof value === 'string' ? value : undefined
}

export function planWriterCalls(
  row: PlacementProposalRow,
  direction: WriterDirection,
  edge?: PlannedEdge
): WriterCall[] | undefined {
  if (row.item_kind === 'edge') {
    if (direction === 'rollback') {
      const edgeId = createdEdgeId(row)
      return edgeId ? [{ writer: 'deleteEdgeService', args: { id: edgeId } }] : []
    }
    if (!edge) return undefined
    return [
      {
        writer: 'createEdgeService',
        args: { sourceId: edge.sourceId, targetId: edge.targetId, type: edge.type }
      }
    ]
  }

  return undefined
}
