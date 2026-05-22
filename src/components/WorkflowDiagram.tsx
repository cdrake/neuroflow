// Port of the NiiVue Desktop workflow diagram concepts:
// source pools for inputs/context, one node per step, handles for each
// typed input/output, visible edges for refs, and inline badges for constants.

import { useCallback, useEffect, useMemo, type DragEvent } from 'react'
import {
  Background,
  type Connection,
  Controls,
  Handle,
  MiniMap,
  type Node,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useNodesState,
  useReactFlow,
  type NodeProps,
  type NodeTypes,
  type XYPosition
} from '@xyflow/react'
import { Box, Circle, Database, FileInput, Sigma } from 'lucide-react'
import {
  buildWorkflowGraph,
  type NeuroflowNode,
  type NodePositionMap,
  type SourceNodeData,
  type StepNodeData
} from '../domain/graph'
import type { ToolDefinition, WorkflowDocument } from '../domain/neuroflow'
import { shortType } from '../domain/neuroflow'

interface WorkflowDiagramProps {
  workflow: WorkflowDocument
  tools: Map<string, ToolDefinition>
  selectedStep: string | null
  nodePositions: NodePositionMap
  onSelectStep: (id: string) => void
  onBindInput: (stepId: string, inputName: string, ref: string) => void
  onMoveNode: (nodeId: string, position: XYPosition) => void
  onAddTool: (toolId: string, blockId: string | undefined, position: XYPosition) => void
}

const nodeTypes: NodeTypes = {
  sourcePool: SourcePoolNode,
  step: StepNode
}

export function WorkflowDiagram({
  workflow,
  tools,
  selectedStep,
  nodePositions,
  onSelectStep,
  onBindInput,
  onMoveNode,
  onAddTool
}: WorkflowDiagramProps): JSX.Element {
  const graph = useMemo(
    () => buildWorkflowGraph(workflow, tools, selectedStep, onSelectStep, nodePositions),
    [workflow, tools, selectedStep, onSelectStep, nodePositions]
  )

  return (
    <ReactFlowProvider>
      <WorkflowDiagramCanvas
        nodes={graph.nodes}
        edges={graph.edges}
        onBindInput={onBindInput}
        onMoveNode={onMoveNode}
        onAddTool={onAddTool}
      />
    </ReactFlowProvider>
  )
}

function WorkflowDiagramCanvas({
  nodes: graphNodes,
  edges,
  onBindInput,
  onMoveNode,
  onAddTool
}: {
  nodes: NeuroflowNode[]
  edges: ReturnType<typeof buildWorkflowGraph>['edges']
  onBindInput: (stepId: string, inputName: string, ref: string) => void
  onMoveNode: (nodeId: string, position: XYPosition) => void
  onAddTool: (toolId: string, blockId: string | undefined, position: XYPosition) => void
}): JSX.Element {
  const [nodes, setNodes, onNodesChange] = useNodesState(graphNodes)
  const { screenToFlowPosition } = useReactFlow()

  useEffect(() => {
    setNodes(graphNodes)
  }, [graphNodes, setNodes])

  const handleConnect = useCallback(
    (connection: Connection) => {
      const sourceRef = refForSource(connection.source, connection.sourceHandle)
      const target = targetForInput(connection.target, connection.targetHandle)
      if (!sourceRef || !target) return
      onBindInput(target.stepId, target.inputName, sourceRef)
    },
    [onBindInput]
  )

  const handleDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault()
      const payload = readToolDropPayload(event.dataTransfer)
      if (!payload) return
      const position = screenToFlowPosition({ x: event.clientX, y: event.clientY })
      onAddTool(payload.toolId, payload.blockId, { x: position.x - 122, y: position.y - 44 })
    },
    [onAddTool, screenToFlowPosition]
  )

  return (
    <div
      className="nf-flow"
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes('application/neuroflow-tool')) {
          event.preventDefault()
          event.dataTransfer.dropEffect = 'copy'
        }
      }}
      onDrop={handleDrop}
    >
      <ReactFlow<NeuroflowNode>
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onConnect={handleConnect}
        onNodeDragStop={(_, node: Node) => onMoveNode(node.id, node.position)}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        minZoom={0.35}
        maxZoom={1.4}
        connectOnClick
        connectionLineStyle={{ stroke: 'var(--nf-accent)', strokeWidth: 2 }}
        defaultEdgeOptions={{ type: 'smoothstep', style: { strokeWidth: 1.6 } }}
        proOptions={{ hideAttribution: true }}
      >
        <Background color="var(--nf-grid)" gap={18} />
        <MiniMap pannable zoomable nodeStrokeWidth={3} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  )
}

