import { invoke } from '@tauri-apps/api/core'
import type { Binding, ToolDefinition, WorkflowDocument } from './neuroflow'
import { isConstantBinding, isRefBinding } from './neuroflow'
import { buildToolMap, getToolExecutor, resolveToolDefinition } from './registry'
import { validateWorkflowLocally } from './validation'

export type RunStepStatus = 'pending' | 'running' | 'succeeded' | 'blocked' | 'failed'
export type ProcessStreamName = 'stdout' | 'stderr'

export interface ProcessStreamCapture {
  text: string
  truncated?: boolean
}

export interface UISessionWatchResult {
  output: string
  source: 'uiSession' | 'filesystem'
  selector?: string
  path?: string
  glob?: string
  observed: boolean
}

export interface UISessionCapture {
  appId: string
  state: 'simulated' | 'closed' | 'waiting'
  completion: 'appClosed' | 'outputsAvailable' | 'manualConfirm'
  closedAt?: string
  watches: UISessionWatchResult[]
}

export interface RunStepResult {
  id: string
  tool: string
  adapter: 'console' | 'webService' | 'uiApp' | 'internal' | 'none'
  status: RunStepStatus
  message: string
  startedAt?: string
  finishedAt?: string
  outputs?: Record<string, unknown>
  streams?: Partial<Record<ProcessStreamName, ProcessStreamCapture>>
  session?: UISessionCapture
}

export interface WorkflowRunResult {
  workflowId: string
  status: 'idle' | 'running' | 'succeeded' | 'blocked' | 'failed'
  steps: RunStepResult[]
}

interface ConsoleToolResult {
  status: number
  stdout: string
  stderr: string
}

interface ExecutionState {
  inputs: Record<string, unknown>
  context: Record<string, unknown>
  stepOutputs: Record<string, Record<string, unknown>>
}

interface AdapterExecutionResult {
  outputs: Record<string, unknown>
  message: string
  streams?: Partial<Record<ProcessStreamName, ProcessStreamCapture>>
  session?: UISessionCapture
}

class AdapterExecutionError extends Error {
  constructor(
    message: string,
    readonly streams?: Partial<Record<ProcessStreamName, ProcessStreamCapture>>
  ) {
    super(message)
  }
}

export async function executeWorkflow(
  workflow: WorkflowDocument,
  tools: ToolDefinition[],
  onStep?: (step: RunStepResult) => void
): Promise<WorkflowRunResult> {
  const toolMap = buildToolMap(tools)
  const state: ExecutionState = {
    inputs: defaultsForDeclarations(workflow.inputs),
    context: defaultsForDeclarations(workflow.context?.fields ?? {}),
    stepOutputs: {}
  }
  const steps: RunStepResult[] = []
  let terminalStatus: WorkflowRunResult['status'] = 'succeeded'

  const validationStarted = startStep('validate-workflow', 'neuroflow-spec', 'internal')
  steps.push(validationStarted)
  onStep?.(validationStarted)

  const report = validateWorkflowLocally(workflow, tools)
  if (!report.ok) {
    const firstError = report.issues.find((issue) => issue.severity === 'error') ?? report.issues[0]
    const result = finishStep({
      ...validationStarted,
      status: 'blocked',
      message: firstError?.message ?? 'Workflow validation failed.'
    })
    steps[steps.length - 1] = result
    onStep?.(result)
    return {
      workflowId: workflow.id,
      status: 'blocked',
      steps
    }
  }

  const validationDone = finishStep({
    ...validationStarted,
    status: 'succeeded',
    message: 'Workflow JSON and step inputs passed validation.'
  })
  steps[steps.length - 1] = validationDone
  onStep?.(validationDone)

  for (const [stepId, step] of Object.entries(workflow.steps)) {
    const tool = resolveToolDefinition(toolMap, step.tool)
    if (!tool) {
      const result = finishStep({
        id: stepId,
        tool: step.tool,
        adapter: 'none',
        status: 'blocked',
        message: `No tool contract is registered for ${step.tool}.`
      })
      steps.push(result)
      onStep?.(result)
      terminalStatus = 'blocked'
      break
    }

    const started = startStep(stepId, tool.id, adapterForTool(tool))
    steps.push(started)
    onStep?.(started)

    const resolved = resolveStepInputs(step.inputs, state)
    if (!resolved.ok) {
      const result = finishStep({
        ...started,
        status: 'blocked',
        message: `Missing runtime value for ${resolved.missing.join(', ')}.`
      })
      steps[steps.length - 1] = result
      onStep?.(result)
      terminalStatus = 'blocked'
      break
    }

    try {
      const adapterResult = await executeStepAdapter(tool, resolved.inputs)
      state.stepOutputs[stepId] = adapterResult.outputs
      for (const [outputName, contextField] of Object.entries(step.outputMappings ?? {})) {
        if (outputName in adapterResult.outputs) {
          state.context[contextField] = adapterResult.outputs[outputName]
        }
      }

      const result = finishStep({
        ...started,
        status: 'succeeded',
        message: adapterResult.message,
        outputs: adapterResult.outputs,
        streams: adapterResult.streams,
        session: adapterResult.session
      })
      steps[steps.length - 1] = result
      onStep?.(result)
    } catch (error) {
      const result = finishStep({
        ...started,
        status: 'failed',
        message: error instanceof Error ? error.message : String(error),
        streams: error instanceof AdapterExecutionError ? error.streams : undefined
      })
      steps[steps.length - 1] = result
      onStep?.(result)
      terminalStatus = 'failed'
      break
    }
  }

  return {
    workflowId: workflow.id,
    status: terminalStatus,
    steps
  }
}

