import { useCallback, useEffect, useMemo, useState } from 'react'
import type { XYPosition } from '@xyflow/react'
import {
  Activity,
  BadgeCheck,
  Braces,
  CirclePlay,
  Download,
  FolderTree,
  GitBranch,
  MousePointer2,
  PencilLine,
  RefreshCw,
  RotateCcw,
  ShieldCheck
} from 'lucide-react'
import { WorkflowDiagram } from './components/WorkflowDiagram'
import { WorkflowLibrary } from './components/WorkflowLibrary'
import { ToolPalette } from './components/ToolPalette'
import { Inspector } from './components/Inspector'
import { RunTimeline } from './components/RunTimeline'
import { EnvironmentPanel } from './components/EnvironmentPanel'
import { RunPanel } from './components/RunPanel'
import type { HostRunState } from './components/RunPanel'
import { library, tools } from './data/gallery'
import {
  checkEnvironment,
  cancelRun,
  defaultSettings,
  isTauriRuntime,
  loadStoredSettings,
  onRunFinished,
  onRunProgress,
  openPath,
  parseProgressMessage,
  readSessionTail,
  startRun,
  storeSettings,
  toolStatusMap
} from './domain/host'
import type { EnvironmentReport, HostSettings } from './domain/host'
import {
  buildToolMap,
  buildToolRegistry,
  createStepFromRegistryEntry,
  mergeRegistryContext
} from './domain/registry'
import { planWorkflow, validateWorkflow } from './domain/validation'
import { executeWorkflow } from './domain/execution'
import type {
  Binding,
  StepDef,
  ToolDefinition,
  ValidationReport,
  WorkflowDocument,
  WorkflowLibraryItem,
  WorkflowPlan
} from './domain/neuroflow'
import type { RunStepResult, WorkflowRunResult } from './domain/execution'
import type { NodePositionMap } from './domain/graph'
import { isRefBinding, stableToolName } from './domain/neuroflow'

const WORKSPACE_STORAGE_KEY = 'neuroflow.workspace.v2'
const UI_EXTENSION_KEY = 'neuroflow/ui'
const HOST_AVAILABLE = isTauriRuntime()

