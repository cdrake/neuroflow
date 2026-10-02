import { invoke } from '@tauri-apps/api/core'
import type { Binding, ToolDefinition, ValidationIssue, ValidationReport, WorkflowDocument, WorkflowPlan } from './neuroflow'
import { isConstantBinding, isRefBinding } from './neuroflow'
import { buildToolMap, resolveToolDefinition } from './registry'
import { compareQualifiers, qualifierIssues, resolveQualifiers, validateDocumentQualifiers } from './qualifiers'
export { TYPE_QUALIFIERS, declaredQualifiers } from './qualifiers'

/** Spec versions this app reads: 0.1.1 is 0.1.0 plus the RFC 0010 type qualifiers. */
export const SUPPORTED_SPEC_VERSIONS: readonly string[] = ['0.1.0', '0.1.1']

const REF_PATTERN =
  /^(inputs\.[A-Za-z][A-Za-z0-9_-]*|context|context\.[A-Za-z][A-Za-z0-9_-]*|steps\.[A-Za-z][A-Za-z0-9_-]*\.outputs\.[A-Za-z][A-Za-z0-9_-]*)$/

function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

export async function validateWorkflow(
  workflow: WorkflowDocument,
  tools: ToolDefinition[] = []
): Promise<ValidationReport> {
  if (isTauriRuntime()) {
    return invoke<ValidationReport>('validate_workflow', { workflow, tools })
  }
  return validateWorkflowLocally(workflow, tools)
}

export async function planWorkflow(workflow: WorkflowDocument): Promise<WorkflowPlan> {
  if (isTauriRuntime()) {
    return invoke<WorkflowPlan>('plan_workflow', { workflow })
  }
  return planWorkflowLocally(workflow)
}

export function validateWorkflowLocally(
  workflow: WorkflowDocument,
  tools: ToolDefinition[] = []
): ValidationReport {
  const issues: ValidationIssue[] = validateDocumentQualifiers(workflow)
  const toolMap = buildToolMap(tools)
  for (const reference of new Set(Object.values(workflow.steps ?? {}).map((step) => step.tool))) {
    const tool = resolveToolDefinition(toolMap, reference)
    if (tool) {
      for (const issue of validateDocumentQualifiers(tool)) issues.push({ ...issue, path: `tools.${reference}.${issue.path}` })
    }
  }
  const stepNames = new Set(Object.keys(workflow.steps ?? {}))
  const contextFields = new Set(Object.keys(workflow.context?.fields ?? {}))

  for (const [name, declaration] of Object.entries(workflow.context?.fields ?? {})) {
    if ('default' in declaration) issues.push(...qualifierIssues(`context.fields.${name}.default`, compareQualifiers({}, declaration)))
  }

  validateWorkflowEnvelope(workflow, issues)

  if (workflow.kind !== 'workflow') {
    issues.push({ severity: 'error', path: 'kind', message: 'Document kind must be workflow.' })
  }

  for (const [stepName, step] of Object.entries(workflow.steps)) {
    const tool = resolveToolDefinition(toolMap, step.tool)
    if (!step.tool) {
      issues.push({ severity: 'error', path: `steps.${stepName}.tool`, message: 'Step has no tool.' })
    } else if (tools.length > 0 && !tool) {
      issues.push({
        severity: 'error',
        path: `steps.${stepName}.tool`,
        message: `Step references unknown tool ${step.tool}.`
      })
      continue
    }

    if (tool) {
      validateToolInputs(workflow, toolMap, stepName, step, tool, issues)
    }
    validateOutputMappings(workflow, toolMap, stepName, step, tool, issues)

    for (const [inputName, binding] of Object.entries(step.inputs)) {
      if (!validBindingShape(binding)) {
        issues.push({
          severity: 'error',
          path: `steps.${stepName}.inputs.${inputName}`,
          message: 'Binding must contain exactly one of ref or constant.'
        })
        continue
      }

      if (isRefBinding(binding)) {
        if (!REF_PATTERN.test(binding.ref)) {
          issues.push({
            severity: 'error',
            path: `steps.${stepName}.inputs.${inputName}`,
            message: `Invalid reference ${binding.ref}.`
          })
          continue
        }
        if (binding.ref.startsWith('context.')) {
          const field = binding.ref.slice('context.'.length)
          if (!contextFields.has(field)) {
            issues.push({
              severity: 'warning',
              path: `steps.${stepName}.inputs.${inputName}`,
              message: `Reference ${binding.ref} points to an undeclared context field.`
            })
          }
        }
        if (binding.ref.startsWith('steps.')) {
          const [, refStep] = binding.ref.split('.')
          if (!stepNames.has(refStep)) {
            issues.push({
              severity: 'error',
              path: `steps.${stepName}.inputs.${inputName}`,
              message: `Reference ${binding.ref} points to an unknown step.`
            })
          }
        }
      }
    }
  }

  for (const [outputName, output] of Object.entries(workflow.outputs)) {
    const resolved = resolveRefType(output.ref, workflow, toolMap)
    if (!output.ref.startsWith('steps.')) {
      issues.push({
        severity: 'error',
        path: `outputs.${outputName}.ref`,
        message: 'Workflow outputs must reference step outputs.'
      })
    } else if (!resolved && tools.length > 0) {
      issues.push({
        severity: 'error',
        path: `outputs.${outputName}.ref`,
        message: `Workflow output references unknown value ${output.ref}.`
      })
    } else if (resolved) {
      const source = resolveQualifiers(output.ref, workflow, toolMap)
      issues.push(...qualifierIssues(`outputs.${outputName}.ref`, compareQualifiers(source.declaration, output, source.spaceIdentity, source.spaceIdentity)))
    } else if (tools.length === 0) {
      issues.push(...qualifierIssues(`outputs.${outputName}.ref`, compareQualifiers({}, output)))
    }
  }

  return { ok: issues.every((issue) => issue.severity !== 'error'), issues }
}

