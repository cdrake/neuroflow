import type { Binding, BlockDef, ContextFieldDef, StepDef, ToolDefinition, WorkflowDocument } from './neuroflow'
import { isConstantBinding, isRefBinding, shortType, stableToolName } from './neuroflow'
import { isTypeCompatible } from './typeCompatibility'

export const REGISTRY_EXTENSION_KEY = 'neuroflow/registry'

export type ToolProviderKind = 'console' | 'webForm' | 'webService' | 'neuroflow'

export interface ToolProviderDescriptor {
  kind: ToolProviderKind
  label: string
  source: string
  runtime?: 'sidecar' | 'external' | 'browser' | 'service' | 'internal'
}

export interface RegistryFormField {
  key: string
  label: string
  type: string
  description: string
  required: boolean
  default?: unknown
  enum?: unknown[]
  min?: number
  max?: number
  binding?: Binding
}

export interface ToolRegistryEntry {
  id: string
  label: string
  description: string
  category: BlockDef['category']
  tool: ToolDefinition
  block?: BlockDef
  provider: ToolProviderDescriptor
  formComponent?: string
  fields: RegistryFormField[]
  requiredInputs: string[]
}

export interface SourceSuggestion {
  ref: string
  type: string
  label: string
  exact: boolean
}

interface RegistryExtension {
  provider?: Partial<ToolProviderDescriptor>
}

export function buildToolRegistry(tools: ToolDefinition[]): ToolRegistryEntry[] {
  const entries: ToolRegistryEntry[] = []

  for (const tool of tools) {
    const blocks = getToolBlocks(tool)
    const provider = getToolProvider(tool)
    if (blocks.length === 0) {
      entries.push({
        id: `${tool.id}:default`,
        label: tool.name,
        description: tool.description,
        category: 'Processing',
        tool,
        provider,
        fields: fieldsForTool(tool),
        requiredInputs: requiredInputNames(tool)
      })
      continue
    }

    for (const block of blocks) {
      entries.push({
        id: `${tool.id}:${block.id}`,
        label: block.label,
        description: block.description,
        category: block.category,
        tool,
        block,
        provider,
        formComponent: block.formComponent,
        fields: fieldsForBlock(tool, block),
        requiredInputs: requiredInputNames(tool)
      })
    }
  }

  return entries
}

export function getToolProvider(tool: ToolDefinition): ToolProviderDescriptor {
  const extension = readRegistryExtension(tool)
  if (extension?.provider?.kind && isProviderKind(extension.provider.kind)) {
    return {
      kind: extension.provider.kind,
      label: extension.provider.label ?? providerLabel(extension.provider.kind),
      source: extension.provider.source ?? 'Tool registry',
      runtime: extension.provider.runtime
    }
  }

  return {
    kind: 'neuroflow',
    label: 'NeuroFlow component',
    source: 'Built-in NeuroFlow registry',
    runtime: 'internal'
  }
}

export function createStepFromRegistryEntry(
  entry: ToolRegistryEntry,
  workflow: WorkflowDocument,
  toolMap: Map<string, ToolDefinition>
): StepDef {
  const inputs: Record<string, Binding> = {}
  const block = entry.block

  for (const [name, def] of Object.entries(entry.tool.inputs)) {
    const blockDefault = block?.defaults?.[name]
    if (blockDefault !== undefined) {
      inputs[name] = bindingFromDefault(blockDefault)
      continue
    }

    if (def.default !== undefined) {
      inputs[name] = { constant: def.default }
      continue
    }

    if (def.optional) continue

    const suggestion = getSourceSuggestions(workflow, toolMap, def.type).find((candidate) => candidate.exact)
      ?? getSourceSuggestions(workflow, toolMap, def.type)[0]
    if (suggestion) {
      inputs[name] = { ref: suggestion.ref }
    }
  }

  return {
    tool: entry.tool.id,
    inputs,
    extensions: {
      [REGISTRY_EXTENSION_KEY]: {
        provider: entry.provider.kind,
        form: entry.formComponent ?? entry.block?.id ?? 'default',
        source: entry.provider.source
      }
    }
  }
}

export function mergeRegistryContext(
  workflow: WorkflowDocument,
  entry: ToolRegistryEntry
): WorkflowDocument['context'] {
  const contextFields = entry.block?.contextFields
  if (!contextFields) return workflow.context

  return {
    description: workflow.context?.description,
    fields: {
      ...(workflow.context?.fields ?? {}),
      ...contextFields
    }
  }
}

