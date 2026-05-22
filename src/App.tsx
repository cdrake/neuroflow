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
import { planWorkflow, validateWorkflow } from './domain/validation'
import type {
  Binding,
  BlockDef,
  StepDef,
  ToolDefinition,
  ValidationReport,
  WorkflowDocument,
  WorkflowLibraryItem,
  WorkflowPlan
} from './domain/neuroflow'
import type { NodePositionMap } from './domain/graph'
import { isConstantBinding, isRefBinding, stableToolName } from './domain/neuroflow'

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
    validateWorkflow(activeWorkflow).then((nextReport) => {
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
    setWorkspaceItems((items) =>
      items.map((item) =>
        item.id === activeWorkflowId ? { ...item, workflow: cloneWorkflow(original.workflow) } : item
      )
    )
    setSelectedStep(Object.keys(original.workflow.steps)[0] ?? null)
  }

  function addToolStep(toolId: string, blockId?: string, position?: XYPosition): void {
    const tool = toolMap.get(toolId)
    if (!tool) return

    const block = getToolBlocks(tool).find((candidate) => candidate.id === blockId) ?? getToolBlocks(tool)[0]
    const baseId = slugify(block?.id ?? stableToolName(tool.name))
    const nextId = uniqueStepId(activeWorkflow, baseId)

    updateActiveWorkflow((workflow) => {
      const nextStep: StepDef = {
        tool: tool.id,
        inputs: buildDefaultInputs(tool, block)
      }

      const nextWorkflow = {
        ...workflow,
        context: mergeBlockContext(workflow, block),
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
    const block = getToolBlocks(tool)[0]

    updateStep(stepId, (step) => ({
      ...step,
      tool: tool.id,
      inputs: buildDefaultInputs(tool, block, step.inputs),
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
          <button className="nf-action" onClick={() => void validateWorkflow(activeWorkflow).then(setReport)}>
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
            onSelect={(id) => {
              setActiveWorkflowId(id)
              const nextWorkflow = workspaceItems.find((item) => item.id === id)?.workflow
              setSelectedStep(nextWorkflow ? Object.keys(nextWorkflow.steps)[0] ?? null : null)
            }}
          />
          <ToolPalette tools={tools} onAddTool={addToolStep} />
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

function getToolBlocks(tool: ToolDefinition): BlockDef[] {
  if (!tool.block) return []
  return Array.isArray(tool.block) ? tool.block : [tool.block]
}

function buildDefaultInputs(
  tool: ToolDefinition,
  block?: BlockDef,
  previousInputs: Record<string, Binding> = {}
): Record<string, Binding> {
  const nextInputs: Record<string, Binding> = {}

  for (const [name, def] of Object.entries(tool.inputs)) {
    if (previousInputs[name]) {
      nextInputs[name] = previousInputs[name]
      continue
    }

    const blockDefault = block?.defaults?.[name]
    if (blockDefault !== undefined) {
      nextInputs[name] = bindingFromDefault(blockDefault)
      continue
    }

    if (def.default !== undefined) {
      nextInputs[name] = { constant: def.default }
    }
  }

  return nextInputs
}

function bindingFromDefault(value: unknown): Binding {
  if (isObject(value) && (isRefBinding(value as Binding) || isConstantBinding(value as Binding))) {
    return value as Binding
  }
  return { constant: value }
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

function mergeBlockContext(workflow: WorkflowDocument, block?: BlockDef): WorkflowDocument['context'] {
  if (!block?.contextFields) return workflow.context
  return {
    description: workflow.context?.description,
    fields: {
      ...(workflow.context?.fields ?? {}),
      ...block.contextFields
    }
  }
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
