export type NeuroflowType = string

export type ToolIOChannel =
  | 'value'
  | 'stdin'
  | 'stdout'
  | 'stderr'
  | 'argument'
  | 'filesystem'
  | 'serviceRequest'
  | 'serviceResponse'
  | 'uiSession'

export type ToolIOFormat =
  | 'text'
  | 'json'
  | 'jsonl'
  | 'path'
  | 'paths'
  | 'file'
  | 'directory'
  | 'binary'
  | 'nifti'
  | 'omezarr'
  | 'ngffzarr'
  | 'tract'
  | 'mesh'
  | 'dicom'
  | 'bids'
  | 'uiState'

export type ToolUISessionCompletion = 'appClosed' | 'outputsAvailable' | 'manualConfirm'

export interface ToolUIWatchSpec {
  rootInput?: string
  path?: string
  glob?: string
  debounceMs?: number
  required?: boolean
}

export interface ToolUICompletionPolicy {
  continueWhen: ToolUISessionCompletion
  requiredOutputs?: string[]
  timeoutMs?: number
}

export type ToolPipeMode = 'stdin' | 'argument' | 'file'

export interface ToolPipePolicy {
  safe: boolean
  modes: ToolPipeMode[]
  description?: string
}

export interface ToolOutputAvailability {
  source: Extract<ToolIOChannel, 'value' | 'stdout' | 'stderr' | 'filesystem' | 'serviceResponse' | 'uiSession'>
  format?: ToolIOFormat
  selector?: string
  sessionKey?: string
  glob?: string
  watch?: ToolUIWatchSpec
  completion?: ToolUICompletionPolicy
  encoding?: 'utf-8' | 'binary'
  pipe?: ToolPipePolicy
}

export interface ToolInputConsumption {
  channel: Extract<ToolIOChannel, 'stdin' | 'argument' | 'filesystem' | 'serviceRequest'>
  format?: ToolIOFormat
  argument?: string
  acceptsPipe?: boolean
  description?: string
}

export interface TypeQualifiers {
  formats?: string[] | `inputs.${string}`
  space?: string
  resolution?: number | [number, number, number] | `inputs.${string}`
  density?: string
  labelSystem?: string
}

export interface ParameterDef extends TypeQualifiers {
  type: NeuroflowType
  description: string
  optional?: boolean
  default?: unknown
  enum?: unknown[]
  min?: number
  max?: number
  availableFrom?: ToolOutputAvailability[]
  consumesAs?: ToolInputConsumption[]
  extensions?: Record<string, unknown>
}

export interface ContextFieldDef extends ParameterDef {
  label?: string
  heuristic?: string
  dependsOn?: string[]
}

export type WorkflowStage = 'ingest' | 'explore' | 'publish'

export interface StageInfo {
  id: WorkflowStage
  label: string
  description: string
}

/**
 * Stages are an informal, opt-in grouping used for tool discovery ("show me
 * Ingest tools"). They are deliberately NOT load-bearing: nothing in the runtime
 * branches on a stage. The reference adapters (BIDSvue for ingest, NeuroVue for
 * explore) are defaults, not requirements — any tool, including custom ones like
 * "open a file" or "run a python script", can be tagged into any stage, and
 * untagged tools simply group under "Other".
 */
export const WORKFLOW_STAGES: StageInfo[] = [
  {
    id: 'ingest',
    label: 'Ingest',
    description: 'Bring data in and shape it into a dataset. Reference: BIDSvue / bidsui.'
  },
  {
    id: 'explore',
    label: 'Explore',
    description: 'Review, correct, and process artifacts. Reference: NeuroVue.'
  },
  {
    id: 'publish',
    label: 'Publish',
    description: 'Compose figures, captions, graphs, and reports from results.'
  }
]

export function stageInfo(stage: WorkflowStage): StageInfo {
  return WORKFLOW_STAGES.find((item) => item.id === stage) ?? WORKFLOW_STAGES[0]
}

export interface BlockDef {
  id: string
  label: string
  description: string
  category: 'Import' | 'Processing' | 'Quality' | 'Output'
  stage?: WorkflowStage
  icon?: string
  defaults?: Record<string, unknown>
  exposedFields: string[]
  hiddenFields?: string[]
  requiredContextFields?: string[]
  contextFields?: Record<string, ContextFieldDef>
  formComponent?: string
  condition?: string
  heuristics?: Record<string, string>
}

export interface ToolDefinition {
  neuroflow?: string
  kind?: 'tool'
  id: string
  name: string
  version: string
  description: string
  inputs: Record<string, ParameterDef>
  outputs: Record<string, ParameterDef>
  block?: BlockDef | BlockDef[]
  extensions?: Record<string, unknown>
}

export type Binding = { ref: string } | { constant: unknown }

export interface StepDef {
  tool: string
  stage?: WorkflowStage
  inputs: Record<string, Binding>
  outputMappings?: Record<string, string>
  condition?: string
  extensions?: Record<string, unknown>
}

export interface WorkflowDocument {
  $schema?: string
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
  outputs: Record<string, TypeQualifiers & { type: NeuroflowType; ref: string }>
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
  const parts = parseToolRef(toolRef).id.split('/')
  return parts[parts.length - 1] || toolRef
}

export function qualifiedToolRef(tool: { id: string; version: string }): string {
  return `${tool.id}@${tool.version}`
}

export function parseToolRef(toolRef: string): { id: string; version?: string } {
  const versionSeparator = toolRef.lastIndexOf('@')
  if (versionSeparator <= 0) return { id: toolRef }

  const id = toolRef.slice(0, versionSeparator)
  const version = toolRef.slice(versionSeparator + 1)
  if (!id || !version) return { id: toolRef }

  return { id, version }
}