function validateWorkflowEnvelope(workflow: WorkflowDocument, issues: ValidationIssue[]): void {
  if (!SUPPORTED_SPEC_VERSIONS.includes(workflow.neuroflow)) {
    issues.push({
      severity: 'error',
      path: 'neuroflow',
      message: 'Workflow must target NeuroFlow spec version 0.1.0 or 0.1.1.'
    })
  }
  if (!workflow.id || !workflow.id.includes('/')) {
    issues.push({
      severity: 'error',
      path: 'id',
      message: 'Workflow id must be a namespace-qualified document id.'
    })
  }
  if (!/^\d+\.\d+\.\d+$/.test(workflow.version)) {
    issues.push({
      severity: 'error',
      path: 'version',
      message: 'Workflow version must use semantic versioning.'
    })
  }
  if (!workflow.description) {
    issues.push({
      severity: 'error',
      path: 'description',
      message: 'Workflow description is required.'
    })
  }
}

function validateToolInputs(
  workflow: WorkflowDocument,
  toolMap: Map<string, ToolDefinition>,
  stepName: string,
  step: WorkflowDocument['steps'][string],
  tool: ToolDefinition,
  issues: ValidationIssue[]
): void {
  for (const [inputName, inputDef] of Object.entries(tool.inputs)) {
    const binding = step.inputs[inputName]
    if (inputDef.optional !== true && isMissingBinding(binding)) {
      issues.push({
        severity: 'error',
        path: `steps.${stepName}.inputs.${inputName}`,
        message: `Required input ${inputName} for ${tool.name} is not satisfied.`
      })
      continue
    }

    if (isRefBinding(binding)) {
      const source = resolveQualifiers(binding.ref, workflow, toolMap)
      issues.push(...qualifierIssues(`steps.${stepName}.inputs.${inputName}`, compareQualifiers(source.declaration, inputDef, source.spaceIdentity, source.spaceIdentity)))
    }

    if (isConstantBinding(binding)) {
      issues.push(...qualifierIssues(`steps.${stepName}.inputs.${inputName}`, compareQualifiers({}, inputDef)))
      validateConstant(stepName, inputName, binding.constant, inputDef, issues)
    }
  }

  for (const inputName of Object.keys(step.inputs)) {
    if (!(inputName in tool.inputs)) {
      issues.push({
        severity: 'warning',
        path: `steps.${stepName}.inputs.${inputName}`,
        message: `Input ${inputName} is not declared by ${tool.name}.`
      })
    }
  }
}

