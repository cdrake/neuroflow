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
import { library, tools } from './data/sample'
import {
  buildToolRegistry,
  createStepFromRegistryEntry,
  mergeRegistryContext
} from './domain/registry'
import { planWorkflow, validateWorkflow } from './domain/validation'
import type {
  Binding,
  StepDef,
  ToolDefinition,
  ValidationReport,
  WorkflowDocument,
  WorkflowLibraryItem,
  WorkflowPlan
} from './domain/neuroflow'
import type { NodePositionMap } from './domain/graph'
import { isRefBinding, stableToolName } from './domain/neuroflow'

const WORKSPACE_STORAGE_KEY = 'neuroflow.workspace.v1'
const UI_EXTENSION_KEY = 'neuroflow/ui'

export function App(): JSX.Element {
  const [workspaceItems, setWorkspaceItems] = useState<WorkflowLibraryItem[]>(loadWorkspaceItems)
  const [activeWorkflowId, setActiveWorkflowId] = useState(library[0].id)
  const [selectedStep, setSelectedStep] = useState<string | null>('convert')
  const [report, setReport] = useState<ValidationReport>({ ok: true, issues: [] })
  const [plan, setPlan] = useState<WorkflowPlan | null>(null)
  const [isRunningPreview, setIsRunningPreview] = useState(false)

  const activeLibraryItem = useMemo(
    () => workspaceItems.find((item) => item.id === activeWorkflowId) ?? workspaceItems[0],
    [activeWorkflowId, workspaceItems]
  )

  const activeWorkflow = useMemo(
    () => activeLibraryItem?.workflow ?? workspaceItems[0].workflow,
    [activeLibraryItem, workspaceItems]
  )

  const toolMap = useMemo(() => {
    const map = new Map<string, ToolDefinition>()
    for (const tool of tools) {
      map.set(tool.id, tool)
      map.set(tool.name, tool)
    }
    return map
  }, [])
  const registry = useMemo(() => buildToolRegistry(tools), [])

  const nodePositions = useMemo(() => getNodePositions(activeWorkflow), [activeWorkflow])

  const updateActiveWorkflow = useCallback(
    (updater: (workflow: WorkflowDocument) => WorkflowDocument) => {
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
    setIsRunningPreview(true)
    const nextPlan = await planWorkflow(activeWorkflow)
    setPlan(nextPlan)
    window.setTimeout(() => setIsRunningPreview(false), 650)
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
          <button className="nf-action nf-action-primary" onClick={() => void runPreview()}>
            <CirclePlay size={15} />
            {isRunningPreview ? 'Planning' : 'Run Preview'}
          </button>
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
            }}
          />
          <ToolPalette
            registry={registry}
            workflow={activeWorkflow}
            toolMap={toolMap}
            onAddTool={addToolStep}
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
                {Object.keys(activeWorkflow.steps).length} steps
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
              Object.keys(activeWorkflow.steps).length === 0
                ? {
                    icon: <MousePointer2 size={17} />,
                    title: 'Build from the registry',
                    detail: 'Drop a tool or form here to create the first step.'
                  }
                : undefined
            }
            nodePositions={nodePositions}
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
          <RunTimeline plan={plan} active={isRunningPreview} />
        </aside>
      </section>

      <footer className="nf-statusbar">
        <span className="nf-status-path" title={activeWorkflow.id}>
          {activeWorkflow.id}
        </span>
        <span>{Object.keys(activeWorkflow.steps).length} steps</span>
        <span>{Object.keys(activeWorkflow.outputs).length} outputs</span>
        <span>{report.ok ? 'validation clean' : `${issueCount} validation issue(s)`}</span>
        <span>{registry.length} registry entries</span>
        <span>{plan?.steps.length ?? 0} planned</span>
      </footer>
    </main>
  )
}

function loadWorkspaceItems(): WorkflowLibraryItem[] {
  try {
    const stored = window.localStorage.getItem(WORKSPACE_STORAGE_KEY)
    return stored ? JSON.parse(stored) : cloneWorkflow(library)
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