export function App(): JSX.Element {
  const [workspaceItems, setWorkspaceItems] = useState<WorkflowLibraryItem[]>(loadWorkspaceItems)
  const [activeWorkflowId, setActiveWorkflowId] = useState(library[0].id)
  const [selectedStep, setSelectedStep] = useState<string | null>(
    () => Object.keys(library[0].workflow.steps)[0] ?? null
  )
  const [report, setReport] = useState<ValidationReport>({ ok: true, issues: [] })
  const [plan, setPlan] = useState<WorkflowPlan | null>(null)
  const [run, setRun] = useState<WorkflowRunResult | null>(null)
  const [isRunningPreview, setIsRunningPreview] = useState(false)
  const [isExecuting, setIsExecuting] = useState(false)

  // Host (Tauri) state: settings, the up-front environment check, and the live run.
  const [settings, setSettings] = useState<HostSettings | null>(null)
  const [environment, setEnvironment] = useState<EnvironmentReport | null>(null)
  const [environmentError, setEnvironmentError] = useState<string | null>(null)
  const [isChecking, setIsChecking] = useState(false)
  const [hostRun, setHostRun] = useState<HostRunState | null>(null)

  const activeLibraryItem = useMemo(
    () => workspaceItems.find((item) => item.id === activeWorkflowId) ?? workspaceItems[0],
    [activeWorkflowId, workspaceItems]
  )

  const activeWorkflow = useMemo(
    () => activeLibraryItem?.workflow ?? workspaceItems[0].workflow,
    [activeLibraryItem, workspaceItems]
  )

  const toolMap = useMemo(() => buildToolMap(tools), [])
  const registry = useMemo(() => buildToolRegistry(tools), [])
  const toolStatuses = useMemo(() => toolStatusMap(environment), [environment])

  // Runnability of the active workflow on this host, from the environment check.
  const runnable = useMemo<string | null | undefined>(() => {
    if (!environment) return undefined
    const builtin = environment.workflows.find((item) => item.id === activeWorkflow.id)
    if (builtin) return builtin.runnable ?? null
    // Custom or edited workflow: every step's tool must be ready here.
    for (const [stepId, step] of Object.entries(activeWorkflow.steps)) {
      const tool = toolMap.get(step.tool)
      const status = tool ? toolStatuses.get(tool.id) : undefined
      if (!status) return `step ${stepId}: ${step.tool} is not in the host registry`
      if (status.status === 'needsSetup') return `step ${stepId}: ${status.detail}${status.fix ? ` Fix: ${status.fix}` : ''}`
      if (status.status === 'interactive') return `step ${stepId}: ${status.detail}`
      if (status.status === 'unsupported') return `step ${stepId}: ${status.detail}`
    }
    return null
  }, [activeWorkflow, environment, toolMap, toolStatuses])

  const runEnvironmentCheck = useCallback(async (next: HostSettings) => {
    setIsChecking(true)
    setEnvironmentError(null)
    try {
      setEnvironment(await checkEnvironment(next))
    } catch (error) {
      setEnvironment(null)
      setEnvironmentError(error instanceof Error ? error.message : String(error))
    } finally {
      setIsChecking(false)
    }
  }, [])

  useEffect(() => {
    if (!HOST_AVAILABLE) return
    let cancelled = false
    const stored = loadStoredSettings()
    const resolve = stored ? Promise.resolve(stored) : defaultSettings()
    resolve
      .then((next) => {
        if (cancelled) return
        setSettings(next)
        return runEnvironmentCheck(next)
      })
      .catch((error) => {
        if (!cancelled) setEnvironmentError(error instanceof Error ? error.message : String(error))
      })
    return () => {
      cancelled = true
    }
  }, [runEnvironmentCheck])

  useEffect(() => {
    if (!HOST_AVAILABLE) return
    const unlisteners: Array<() => void> = []
    let disposed = false
    void onRunProgress((event) => {
      setHostRun((current) => {
        // `start_run` returns after spawning its worker. A fast validation failure
        // (or a fast first step) can emit before that invoke resolves, so let the
        // first event claim the one pending run rather than dropping it.
        if (!current || (current.ticket !== null && current.ticket !== event.ticket)) return current
        const parsed = parseProgressMessage(event.message)
        return {
          ...current,
          ticket: current.ticket ?? event.ticket,
          status: 'running',
          progress: event.progress,
          total: event.total,
          message: event.message,
          currentStep: parsed ? parsed.stepId : event.message === 'done' ? null : current.currentStep
        }
      })
    }).then((unlisten) => (disposed ? unlisten() : unlisteners.push(unlisten)))
    void onRunFinished((event) => {
      setHostRun((current) => {
        if (!current || (current.ticket !== null && current.ticket !== event.ticket)) return current
        if (event.ok === false && !('record' in event)) {
          return { ...current, ticket: current.ticket ?? event.ticket, status: 'rejected', finished: event, error: event.error }
        }
        const done = event as Extract<typeof event, { record: unknown }>
        const failed = done.status !== 'completed'
        const cancelled = done.status === 'cancelled'
        return {
          ...current,
          ticket: current.ticket ?? event.ticket,
          status: cancelled ? 'cancelled' : failed ? 'failed' : 'completed',
          progress: current.total,
          finished: done,
          currentStep: done.record.failedStep ?? current.currentStep,
          error: failed ? done.structured.error ?? done.summary : null
        }
      })
    }).then((unlisten) => (disposed ? unlisten() : unlisteners.push(unlisten)))
    return () => {
      disposed = true
      unlisteners.forEach((unlisten) => unlisten())
    }
  }, [])

  // After a failure, pull the failed step's stderr tail so the reason is on screen.
  useEffect(() => {
    if (!settings || !hostRun || hostRun.status !== 'failed' || hostRun.stderrTail !== null) return
    const finished = hostRun.finished
    if (!finished || !('record' in finished)) return
    const step = finished.record.failedStep
    if (!step) return
    const ticket = hostRun.ticket
    readSessionTail(settings, `${finished.sessionDir}/logs/${step}.stderr`)
      .then((tail) => setHostRun((current) => (current && current.ticket === ticket ? { ...current, stderrTail: tail || '(empty)' } : current)))
      .catch((error) => setHostRun((current) => (current && current.ticket === ticket ? { ...current, stderrTail: String(error) } : current)))
  }, [hostRun, settings])

  function changeSettings(next: HostSettings): void {
    setSettings(next)
    storeSettings(next)
    void runEnvironmentCheck(next)
  }

  async function startHostRun(inputs: Record<string, unknown>): Promise<void> {
    if (!settings) return
    const pending: HostRunState = {
      ticket: null,
      workflowId: activeWorkflow.id,
      status: 'starting',
      progress: 0,
      total: Object.keys(activeWorkflow.steps).length,
      message: 'starting',
      currentStep: null,
      finished: null,
      stderrTail: null,
      error: null
    }
    setHostRun(pending)
    try {
      const ticket = await startRun(settings, activeWorkflow, inputs)
      setHostRun((current) => (current && current.ticket === null ? { ...current, ticket } : current))
    } catch (error) {
      setHostRun({ ...pending, status: 'rejected', error: error instanceof Error ? error.message : String(error) })
    }
  }

  function cancelHostRun(): void {
    if (!hostRun?.ticket) return
    const ticket = hostRun.ticket
    // The run may finish while the cancel is in flight; only a still-active run takes the update.
    const active = (current: HostRunState | null): current is HostRunState =>
      current !== null && current.ticket === ticket && (current.status === 'starting' || current.status === 'running')
    void cancelRun(ticket).then(() => {
      setHostRun((current) => (active(current) ? { ...current, message: 'Cancelling…' } : current))
    }).catch((error) => {
      setHostRun((current) => (active(current) ? { ...current, error: error instanceof Error ? error.message : String(error) } : current))
    })
  }

  function revealPath(path: string): void {
    if (!settings) return
    openPath(settings, path).catch((error) => {
      setHostRun((current) => (current ? { ...current, error: error instanceof Error ? error.message : String(error) } : current))
    })
  }

  const nodePositions = useMemo(() => getNodePositions(activeWorkflow), [activeWorkflow])

  const updateActiveWorkflow = useCallback(
    (updater: (workflow: WorkflowDocument) => WorkflowDocument) => {
      setRun(null)
      setIsExecuting(false)
      setWorkspaceItems((items) =>
        items.map((item) =>
          item.id === activeWorkflowId
            ? { ...item, workflow: updater(cloneWorkflow(item.workflow)) }
            : item
        )
      )
    },
    [activeWorkflowId]
  )

  useEffect(() => {
    let cancelled = false
    validateWorkflow(activeWorkflow, tools).then((nextReport) => {
      if (!cancelled) setReport(nextReport)
    })
    planWorkflow(activeWorkflow).then((nextPlan) => {
      if (!cancelled) setPlan(nextPlan)
    })
    return () => {
      cancelled = true
    }
  }, [activeWorkflow])

  useEffect(() => {
    window.localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(workspaceItems))
  }, [workspaceItems])

  useEffect(() => {
    if (selectedStep && activeWorkflow.steps[selectedStep]) return
    setSelectedStep(Object.keys(activeWorkflow.steps)[0] ?? null)
  }, [activeWorkflow, selectedStep])

  async function runPreview(): Promise<void> {
    setRun(null)
    setIsRunningPreview(true)
    const nextPlan = await planWorkflow(activeWorkflow)
    setPlan(nextPlan)
    window.setTimeout(() => setIsRunningPreview(false), 650)
  }

  async function runWorkflow(): Promise<void> {
    const initialRun: WorkflowRunResult = {
      workflowId: activeWorkflow.id,
      status: 'running',
      steps: []
    }

    setIsExecuting(true)
    setIsRunningPreview(false)
    setRun(initialRun)

    try {
      const nextPlan = await planWorkflow(activeWorkflow)
      setPlan(nextPlan)
      const result = await executeWorkflow(activeWorkflow, tools, (step) => {
        setRun((current) => upsertRunStep(current ?? initialRun, step))
      })
      setRun(result)
    } catch (error) {
      const failedStep: RunStepResult = {
        id: 'run-workflow',
        tool: 'neuroflow-runtime',
        adapter: 'internal',
        status: 'failed',
        message: error instanceof Error ? error.message : String(error),
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString()
      }
      setRun((current) => ({
        ...(current ?? initialRun),
        status: 'failed',
        steps: [...(current?.steps ?? []), failedStep]
      }))
    } finally {
      setIsExecuting(false)
    }
  }

  function exportActiveWorkflow(): void {
    const blob = new Blob([`${JSON.stringify(activeWorkflow, null, 2)}\n`], {
      type: 'application/json'
    })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `${slugify(activeWorkflow.id.split('/').pop() ?? activeWorkflow.id)}.neuroflow.json`
    link.click()
    URL.revokeObjectURL(url)
  }

  function resetActiveWorkflow(): void {
    const original = library.find((item) => item.id === activeWorkflowId) ?? library[0]
    const isBuiltinWorkflow = library.some((candidate) => candidate.id === activeWorkflowId)
    setWorkspaceItems((items) =>
      items.map((item) =>
        item.id === activeWorkflowId
          ? {
              ...item,
              workflow: isBuiltinWorkflow
                ? cloneWorkflow(original.workflow)
                : createBlankWorkflow(item.label, item.workflow.id)
            }
          : item
      )
    )
    setSelectedStep(isBuiltinWorkflow ? Object.keys(original.workflow.steps)[0] ?? null : null)
    setRun(null)
  }

  function createCustomWorkflow(): void {
    const index = nextCustomWorkflowIndex(workspaceItems)
    const itemId = `custom-workflow-${index}`
    const label = `Custom Workflow ${index}`
    const workflow = createBlankWorkflow(label, `neuroflow.local/${itemId}`)
    const item: WorkflowLibraryItem = {
      id: itemId,
      label,
      description: 'Compose a pipeline from registry tools and forms.',
      workflow
    }

    setWorkspaceItems((items) => [...items, item])
    setActiveWorkflowId(item.id)
    setSelectedStep(null)
    setPlan(null)
    setRun(null)
  }

  function addToolStep(toolId: string, blockId?: string, position?: XYPosition): void {
    const entry = registry.find(
      (candidate) =>
        candidate.tool.id === toolId && (!blockId || candidate.block?.id === blockId)
    ) ?? registry.find((candidate) => candidate.tool.id === toolId)
    if (!entry) return

    const baseId = slugify(entry.block?.id ?? stableToolName(entry.tool.name))
    const nextId = uniqueStepId(activeWorkflow, baseId)

    updateActiveWorkflow((workflow) => {
      const nextStep = createStepFromRegistryEntry(entry, workflow, toolMap)

      const nextWorkflow = {
        ...workflow,
        context: mergeRegistryContext(workflow, entry),
        steps: {
          ...workflow.steps,
          [nextId]: nextStep
        }
      }
      return position ? setNodePosition(nextWorkflow, `step:${nextId}`, position) : nextWorkflow
    })
    setSelectedStep(nextId)
  }

  function moveNode(nodeId: string, position: XYPosition): void {
    updateActiveWorkflow((workflow) => setNodePosition(workflow, nodeId, position))
  }

  function renameStep(stepId: string, nextRawId: string): void {
    const nextId = slugify(nextRawId)
    if (!nextId || nextId === stepId || activeWorkflow.steps[nextId]) return

    updateActiveWorkflow((workflow) => {
      const stepEntries = Object.entries(workflow.steps)
      const renamedSteps = Object.fromEntries(
        stepEntries.map(([id, step]) => [id === stepId ? nextId : id, step])
      )
      return renameNodePosition(replaceStepRefs({ ...workflow, steps: renamedSteps }, stepId, nextId), stepId, nextId)
    })
    setSelectedStep(nextId)
  }

  function changeStepTool(stepId: string, toolId: string): void {
    const tool = toolMap.get(toolId)
    if (!tool) return
    const entry = registry.find((candidate) => candidate.tool.id === tool.id)

    updateStep(stepId, (step) => ({
      ...step,
      tool: tool.id,
      inputs: {
        ...(entry ? createStepFromRegistryEntry(entry, activeWorkflow, toolMap).inputs : {}),
        ...step.inputs
      },
      outputMappings: filterOutputMappings(step.outputMappings, tool)
    }))
  }

  function changeInputBinding(stepId: string, inputName: string, binding: Binding | null): void {
    updateStep(stepId, (step) => {
      const inputs = { ...step.inputs }
      if (binding) {
        inputs[inputName] = binding
      } else {
        delete inputs[inputName]
      }
      return { ...step, inputs }
    })
  }

  function changeOutputMapping(stepId: string, outputName: string, contextField: string): void {
    updateStep(stepId, (step) => {
      const outputMappings = { ...(step.outputMappings ?? {}) }
      const nextField = contextField.trim()
      if (nextField) {
        outputMappings[outputName] = nextField
      } else {
        delete outputMappings[outputName]
      }
      return {
        ...step,
        outputMappings: Object.keys(outputMappings).length > 0 ? outputMappings : undefined
      }
    })
  }

  function changeCondition(stepId: string, condition: string): void {
    updateStep(stepId, (step) => {
      const nextCondition = condition.trim()
      const nextStep = { ...step }
      if (nextCondition) {
        nextStep.condition = nextCondition
      } else {
        delete nextStep.condition
      }
      return nextStep
    })
  }

  function deleteStep(stepId: string): void {
    const remaining = Object.keys(activeWorkflow.steps).filter((id) => id !== stepId)
    updateActiveWorkflow((workflow) => removeNodePosition(removeStep(workflow, stepId), `step:${stepId}`))
    setSelectedStep(remaining[0] ?? null)
  }

  function bindInputRef(stepId: string, inputName: string, ref: string): void {
    changeInputBinding(stepId, inputName, { ref })
    setSelectedStep(stepId)
  }

  function updateStep(stepId: string, updater: (step: StepDef) => StepDef): void {
    updateActiveWorkflow((workflow) => {
      const step = workflow.steps[stepId]
      if (!step) return workflow
      return {
        ...workflow,
        steps: {
          ...workflow.steps,
          [stepId]: updater(cloneWorkflow(step))
        }
      }
    })
  }

  const issueCount = report.issues.length
  const stepCount = Object.keys(activeWorkflow.steps).length
  const canExecute = report.ok && stepCount > 0 && !isExecuting

  return (
    <main className="nf-shell">
      <header className="nf-topbar">
        <div className="nf-brand">
          <div className="nf-brand-mark">
            <GitBranch size={18} />
          </div>
          <div>
            <strong>NeuroFlow</strong>
            <span>workflow workbench</span>
          </div>
        </div>

        <div className="nf-topbar-meta" aria-label="workspace status">
          <span className="nf-pill">
            <Braces size={14} />
            spec 0.1
          </span>
          <span className={report.ok ? 'nf-pill nf-pill-ok' : 'nf-pill nf-pill-warn'}>
            <ShieldCheck size={14} />
            {report.ok ? 'valid' : `${issueCount} issues`}
          </span>
          <span className="nf-pill">
            <PencilLine size={14} />
            editable
          </span>
          <button className="nf-action" onClick={resetActiveWorkflow}>
            <RotateCcw size={15} />
            Reset
          </button>
          <button className="nf-action" onClick={exportActiveWorkflow}>
            <Download size={15} />
            Export JSON
          </button>
          <button className="nf-action" onClick={() => void validateWorkflow(activeWorkflow, tools).then(setReport)}>
            <RefreshCw size={15} />
            Validate
          </button>
          <button className="nf-action" onClick={() => void runPreview()} disabled={isExecuting}>
            <CirclePlay size={15} />
            {isRunningPreview ? 'Planning' : 'Run Preview'}
          </button>
          {!HOST_AVAILABLE && (
            <button className="nf-action nf-action-primary" onClick={() => void runWorkflow()} disabled={!canExecute}>
              <CirclePlay size={15} />
              {isExecuting ? 'Running' : 'Simulate Run'}
            </button>
          )}
        </div>
      </header>

      <section className="nf-workspace">
        <aside className="nf-sidebar nf-left-rail">
          <WorkflowLibrary
            items={workspaceItems}
            activeId={activeWorkflowId}
            onCreate={createCustomWorkflow}
            onSelect={(id) => {
              setActiveWorkflowId(id)
              const nextWorkflow = workspaceItems.find((item) => item.id === id)?.workflow
              setSelectedStep(nextWorkflow ? Object.keys(nextWorkflow.steps)[0] ?? null : null)
              setRun(null)
            }}
          />
          <ToolPalette
            registry={registry}
            workflow={activeWorkflow}
            toolMap={toolMap}
            selectedStep={selectedStep}
            toolStatuses={toolStatuses}
            environmentChecked={environment !== null}
            onAddTool={addToolStep}
          />
          <EnvironmentPanel
            available={HOST_AVAILABLE}
            settings={settings}
            report={environment}
            checking={isChecking}
            error={environmentError}
            onCheck={() => settings && void runEnvironmentCheck(settings)}
            onChangeSettings={changeSettings}
          />
        </aside>

        <section className="nf-canvas-pane">
          <div className="nf-canvas-header">
            <div>
              <p className="nf-eyebrow">Pipeline</p>
              <h1>{activeWorkflow.id}</h1>
            </div>
            <div className="nf-canvas-stats">
              <span>
                <FolderTree size={14} />
                {Object.keys(activeWorkflow.context?.fields ?? {}).length} context fields
              </span>
              <span>
                <Activity size={14} />
                {stepCount} steps
              </span>
              <span>
                <BadgeCheck size={14} />
                {Object.keys(activeWorkflow.outputs).length} outputs
              </span>
            </div>
          </div>
          <WorkflowDiagram
            workflow={activeWorkflow}
            tools={toolMap}
            selectedStep={selectedStep}
            emptyAction={
              stepCount === 0
                ? {
                    icon: <MousePointer2 size={17} />,
                    title: 'Build from the registry',
                    detail: 'Drop a tool or form here to create the first step.'
                  }
                : undefined
            }
            nodePositions={nodePositions}
            toolStatuses={toolStatuses}
            onSelectStep={setSelectedStep}
            onBindInput={bindInputRef}
            onMoveNode={moveNode}
            onAddTool={addToolStep}
          />
        </section>

        <aside className="nf-sidebar nf-right-rail">
          <Inspector
            workflow={activeWorkflow}
            tools={tools}
            toolMap={toolMap}
            selectedStep={selectedStep}
            report={report}
            onRenameStep={renameStep}
            onChangeTool={changeStepTool}
            onChangeInput={changeInputBinding}
            onChangeOutputMapping={changeOutputMapping}
            onChangeCondition={changeCondition}
            onDeleteStep={deleteStep}
          />
          {HOST_AVAILABLE ? (
            <RunPanel
              workflow={activeWorkflow}
              available={HOST_AVAILABLE}
              report={report}
              runnable={runnable}
              environmentChecked={environment !== null}
              run={hostRun && hostRun.workflowId === activeWorkflow.id ? hostRun : null}
              onStart={(inputs) => void startHostRun(inputs)}
              onCancel={cancelHostRun}
              onOpen={revealPath}
            />
          ) : (
            <RunTimeline plan={plan} run={run} planning={isRunningPreview} executing={isExecuting} />
          )}
        </aside>
      </section>

      <footer className="nf-statusbar">
        <span className="nf-status-path" title={activeWorkflow.id}>
          {activeWorkflow.id}
        </span>
        <span>{stepCount} steps</span>
        <span>{Object.keys(activeWorkflow.outputs).length} outputs</span>
        <span>{report.ok ? 'validation clean' : `${issueCount} validation issue(s)`}</span>
        <span>{registry.length} gallery tools</span>
        <span>{plan?.steps.length ?? 0} planned</span>
        <span>
          {HOST_AVAILABLE
            ? environment
              ? `${environment.tools.filter((t) => t.status === 'ready').length}/${environment.tools.length} tools ready`
              : isChecking
                ? 'checking environment'
                : 'environment unchecked'
            : 'browser preview'}
        </span>
        <span>{HOST_AVAILABLE ? (hostRun ? `run ${hostRun.status}` : 'not run') : run ? `simulated ${run.status}` : 'not run'}</span>
      </footer>
    </main>
  )
}

