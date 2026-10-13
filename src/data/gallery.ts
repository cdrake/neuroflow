// The gallery is the registry the builder edits against by default: every tool
// document in gallery/tools and every workflow in gallery/workflows is bundled at
// build time. More registries (a Neurodesk bundle, a lab's own tools) load at run
// time through src/data/registrySources.ts. Tool documents carry no `name`; the id
// tail stands in.
import type { ToolDefinition, WorkflowDocument, WorkflowLibraryItem } from '../domain/neuroflow'
import { libraryItemFromWorkflow, toolFromDocument } from './documents'

export { MCP_EXTENSION_KEY, humanize, idTail, libraryItemFromWorkflow, mcpTitle, toolFromDocument, workflowTitle } from './documents'

const toolDocs = import.meta.glob<Record<string, unknown>>('../../gallery/tools/*.tool.json', {
  eager: true,
  import: 'default'
})

const workflowDocs = import.meta.glob<WorkflowDocument>('../../gallery/workflows/*.neuroflow.json', {
  eager: true,
  import: 'default'
})

export const tools: ToolDefinition[] = Object.values(toolDocs)
  .map(toolFromDocument)
  .sort((a, b) => a.id.localeCompare(b.id))

export const library: WorkflowLibraryItem[] = Object.values(workflowDocs)
  .map(libraryItemFromWorkflow)
  .sort((a, b) => a.label.localeCompare(b.label))
