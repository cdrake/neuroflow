export type NeuroflowType = string

export interface ParameterDef {
  type: NeuroflowType
  description: string
  optional?: boolean
  default?: unknown
  enum?: unknown[]
  min?: number
  max?: number
}

export interface ContextFieldDef extends ParameterDef {
  label?: string
  heuristic?: string
  dependsOn?: string[]
}

export interface BlockDef {
  id: string
  label: string
  description: string
  category: 'Import' | 'Processing' | 'Quality' | 'Output'
  icon?: string
  defaults?: Record<string, unknown>
  exposedFields: string[]
  hiddenFields?: string[]
  contextFields?: Record<string, ContextFieldDef>
  formComponent?: string
  condition?: string
  heuristics?: Record<string, string>
}

export interface ToolDefinition {
  id: string
  name: string
  version: string
  description: string
  inputs: Record<string, ParameterDef>
  outputs: Record<string, ParameterDef>
  block?: BlockDef | BlockDef[]
}

export type Binding = { ref: string } | { constant: unknown }

export interface StepDef {
  tool: string
  inputs: Record<string, Binding>
  outputMappings?: Record<string, string>
  condition?: string
}

export interface WorkflowDocument {
  neuroflow: string
  kind: 'workflow'
  id: string
  version: string
  description: string
  inputs: Record<string, ParameterDef>
  context?: {
    description?: string
    fields: Record<string, ContextFieldDef>
  }
  steps: Record<string, StepDef>
  outputs: Record<string, { type: NeuroflowType; ref: string }>
  extensions?: Record<string, unknown>
}

export interface WorkflowLibraryItem {
  id: string
  label: string
  description: string
  workflow: WorkflowDocument
}

export interface ValidationIssue {
  path?: string
  severity: 'error' | 'warning'
  message: string
}

export interface ValidationReport {
  ok: boolean
  issues: ValidationIssue[]
}

export interface PlanStep {
  id: string
  tool: string
  reads: string[]
  writes: string[]
}

export interface WorkflowPlan {
  workflowId: string
  steps: PlanStep[]
  outputs: string[]
}

export function isRefBinding(binding: Binding | undefined): binding is { ref: string } {
  return !!binding && 'ref' in binding
}

export function isConstantBinding(binding: Binding | undefined): binding is { constant: unknown } {
  return !!binding && 'constant' in binding
}

export function shortType(type: string): string {
  return type.replace(/^core:/, '').replace(/^neuro:/, '')
}

export function stableToolName(toolRef: string): string {
  const parts = toolRef.split('/')
  return parts[parts.length - 1] || toolRef
}
