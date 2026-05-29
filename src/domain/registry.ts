import type {
  Binding,
  BlockDef,
  ContextFieldDef,
  StepDef,
  ToolDefinition,
  ToolInputConsumption,
  ToolOutputAvailability,
  WorkflowDocument
} from './neuroflow'
import { isConstantBinding, isRefBinding, parseToolRef, qualifiedToolRef, shortType, stableToolName } from './neuroflow'
import { isTypeCompatible } from './typeCompatibility'

export const REGISTRY_EXTENSION_KEY = 'neuroflow/registry'

export type ToolProviderKind = 'console' | 'webForm' | 'webService' | 'uiApp' | 'neuroflow'

export interface ToolProviderDescriptor {
  kind: ToolProviderKind
  label: string
  source: string
  runtime?: 'sidecar' | 'external' | 'browser' | 'desktop' | 'service' | 'internal'
}

export type ToolExecutorDescriptor =
  | {
      kind: 'console'
      commandId: string
      label: string
      dryRun?: boolean
    }
  | {
      kind: 'webService'
      serviceId: string
      label: string
      endpoint?: string
      method?: 'GET' | 'POST'
      dryRun?: boolean
    }
  | {
      kind: 'uiApp'
      appId: string
      label: string
      launchCommandId?: string
      completion: 'appClosed' | 'outputsAvailable' | 'manualConfirm'
      dryRun?: boolean
    }
  | {
      kind: 'internal'
      handler: string
      label: string
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
  pipeable: boolean
  pipeModes: string[]
}

interface RegistryExtension {
  provider?: Partial<ToolProviderDescriptor>
  executor?: ToolExecutorDescriptor
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

export function buildToolMap(tools: ToolDefinition[]): Map<string, ToolDefinition> {
  const map = new Map<string, ToolDefinition>()

  for (const tool of tools) {
    map.set(tool.id, tool)
    map.set(tool.name, tool)
    map.set(qualifiedToolRef(tool), tool)
    map.set(`${tool.name}@${tool.version}`, tool)
  }

  return map
}

export function resolveToolDefinition(
  toolMap: Map<string, ToolDefinition>,
  toolRef: string
): ToolDefinition | undefined {
  const exact = toolMap.get(toolRef)
  if (exact) return exact

  const parsed = parseToolRef(toolRef)
  if (parsed.version) return undefined

  return toolMap.get(parsed.id) ?? toolMap.get(stableToolName(parsed.id))
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

export function getToolExecutor(tool: ToolDefinition): ToolExecutorDescriptor | null {
  const extension = readRegistryExtension(tool)
  return extension?.executor ?? null
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
        source: entry.provider.source,
        executor: getToolExecutor(entry.tool)?.kind ?? null
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
    pushSuggestion(suggestions, `inputs.${name}`, def.type, `input ${name}`, inputType, false, [])
  }

  for (const [name, def] of Object.entries(workflow.context?.fields ?? {})) {
    pushSuggestion(suggestions, `context.${name}`, def.type, `context ${name}`, inputType, false, [])
  }

  for (const [stepId, step] of Object.entries(workflow.steps)) {
    if (stepId === selectedStep) continue
    const tool = resolveToolDefinition(toolMap, step.tool)
    for (const [outputName, output] of Object.entries(tool?.outputs ?? {})) {
      pushSuggestion(
        suggestions,
        `steps.${stepId}.outputs.${outputName}`,
        output.type,
        `${stepId} output ${outputName}`,
        inputType,
        outputCanPipeTo(output, inputType),
        safePipeModes(output, inputType)
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
  inputType: string,
  pipeable: boolean,
  pipeModes: string[]
): void {
  if (!isTypeCompatible(sourceType, inputType)) return
  suggestions.push({
    ref,
    type: sourceType,
    label: `${label} (${shortType(sourceType)})`,
    exact: sourceType === inputType,
    pipeable,
    pipeModes
  })
}

export function outputCanPipeTo(
  output: { type: string; availableFrom?: ToolOutputAvailability[] },
  inputType: string,
  consumption?: ToolInputConsumption
): boolean {
  return safePipeModes(output, inputType, consumption).length > 0
}

export function safePipeModes(
  output: { type: string; availableFrom?: ToolOutputAvailability[] },
  inputType: string,
  consumption?: ToolInputConsumption
): string[] {
  if (!isTypeCompatible(output.type, inputType)) return []

  const outputModes = new Set<string>()
  for (const source of output.availableFrom ?? []) {
    if (source.pipe?.safe !== true) continue
    for (const mode of source.pipe.modes) {
      outputModes.add(mode)
    }
  }

  if (!consumption) return Array.from(outputModes).sort()
  if (consumption.acceptsPipe !== true) return []

  return Array.from(outputModes)
    .filter((mode) => pipeModeMatchesConsumption(mode, consumption.channel))
    .sort()
}

function pipeModeMatchesConsumption(mode: string, channel: ToolInputConsumption['channel']): boolean {
  if (mode === 'file') return channel === 'filesystem'
  return mode === channel
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
  return value === 'console'
    || value === 'webForm'
    || value === 'webService'
    || value === 'uiApp'
    || value === 'neuroflow'
}

function providerLabel(kind: ToolProviderKind): string {
  switch (kind) {
    case 'console':
      return 'Console app'
    case 'webForm':
      return 'Web form'
    case 'webService':
      return 'Web service'
    case 'uiApp':
      return 'UI app'
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
