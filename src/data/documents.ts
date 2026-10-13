// Pure helpers that turn NeuroFlow documents into the builder's palette and
// library entries. Shared by the bundled gallery and run-time registries.
import type { ToolDefinition, WorkflowDocument, WorkflowLibraryItem } from '../domain/neuroflow'

export const MCP_EXTENSION_KEY = 'neuroflow/mcp'

/** A tool document as the builder uses it: `name` is the id tail. */
export function toolFromDocument(doc: Record<string, unknown>): ToolDefinition {
  const id = String(doc.id)
  return { ...doc, id, name: idTail(id) } as unknown as ToolDefinition
}

export function libraryItemFromWorkflow(workflow: WorkflowDocument): WorkflowLibraryItem {
  return {
    id: workflow.id,
    label: workflowTitle(workflow),
    description: workflow.description,
    workflow
  }
}

export function idTail(id: string): string {
  return id.split('/').pop() ?? id
}

export function workflowTitle(workflow: WorkflowDocument): string {
  return mcpTitle(workflow) || humanize(idTail(workflow.id))
}

/** The `neuroflow/mcp` title of a tool or workflow document, or '' when it has none. */
export function mcpTitle(doc: { extensions?: Record<string, unknown> }): string {
  const mcp = doc.extensions?.[MCP_EXTENSION_KEY]
  return isObject(mcp) && typeof mcp.title === 'string' ? mcp.title.trim() : ''
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
