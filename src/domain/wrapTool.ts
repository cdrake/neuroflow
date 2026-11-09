import type { ParameterDef, WorkflowDocument } from './neuroflow'
import { idTail } from './neuroflow'

/** One-step workflow around a tool document: inputs bound by ref, every output exposed. */
export function wrapToolAsWorkflow(toolDoc: unknown): WorkflowDocument {
  const tool = toolDoc as {
    neuroflow?: string
    id: string
    version?: string
    description?: string
    inputs?: Record<string, ParameterDef>
    outputs?: Record<string, ParameterDef>
  }
  const stepId = idTail(tool.id)
  const inputs = tool.inputs ?? {}
  return {
    neuroflow: tool.neuroflow ?? '0.1.0',
    kind: 'workflow',
    id: tool.id,
    version: tool.version ?? '0.1.0',
    description: tool.description ?? '',
    inputs: { ...inputs },
    steps: {
      [stepId]: {
        tool: tool.id,
        inputs: Object.fromEntries(Object.keys(inputs).map((name) => [name, { ref: `inputs.${name}` }]))
      }
    },
    outputs: Object.fromEntries(
      Object.entries(tool.outputs ?? {}).map(([name, def]) => [name, { ...def, ref: `steps.${stepId}.outputs.${name}` }])
    )
  }
}
