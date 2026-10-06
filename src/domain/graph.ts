import type { Edge, Node, XYPosition } from '@xyflow/react'
import type { BlockCategory, ToolDefinition, WorkflowDocument } from './neuroflow'
import { isConstantBinding, isRefBinding, stableToolName } from './neuroflow'
import { categoryColor, getToolBlocks, resolveToolDefinition } from './registry'
import type { ToolStatus } from './host'

export interface SourceNodeData extends Record<string, unknown> {
  title: string
  subtitle: string
  fields: Array<{ name: string; type: string }>
}

export interface StepNodeData extends Record<string, unknown> {
  id: string
  toolLabel: string
  tool?: ToolDefinition
  category?: BlockCategory
  /** Design category color for the node's accent strip. */
  color: string
  /** Host readiness from the last environment check, when known. */
  readiness?: ToolStatus
  index: number
  inputs: Array<{ name: string; type: string; binding?: string; constant?: string }>
  outputs: Array<{ name: string; type: string }>
  mappings: Record<string, string>
  selected: boolean
  onSelect: (id: string) => void
}

export type NeuroflowNode = Node<SourceNodeData | StepNodeData>
export type NodePositionMap = Record<string, XYPosition>

const SOURCE_X = 24
const STEP_X = 420
const STEP_Y = 92
const STEP_GAP = 350

export function buildWorkflowGraph(
  workflow: WorkflowDocument,
  tools: Map<string, ToolDefinition>,
  selectedStep: string | null,
  onSelectStep: (id: string) => void,
  positions: NodePositionMap = {},
  toolStatuses: Map<string, ToolStatus> = new Map()
): { nodes: NeuroflowNode[]; edges: Edge[] } {
  const nodes: NeuroflowNode[] = [
    {
      id: 'inputs',
      type: 'sourcePool',
      position: positions.inputs ?? { x: SOURCE_X, y: 96 },
      data: {
        title: 'Inputs',
        subtitle: 'launch values',
        fields: Object.entries(workflow.inputs).map(([name, def]) => ({ name, type: def.type }))
      }
    },
    {
      id: 'context',
      type: 'sourcePool',
      position: positions.context ?? { x: SOURCE_X, y: 308 },
      data: {
        title: 'Context',
        subtitle: 'run sidecar',
        fields: Object.entries(workflow.context?.fields ?? {}).map(([name, def]) => ({
          name,
          type: def.type
        }))
      }
    }
  ]

  const edges: Edge[] = []
  const stepEntries = Object.entries(workflow.steps)

  stepEntries.forEach(([stepId, step], index) => {
    const tool = resolveToolDefinition(tools, step.tool)
    const inputDefs = tool?.inputs ?? {}
    const outputDefs = tool?.outputs ?? {}
    const block = tool ? getToolBlocks(tool)[0] : undefined

    nodes.push({
      id: `step:${stepId}`,
      type: 'step',
      position: positions[`step:${stepId}`] ?? {
        x: STEP_X + index * STEP_GAP,
        y: STEP_Y + (index % 2) * 86
      },
      data: {
        id: stepId,
        tool,
        toolLabel: block?.label ?? tool?.name ?? stableToolName(step.tool),
        category: block?.category,
        color: categoryColor(block?.category),
        readiness: tool ? toolStatuses.get(tool.id) : undefined,
        index,
        selected: selectedStep === stepId,
        inputs: Object.entries(inputDefs).map(([name, def]) => {
          const binding = step.inputs[name]
          return {
            name,
            type: def.type,
            binding: isRefBinding(binding) ? binding.ref : undefined,
            constant: isConstantBinding(binding) ? JSON.stringify(binding.constant) : undefined
          }
        }),
        outputs: Object.entries(outputDefs).map(([name, def]) => ({ name, type: def.type })),
        mappings: step.outputMappings ?? {},
        onSelect: onSelectStep
      }
    })

    for (const [inputName, binding] of Object.entries(step.inputs)) {
      if (!isRefBinding(binding)) continue
      const source = sourceForRef(binding.ref)
      if (!source) continue
      edges.push({
        id: `${source.node}:${source.handle}->${stepId}:${inputName}`,
        source: source.node,
        sourceHandle: source.handle,
        target: `step:${stepId}`,
        targetHandle: `in:${inputName}`,
        type: 'smoothstep',
        animated: binding.ref.startsWith('steps.'),
        label: inputName,
        style: { strokeWidth: 1.6 }
      })
    }
  })

  for (const [outputName, output] of Object.entries(workflow.outputs)) {
    const source = sourceForRef(output.ref)
    if (!source) continue
    edges.push({
      id: `${source.node}:${source.handle}->workflow-output:${outputName}`,
      source: source.node,
      sourceHandle: source.handle,
      target: source.node,
      targetHandle: source.handle,
      label: outputName,
      hidden: true
    })
  }

  return { nodes, edges }
}

function sourceForRef(ref: string): { node: string; handle: string } | null {
  if (ref.startsWith('inputs.')) {
    return { node: 'inputs', handle: `out:${ref.slice('inputs.'.length)}` }
  }
  if (ref.startsWith('context.')) {
    return { node: 'context', handle: `out:${ref.slice('context.'.length)}` }
  }
  if (ref.startsWith('steps.')) {
    const parts = ref.split('.')
    if (parts.length === 4 && parts[2] === 'outputs') {
      return { node: `step:${parts[1]}`, handle: `out:${parts[3]}` }
    }
  }
  return null
}