function upsertRunStep(run: WorkflowRunResult, step: RunStepResult): WorkflowRunResult {
  const existingIndex = run.steps.findIndex((candidate) => candidate.id === step.id)
  const steps =
    existingIndex >= 0
      ? run.steps.map((candidate, index) => (index === existingIndex ? step : candidate))
      : [...run.steps, step]

  return {
    ...run,
    status: step.status === 'failed' || step.status === 'blocked' ? step.status : run.status,
    steps
  }
}

function loadWorkspaceItems(): WorkflowLibraryItem[] {
  try {
    const stored = window.localStorage.getItem(WORKSPACE_STORAGE_KEY)
    if (!stored) return cloneWorkflow(library)
    const items = JSON.parse(stored) as WorkflowLibraryItem[]
    // Gallery workflows added since the workspace was saved show up too.
    const known = new Set(items.map((item) => item.id))
    return [...items, ...library.filter((item) => !known.has(item.id)).map((item) => cloneWorkflow(item))]
  } catch {
    return cloneWorkflow(library)
  }
}

function cloneWorkflow<T>(value: T): T {
  return structuredClone(value)
}

function createBlankWorkflow(label: string, id: string): WorkflowDocument {
  return {
    neuroflow: '0.1.0',
    kind: 'workflow',
    id,
    version: '0.1.0',
    description: `${label} pipeline.`,
    inputs: {
      dicom_dir: {
        type: 'neuro:dicom-folder',
        description: 'Optional DICOM source directory.',
        optional: true
      },
      bids_dir: {
        type: 'neuro:bids-dataset',
        description: 'Optional existing BIDS dataset.',
        optional: true
      },
      output_dir: {
        type: 'core:directory',
        description: 'Optional pipeline output directory.',
        optional: true
      }
    },
    context: {
      description: 'Values accumulated while composing and running the workflow.',
      fields: {}
    },
    steps: {},
    outputs: {},
    extensions: {
      [UI_EXTENSION_KEY]: {
        nodePositions: {
          inputs: { x: 24, y: 96 },
          context: { x: 24, y: 292 }
        }
      }
    }
  }
}