function startStep(id: string, tool: string, adapter: RunStepResult['adapter']): RunStepResult {
  return {
    id,
    tool,
    adapter,
    status: 'running',
    message: 'Starting adapter.',
    startedAt: new Date().toISOString()
  }
}

function finishStep(step: RunStepResult): RunStepResult {
  return {
    ...step,
    finishedAt: new Date().toISOString()
  }
}

async function executeStepAdapter(
  tool: ToolDefinition,
  inputs: Record<string, unknown>
): Promise<AdapterExecutionResult> {
  const executor = getToolExecutor(tool)

  if (!executor) {
    return {
      outputs: synthesizeOutputs(tool, 'No executor descriptor configured.'),
      message: 'Completed with synthesized outputs.'
    }
  }

  if (executor.kind === 'console') {
    if (executor.dryRun === true) {
      const streams = streamsFromText(`${executor.label} dry run`, '')
      return {
        outputs: synthesizeOutputs(tool, `${executor.label} dry run`, streams),
        streams,
        message: `${executor.label} dry run.`
      }
    }
    if (!isTauriRuntime()) {
      const streams = streamsFromText('', 'Desktop command adapter requires the Tauri runtime.')
      return {
        outputs: synthesizeOutputs(tool, 'Desktop command adapter requires the Tauri runtime.', streams),
        streams,
        message: `${executor.label} simulated in the browser.`
      }
    }
    const result = await invoke<ConsoleToolResult>('execute_console_tool', {
      commandId: executor.commandId,
      toolId: tool.id,
      inputs
    })
    const streams = streamsFromText(result.stdout, result.stderr)
    if (result.status !== 0) {
      throw new AdapterExecutionError(
        result.stderr || `Command adapter exited with status ${result.status}.`,
        streams
      )
    }
    return {
      outputs: synthesizeOutputs(tool, result.stdout.trim() || executor.label, streams),
      streams,
      message: `${executor.label} completed.`
    }
  }

  if (executor.kind === 'webService') {
    if (executor.endpoint && executor.dryRun !== true) {
      const response = await fetch(executor.endpoint, {
        method: executor.method ?? 'POST',
        headers: { 'content-type': 'application/json' },
        body: (executor.method ?? 'POST') === 'GET' ? undefined : JSON.stringify({ tool: tool.id, inputs })
      })
      if (!response.ok) {
        throw new Error(`Service ${executor.serviceId} returned HTTP ${response.status}.`)
      }
      const payload = await response.json() as Record<string, unknown>
      return {
        outputs: { ...synthesizeOutputs(tool, executor.label), ...payload },
        message: `${executor.label} completed.`
      }
    }
    return {
      outputs: synthesizeOutputs(tool, `${executor.label} dry run`),
      message: `${executor.label} dry run.`
    }
  }

  if (executor.kind === 'uiApp') {
    const session = synthesizeUiSession(tool, executor.appId, executor.completion)
    return {
      outputs: synthesizeOutputs(tool, `${executor.label} session`, {}, session),
      session,
      message: executor.dryRun === true
        ? `${executor.label} session dry run.`
        : `${executor.label} session simulated until desktop app monitoring is wired.`
    }
  }

  return {
    outputs: synthesizeOutputs(tool, executor.label),
    message: `${executor.label} completed.`
  }
}

function resolveStepInputs(
  bindings: Record<string, Binding>,
  state: ExecutionState
): { ok: true; inputs: Record<string, unknown> } | { ok: false; missing: string[] } {
  const inputs: Record<string, unknown> = {}
  const missing: string[] = []

  for (const [inputName, binding] of Object.entries(bindings)) {
    const value = resolveBinding(binding, state)
    if (value === undefined) {
      missing.push(inputName)
    } else {
      inputs[inputName] = value
    }
  }

  return missing.length > 0 ? { ok: false, missing } : { ok: true, inputs }
}