export function getSourceSuggestions(
  workflow: WorkflowDocument,
  toolMap: Map<string, ToolDefinition>,
  inputType: string,
  selectedStep?: string | null
): SourceSuggestion[] {
  const suggestions: SourceSuggestion[] = []

  for (const [name, def] of Object.entries(workflow.inputs)) {
    pushSuggestion(suggestions, `inputs.${name}`, def.type, `input ${name}`, inputType)
  }

  for (const [name, def] of Object.entries(workflow.context?.fields ?? {})) {
    pushSuggestion(suggestions, `context.${name}`, def.type, `context ${name}`, inputType)
  }

  for (const [stepId, step] of Object.entries(workflow.steps)) {
    if (stepId === selectedStep) continue
    const tool = toolMap.get(step.tool) ?? toolMap.get(stableToolName(step.tool))
    for (const [outputName, output] of Object.entries(tool?.outputs ?? {})) {
      pushSuggestion(
        suggestions,
        `steps.${stepId}.outputs.${outputName}`,
        output.type,
        `${stepId} output ${outputName}`,
        inputType
      )
    }
  }

  return suggestions.sort((a, b) => {
    if (a.exact !== b.exact) return a.exact ? -1 : 1
    return a.ref.localeCompare(b.ref)
  })
}

export function missingRequiredInputs(step: StepDef, tool: ToolDefinition): string[] {
  return requiredInputNames(tool).filter((name) => {
    const binding = step.inputs[name]
    if (!binding) return true
    if (isRefBinding(binding)) return binding.ref.trim() === ''
    if (isConstantBinding(binding)) return binding.constant === ''
    return true
  })
}

function fieldsForTool(tool: ToolDefinition): RegistryFormField[] {
  return Object.entries(tool.inputs).map(([key, def]) => ({
    key,
    label: humanize(key),
    type: def.type,
    description: def.description,
    required: def.optional !== true,
    default: def.default,
    enum: def.enum,
    min: def.min,
    max: def.max
  }))
}

function fieldsForBlock(tool: ToolDefinition, block: BlockDef): RegistryFormField[] {
  const keys = new Set([
    ...block.exposedFields,
    ...(block.requiredContextFields ?? []),
    ...Object.keys(block.contextFields ?? {})
  ])

  return Array.from(keys).map((key) => {
    const toolInput = tool.inputs[key]
    const contextField = block.contextFields?.[key]
    const def = contextField ?? toolInput ?? genericContextField(key)
    const bindingDefault = block.defaults?.[key]

    return {
      key,
      label: contextField?.label ?? humanize(key),
      type: def.type,
      description: def.description,
      required: toolInput ? toolInput.optional !== true : contextField?.optional !== true,
      default: def.default,
      enum: def.enum,
      min: def.min,
      max: def.max,
      binding: bindingDefault !== undefined ? bindingFromDefault(bindingDefault) : undefined
    }
  })
}

function pushSuggestion(
  suggestions: SourceSuggestion[],
  ref: string,
  sourceType: string,
  label: string,
  inputType: string
): void {
  if (!isTypeCompatible(sourceType, inputType)) return
  suggestions.push({
    ref,
    type: sourceType,
    label: `${label} (${shortType(sourceType)})`,
    exact: sourceType === inputType
  })
}

function requiredInputNames(tool: ToolDefinition): string[] {
  return Object.entries(tool.inputs)
    .filter(([, def]) => def.optional !== true && def.default === undefined)
    .map(([name]) => name)
}

function getToolBlocks(tool: ToolDefinition): BlockDef[] {
  if (!tool.block) return []
  return Array.isArray(tool.block) ? tool.block : [tool.block]
}

function bindingFromDefault(value: unknown): Binding {
  if (isObject(value) && (isRefBinding(value as Binding) || isConstantBinding(value as Binding))) {
    return value as Binding
  }
  return { constant: value }
}

function readRegistryExtension(tool: ToolDefinition): RegistryExtension | null {
  const raw = tool.extensions?.[REGISTRY_EXTENSION_KEY]
  return isObject(raw) ? (raw as RegistryExtension) : null
}

function isProviderKind(value: unknown): value is ToolProviderKind {
  return value === 'console' || value === 'webForm' || value === 'webService' || value === 'neuroflow'
}

function providerLabel(kind: ToolProviderKind): string {
  switch (kind) {
    case 'console':
      return 'Console app'
    case 'webForm':
      return 'Web form'
    case 'webService':
      return 'Web service'
    case 'neuroflow':
      return 'NeuroFlow component'
  }
}

function genericContextField(key: string): ContextFieldDef {
  return {
    type: 'core:object',
    label: humanize(key),
    description: `${humanize(key)} form value.`
  }
}

function humanize(value: string): string {
  return value
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\b\w/g, (char) => char.toUpperCase())
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