function validateOutputMappings(
  workflow: WorkflowDocument,
  toolMap: Map<string, ToolDefinition>,
  stepName: string,
  step: WorkflowDocument['steps'][string],
  tool: ToolDefinition | undefined,
  issues: ValidationIssue[]
): void {
  for (const [outputName, contextField] of Object.entries(step.outputMappings ?? {})) {
    if (tool && !(outputName in tool.outputs)) {
      issues.push({
        severity: 'error',
        path: `steps.${stepName}.outputMappings.${outputName}`,
        message: `Output mapping references unknown output ${outputName} on ${tool.name}.`
      })
      continue
    }
    const target = workflow.context?.fields[contextField]
    if (target) {
      const source = resolveQualifiers(`steps.${stepName}.outputs.${outputName}`, workflow, toolMap)
      issues.push(...qualifierIssues(`steps.${stepName}.outputMappings.${outputName}`, compareQualifiers(source.declaration, target, source.spaceIdentity)))
    } else {
      issues.push({
        severity: 'warning',
        path: `steps.${stepName}.outputMappings.${outputName}`,
        message: `Output mapping writes undeclared context field ${contextField}.`
      })
    }
  }
}

function validateConstant(
  stepName: string,
  inputName: string,
  value: unknown,
  inputDef: ToolDefinition['inputs'][string],
  issues: ValidationIssue[]
): void {
  if (inputDef.enum && !inputDef.enum.includes(value)) {
    issues.push({
      severity: 'error',
      path: `steps.${stepName}.inputs.${inputName}`,
      message: `Constant for ${inputName} must be one of ${inputDef.enum.join(', ')}.`
    })
  }
  if (typeof value === 'number') {
    if (typeof inputDef.min === 'number' && value < inputDef.min) {
      issues.push({
        severity: 'error',
        path: `steps.${stepName}.inputs.${inputName}`,
        message: `Constant for ${inputName} must be at least ${inputDef.min}.`
      })
    }
    if (typeof inputDef.max === 'number' && value > inputDef.max) {
      issues.push({
        severity: 'error',
        path: `steps.${stepName}.inputs.${inputName}`,
        message: `Constant for ${inputName} must be at most ${inputDef.max}.`
      })
    }
  }
}

function resolveRefType(
  ref: string,
  workflow: WorkflowDocument,
  toolMap: Map<string, ToolDefinition>
): string | null {
  if (ref === 'context') return 'core:object'

  const parts = ref.split('.')
  if (parts[0] === 'inputs' && parts.length === 2) {
    return workflow.inputs[parts[1]]?.type ?? null
  }
  if (parts[0] === 'context' && parts.length === 2) {
    return workflow.context?.fields[parts[1]]?.type ?? null
  }
  if (parts[0] === 'steps' && parts.length === 4 && parts[2] === 'outputs') {
    const step = workflow.steps[parts[1]]
    if (!step) return null
    const tool = resolveToolDefinition(toolMap, step.tool)
    return tool?.outputs[parts[3]]?.type ?? null
  }
  return null
}

function isMissingBinding(binding: Binding | undefined): boolean {
  if (!binding) return true
  if (isRefBinding(binding)) return binding.ref.trim() === ''
  if (isConstantBinding(binding)) return binding.constant === ''
  return true
}

function validBindingShape(binding: Binding): boolean {
  return (isRefBinding(binding) ? 1 : 0) + (isConstantBinding(binding) ? 1 : 0) === 1
}

export function planWorkflowLocally(workflow: WorkflowDocument): WorkflowPlan {
  return {
    workflowId: workflow.id,
    steps: Object.entries(workflow.steps).map(([id, step]) => ({
      id,
      tool: step.tool,
      reads: Object.values(step.inputs)
        .filter((binding): binding is { ref: string } => 'ref' in binding)
        .map((binding) => binding.ref),
      writes: Object.entries(step.outputMappings ?? {}).map(
        ([output, field]) => `steps.${id}.outputs.${output} -> context.${field}`
      )
    })),
    outputs: Object.entries(workflow.outputs).map(([name, output]) => `${name} <- ${output.ref}`)
  }
}
