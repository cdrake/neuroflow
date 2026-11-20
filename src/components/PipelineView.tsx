import type React from 'react'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { ToolDefinition, WorkflowDocument, WorkflowLibraryItem } from '../domain/neuroflow'
import type { NodePositionMap } from '../domain/graph'
import { RunPanel, stepRunStates, type HostRunState } from './RunPanel'
import { WorkflowDiagram } from './WorkflowDiagram'
import { WorkflowLibrary } from './WorkflowLibrary'

export interface PipelineViewProps {
  items: WorkflowLibraryItem[]
  activeId: string
  onSelect: (id: string) => void
  /** null while the host loads it */
  workflow: WorkflowDocument | null
  tools: Map<string, ToolDefinition>
  run: HostRunState | null
  initialInputs?: Record<string, unknown>
  lockedInputs?: Record<string, string>
  /** forwarded to RunPanel */
  runnable?: string | null
  /** `rerun` is set by the reused-run "Run anew" action; pass it to neuroflow-mcp as the `rerun` argument. */
  onStart: (inputs: Record<string, unknown>, options?: { rerun?: boolean }) => void
  onCancel: () => void
  /** forwarded to RunPanel */
  canCancel?: boolean
  onOpen: (path: string) => void
  openLabel?: (path: string) => string
  /** host slot, rendered above RunPanel */
  targets?: ReactNode
}

const noop = (): void => {}
const okReport = { ok: true, issues: [] }

/** Read-only pipeline view: library, diagram, host slot and run panel. Knows nothing about datasets or MCP. */
export function PipelineView(props: PipelineViewProps): React.JSX.Element {
  const { workflow } = props
  const [positions, setPositions] = useState<NodePositionMap>({})
  const [selectedStep, setSelectedStep] = useState<string | null>(null)
  const runStates = useMemo(
    () => (workflow && props.run?.workflowId === workflow.id ? stepRunStates(workflow, props.run) : undefined),
    [workflow, props.run]
  )

  useEffect(() => {
    setPositions({})
    setSelectedStep(null)
  }, [workflow?.id])

  return (
    <div className="nf-root nf-pipeline-view">
      <WorkflowLibrary items={props.items} activeId={props.activeId} onSelect={props.onSelect} />
      {workflow ? (
        <WorkflowDiagram
          workflow={workflow}
          tools={props.tools}
          selectedStep={selectedStep}
          nodePositions={positions}
          runStates={runStates}
          miniMap={false}
          onSelectStep={setSelectedStep}
          onBindInput={noop}
          onMoveNode={(id, position) => setPositions((p) => ({ ...p, [id]: position }))}
          onAddTool={noop}
        />
      ) : (
        <section className="nf-panel" />
      )}
      <div className="nf-pipeline-side">
        {props.targets}
        {workflow && (
          <RunPanel
            workflow={workflow}
            available
            report={okReport}
            runnable={props.runnable}
            environmentChecked
            run={props.run}
            initialInputs={props.initialInputs}
            lockedInputs={props.lockedInputs}
            onStart={props.onStart}
            onCancel={props.onCancel}
            canCancel={props.canCancel}
            onOpen={props.onOpen}
            openLabel={props.openLabel}
          />
        )}
      </div>
    </div>
  )
}