function nextCustomWorkflowIndex(items: WorkflowLibraryItem[]): number {
  const used = new Set<number>()
  for (const item of items) {
    const match = /^custom-workflow-(\d+)$/.exec(item.id)
    if (match) used.add(Number(match[1]))
  }

  let index = 1
  while (used.has(index)) index += 1
  return index
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function getNodePositions(workflow: WorkflowDocument): NodePositionMap {
  const uiExtension = workflow.extensions?.[UI_EXTENSION_KEY]
  if (!isObject(uiExtension) || !isObject(uiExtension.nodePositions)) return {}

  return Object.fromEntries(
    Object.entries(uiExtension.nodePositions)
      .filter((entry): entry is [string, XYPosition] => isPosition(entry[1]))
      .map(([nodeId, position]) => [nodeId, { x: position.x, y: position.y }])
  )
}

function setNodePosition(
  workflow: WorkflowDocument,
  nodeId: string,
  position: XYPosition
): WorkflowDocument {
  return setNodePositions(workflow, {
    ...getNodePositions(workflow),
    [nodeId]: normalizePosition(position)
  })
}

function removeNodePosition(workflow: WorkflowDocument, nodeId: string): WorkflowDocument {
  const positions = { ...getNodePositions(workflow) }
  delete positions[nodeId]
  return setNodePositions(workflow, positions)
}

function renameNodePosition(
  workflow: WorkflowDocument,
  oldStepId: string,
  nextStepId: string
): WorkflowDocument {
  const positions = { ...getNodePositions(workflow) }
  const oldNodeId = `step:${oldStepId}`
  const nextNodeId = `step:${nextStepId}`
  if (positions[oldNodeId]) {
    positions[nextNodeId] = positions[oldNodeId]
    delete positions[oldNodeId]
  }
  return setNodePositions(workflow, positions)
}

function setNodePositions(workflow: WorkflowDocument, positions: NodePositionMap): WorkflowDocument {
  const uiExtension = workflow.extensions?.[UI_EXTENSION_KEY]
  const nextUiExtension = {
    ...(isObject(uiExtension) ? uiExtension : {}),
    nodePositions: positions
  }

  return {
    ...workflow,
    extensions: {
      ...(workflow.extensions ?? {}),
      [UI_EXTENSION_KEY]: nextUiExtension
    }
  }
}

function isPosition(value: unknown): value is XYPosition {
  return (
    isObject(value) &&
    typeof value.x === 'number' &&
    Number.isFinite(value.x) &&
    typeof value.y === 'number' &&
    Number.isFinite(value.y)
  )
}

function normalizePosition(position: XYPosition): XYPosition {
  return {
    x: Math.round(position.x),
    y: Math.round(position.y)
  }
}

function filterOutputMappings(
  mappings: StepDef['outputMappings'],
  tool: ToolDefinition
): StepDef['outputMappings'] {
  const nextMappings = Object.fromEntries(
    Object.entries(mappings ?? {}).filter(([outputName]) => outputName in tool.outputs)
  )
  return Object.keys(nextMappings).length > 0 ? nextMappings : undefined
}

function uniqueStepId(workflow: WorkflowDocument, baseId: string): string {
  const base = baseId || 'step'
  let candidate = base
  let index = 2
  while (workflow.steps[candidate]) {
    candidate = `${base}-${index}`
    index += 1
  }
  return candidate
}

function slugify(value: string): string {
  return value
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function replaceStepRefs(workflow: WorkflowDocument, oldId: string, nextId: string): WorkflowDocument {
  const oldPrefix = `steps.${oldId}.outputs.`
  const nextPrefix = `steps.${nextId}.outputs.`
  const replaceRef = (ref: string) => (ref.startsWith(oldPrefix) ? ref.replace(oldPrefix, nextPrefix) : ref)

  return {
    ...workflow,
    steps: Object.fromEntries(
      Object.entries(workflow.steps).map(([id, step]) => [
        id,
        {
          ...step,
          inputs: Object.fromEntries(
            Object.entries(step.inputs).map(([inputName, binding]) => [
              inputName,
              isRefBinding(binding) ? { ref: replaceRef(binding.ref) } : binding
            ])
          )
        }
      ])
    ),
    outputs: Object.fromEntries(
      Object.entries(workflow.outputs).map(([name, output]) => [
        name,
        { ...output, ref: replaceRef(output.ref) }
      ])
    )
  }
}

function removeStep(workflow: WorkflowDocument, stepId: string): WorkflowDocument {
  const deletedPrefix = `steps.${stepId}.outputs.`
  const steps = Object.fromEntries(Object.entries(workflow.steps).filter(([id]) => id !== stepId))

  return {
    ...workflow,
    steps: Object.fromEntries(
      Object.entries(steps).map(([id, step]) => [
        id,
        {
          ...step,
          inputs: Object.fromEntries(
            Object.entries(step.inputs).filter(([, binding]) => {
              return !isRefBinding(binding) || !binding.ref.startsWith(deletedPrefix)
            })
          )
        }
      ])
    ),
    outputs: Object.fromEntries(
      Object.entries(workflow.outputs).filter(([, output]) => !output.ref.startsWith(deletedPrefix))
    )
  }
}
