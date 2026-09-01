import { z } from 'zod/v4'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { createSmartNoteService, listSmartNotesWithReady, evalAllSmartNotes, promoteSmartNote, deleteSmartNote } from '../../services/smart_notes.service'
import { jsonResult, errorResult } from './utils'

export function registerSmartNoteTools(server: McpServer) {
  server.tool('create_smart_note', 'Create a smart note for a thought with a surface condition', {
    thought_id: z.string().describe('Thought ID'),
    surface_condition: z.record(z.string(), z.any()).describe('Surface condition object')
  }, async (args) => {
    try {
      const note = createSmartNoteService(args.thought_id, args.surface_condition as any)
      return jsonResult(note)
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : 'Failed to create smart note')
    }
  })

  server.tool('list_smart_notes', 'List all smart notes with readiness', {}, async () => {
    try {
      const notes = listSmartNotesWithReady()
      return jsonResult(notes)
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : 'Failed to list smart notes')
    }
  })

  server.tool('eval_smart_notes', 'Batch evaluate all smart notes', {}, async () => {
    try {
      const results = evalAllSmartNotes()
      return jsonResult(results)
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : 'Failed to evaluate smart notes')
    }
  })

  server.tool('promote_smart_note', 'Promote a ready smart note', {
    note_id: z.string().describe('Smart note ID')
  }, async (args) => {
    try {
      const result = promoteSmartNote(args.note_id)
      return jsonResult(result)
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : 'Failed to promote smart note')
    }
  })

  server.tool('delete_smart_note', 'Delete a smart note', {
    note_id: z.string().describe('Smart note ID')
  }, async (args) => {
    try {
      deleteSmartNote(args.note_id)
      return jsonResult({ deleted: true })
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : 'Failed to delete smart note')
    }
  })
}