function resolveBinding(binding: Binding, state: ExecutionState): unknown {
  if (isConstantBinding(binding)) return binding.constant
  if (!isRefBinding(binding)) return undefined

  if (binding.ref === 'context') return state.context

  const parts = binding.ref.split('.')
  if (parts[0] === 'inputs' && parts.length === 2) return state.inputs[parts[1]]
  if (parts[0] === 'context' && parts.length === 2) return state.context[parts[1]]
  if (parts[0] === 'steps' && parts.length === 4 && parts[2] === 'outputs') {
    return state.stepOutputs[parts[1]]?.[parts[3]]
  }
  return undefined
}

function defaultsForDeclarations(
  declarations: Record<string, { default?: unknown; type: string }>
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(declarations).map(([name, declaration]) => [
      name,
      declaration.default ?? placeholderForType(declaration.type, name)
    ])
  )
}

function streamsFromText(stdout: string, stderr: string): Partial<Record<ProcessStreamName, ProcessStreamCapture>> {
  return {
    stdout: { text: stdout },
    stderr: { text: stderr }
  }
}

function synthesizeOutputs(
  tool: ToolDefinition,
  provenance: string,
  streams: Partial<Record<ProcessStreamName, ProcessStreamCapture>> = {},
  session?: UISessionCapture
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(tool.outputs).map(([name, declaration]) => [
      name,
      outputValueFromAvailability(declaration, name, `${tool.name}.${name}`, provenance, streams, session)
    ])
  )
}

function outputValueFromAvailability(
  declaration: ToolDefinition['outputs'][string],
  outputName: string,
  label: string,
  provenance: string,
  streams: Partial<Record<ProcessStreamName, ProcessStreamCapture>>,
  session?: UISessionCapture
): unknown {
  for (const source of declaration.availableFrom ?? []) {
    if (source.source === 'stdout' || source.source === 'stderr') {
      const text = streams[source.source]?.text.trim()
      if (!text) continue
      return parseStreamValue(text, declaration.type, source.format)
    }

    if (source.source === 'uiSession' && session) {
      return {
        appId: session.appId,
        output: outputName,
        selector: source.selector ?? source.sessionKey ?? outputName,
        state: session.state,
        provenance
      }
    }

    if (source.source === 'filesystem' && source.watch) {
      return {
        output: outputName,
        path: source.watch.path ?? source.watch.rootInput ?? source.glob ?? label,
        glob: source.watch.glob ?? source.glob,
        provenance
      }
    }
  }

  return placeholderForType(declaration.type, label, provenance)
}

function synthesizeUiSession(
  tool: ToolDefinition,
  appId: string,
  completion: UISessionCapture['completion']
): UISessionCapture {
  return {
    appId,
    completion,
    state: 'simulated',
    closedAt: new Date().toISOString(),
    watches: Object.entries(tool.outputs).flatMap(([outputName, declaration]) =>
      (declaration.availableFrom ?? [])
        .filter((availability) => availability.source === 'uiSession' || availability.watch)
        .map((availability) => ({
          output: outputName,
          source: availability.source === 'uiSession' ? 'uiSession' as const : 'filesystem' as const,
          selector: availability.selector ?? availability.sessionKey,
          path: availability.watch?.path ?? availability.watch?.rootInput,
          glob: availability.watch?.glob ?? availability.glob,
          observed: true
        }))
    )
  }
}

function parseStreamValue(text: string, type: string, format = 'text'): unknown {
  if (format === 'json' || type === 'core:json' || type === 'core:object') {
    try {
      return JSON.parse(text)
    } catch {
      return { text }
    }
  }
  if (format === 'jsonl') {
    return text
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line)
        } catch {
          return line
        }
      })
  }
  if (type.startsWith('core:array<') || format === 'paths') {
    return text.split(/\r?\n/).filter(Boolean)
  }
  return text
}

function placeholderForType(type: string, label: string, provenance = 'runtime placeholder'): unknown {
  if (type.startsWith('core:array<')) return []
  if (type === 'core:number' || type === 'core:integer') return 0
  if (type === 'core:boolean') return true
  if (type === 'core:object' || type === 'core:json') return { label, provenance }
  return `${label} (${provenance})`
}

function adapterForTool(tool: ToolDefinition): RunStepResult['adapter'] {
  const executor = getToolExecutor(tool)
  if (executor?.kind === 'console') return 'console'
  if (executor?.kind === 'webService') return 'webService'
  if (executor?.kind === 'uiApp') return 'uiApp'
  if (executor?.kind === 'internal') return 'internal'
  return 'none'
}

function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}