function readToolDropPayload(dataTransfer: DataTransfer): { toolId: string; blockId?: string } | null {
  const rawPayload = dataTransfer.getData('application/neuroflow-tool')
  if (!rawPayload) return null

  try {
    const payload = JSON.parse(rawPayload) as { toolId?: unknown; blockId?: unknown }
    if (typeof payload.toolId !== 'string') return null
    return {
      toolId: payload.toolId,
      blockId: typeof payload.blockId === 'string' ? payload.blockId : undefined
    }
  } catch {
    return null
  }
}

function refForSource(source?: string | null, sourceHandle?: string | null): string | null {
  if (!source || !sourceHandle?.startsWith('out:')) return null
  const outputName = sourceHandle.slice('out:'.length)

  if (source === 'inputs') return `inputs.${outputName}`
  if (source === 'context') return `context.${outputName}`
  if (source.startsWith('step:')) return `steps.${source.slice('step:'.length)}.outputs.${outputName}`

  return null
}

function targetForInput(
  target?: string | null,
  targetHandle?: string | null
): { stepId: string; inputName: string } | null {
  if (!target?.startsWith('step:') || !targetHandle?.startsWith('in:')) return null
  return {
    stepId: target.slice('step:'.length),
    inputName: targetHandle.slice('in:'.length)
  }
}

function SourcePoolNode({ data }: NodeProps): JSX.Element {
  const source = data as SourceNodeData
  const isInput = source.title === 'Inputs'
  return (
    <div className="nf-source-node">
      <div className="nf-source-title">
        {isInput ? <FileInput size={15} /> : <Database size={15} />}
        <span>
          <strong>{source.title}</strong>
          <small>{source.subtitle}</small>
        </span>
      </div>
      <div className="nf-source-fields">
        {source.fields.map((field) => (
          <div className="nf-port-row" key={field.name}>
            <span>
              <Circle size={7} fill="currentColor" />
              {field.name}
            </span>
            <code>{shortType(field.type)}</code>
            <Handle id={`out:${field.name}`} type="source" position={Position.Right} />
          </div>
        ))}
      </div>
    </div>
  )
}

function StepNode({ data }: NodeProps): JSX.Element {
  const step = data as StepNodeData
  return (
    <div
      className={step.selected ? 'nf-step-node is-selected' : 'nf-step-node'}
      onClick={() => step.onSelect(step.id)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          step.onSelect(step.id)
        }
      }}
      role="button"
      tabIndex={0}
    >
      <header>
        <span className="nf-node-icon">
          <Box size={16} />
        </span>
        <span>
          <strong>{step.id}</strong>
          <small>{step.toolLabel}</small>
        </span>
        <em>{step.index + 1}</em>
      </header>

      <div className="nf-node-io">
        <div className="nf-io-column">
          <p>Inputs</p>
          {step.inputs.map((input) => (
            <div className="nf-port-row nf-port-in" key={input.name}>
              <Handle id={`in:${input.name}`} type="target" position={Position.Left} />
              <span>{input.name}</span>
              <code>{shortType(input.type)}</code>
              {input.constant && <b title={input.constant}>=</b>}
            </div>
          ))}
        </div>

        <div className="nf-io-column">
          <p>Outputs</p>
          {step.outputs.map((output) => (
            <div className="nf-port-row nf-port-out" key={output.name}>
              <span>{output.name}</span>
              <code>{shortType(output.type)}</code>
              <Handle id={`out:${output.name}`} type="source" position={Position.Right} />
            </div>
          ))}
        </div>
      </div>

      {Object.keys(step.mappings).length > 0 && (
        <footer>
          <Sigma size={13} />
          {Object.entries(step.mappings)
            .map(([out, field]) => `${out} -> ${field}`)
            .join(', ')}
        </footer>
      )}
    </div>
  )
}
