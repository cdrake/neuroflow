// The gallery is the registry the builder edits against: every tool document in
// gallery/tools and every workflow in gallery/workflows is bundled at build time,
// so the palette and the library always match what the MCP server and the Tauri
// host can run. Tool documents carry no `name`; the id tail stands in.
import type { ToolDefinition, WorkflowDocument, WorkflowLibraryItem } from '../domain/neuroflow'

const toolDocs = import.meta.glob<Record<string, unknown>>('../../gallery/tools/*.tool.json', {
  eager: true,
  import: 'default'
})

const workflowDocs = import.meta.glob<WorkflowDocument>('../../gallery/workflows/*.neuroflow.json', {
  eager: true,
  import: 'default'
})

export const MCP_EXTENSION_KEY = 'neuroflow/mcp'

export const tools: ToolDefinition[] = Object.values(toolDocs)
  .map((doc) => {
    const id = String(doc.id)
    return { ...doc, id, name: idTail(id) } as unknown as ToolDefinition
  })
  .sort((a, b) => a.id.localeCompare(b.id))

export const library: WorkflowLibraryItem[] = Object.values(workflowDocs)
  .map((workflow) => ({
    id: workflow.id,
    label: workflowTitle(workflow),
    description: workflow.description,
    workflow
  }))
  .sort((a, b) => a.label.localeCompare(b.label))

export function idTail(id: string): string {
  return id.split('/').pop() ?? id
}

export function workflowTitle(workflow: WorkflowDocument): string {
  const mcp = workflow.extensions?.[MCP_EXTENSION_KEY]
  const title = isObject(mcp) && typeof mcp.title === 'string' ? mcp.title.trim() : ''
  return title || humanize(idTail(workflow.id))
}

export function humanize(value: string): string {
  return value
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\b\w/g, (char) => char.toUpperCase())
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
