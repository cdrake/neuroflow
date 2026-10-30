import { invoke } from '@tauri-apps/api/core'
import type { Binding, ToolDefinition, ValidationIssue, ValidationReport, WorkflowDocument, WorkflowPlan } from './neuroflow'
import { isConstantBinding, isRefBinding } from './neuroflow'
import { unknownFieldIssues } from './fields'
import { buildToolMap, resolveToolDefinition } from './registry'
import { arrayElementType } from './typeCompatibility'
import { SUPPORTED_SPEC_VERSIONS, compareQualifiers, qualifierIssues, resolveQualifiers, validateDocumentQualifiers } from './qualifiers'
export { SUPPORTED_SPEC_VERSIONS, TYPE_QUALIFIERS, declaredQualifiers } from './qualifiers'

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
  const issues: ValidationIssue[] = [...validateDocumentQualifiers(workflow), ...unknownFieldIssues(workflow)]
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
      // An optional workflow output (spec 0.1.3) is omitted when its source is absent.
      const issue = optionalStepOutput(output.ref, `outputs.${outputName}.ref`, `workflow output ${outputName}`, workflow, toolMap)
      if (issue && output.optional !== true) issues.push(issue)
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
      message: 'Workflow must target NeuroFlow spec version 0.1.0, 0.1.1, 0.1.2 or 0.1.3.'
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
      const sourceType = resolveRefType(binding.ref, workflow, toolMap)
      if (sourceType) {
        // A single value counts as one item; an array's length is only known at run time.
        const issue = itemCountIssue(inputName, inputDef, arrayElementType(sourceType) ? null : 1, `steps.${stepName}.inputs.${inputName}`)
        if (issue) issues.push(issue)
      }
      if (inputDef.optional !== true && inputDef.default === undefined) {
        const issue = optionalStepOutput(binding.ref, `steps.${stepName}.inputs.${inputName}`, `required input ${inputName}`, workflow, toolMap)
        if (issue) issues.push(issue)
      }
    }

    if (isConstantBinding(binding)) {
      issues.push(...qualifierIssues(`steps.${stepName}.inputs.${inputName}`, compareQualifiers({}, inputDef)))
      validateConstant(stepName, inputName, binding.constant, inputDef, issues)
      const count = Array.isArray(binding.constant) ? binding.constant.length : 1
      const issue = itemCountIssue(inputName, inputDef, count, `steps.${stepName}.inputs.${inputName}`)
      if (issue) issues.push(issue)
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

function itemBound(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined
}

function describeItemBounds(min: number | undefined, max: number | undefined): string {
  const items = (n: number) => `${n} item${n === 1 ? '' : 's'}`
  if (min !== undefined && max !== undefined) {
    return min === max ? `exactly ${items(min)}` : `between ${min} and ${items(max)}`
  }
  if (min !== undefined) return `at least ${items(min)}`
  if (max !== undefined) return `at most ${items(max)}`
  return 'any number of items'
}

// Mirrors item_count_issue in neuroflow-core: count is null when the binding is
// an array whose length is only known at run time, which is a warning.
function itemCountIssue(
  inputName: string,
  inputDef: ToolDefinition['inputs'][string],
  count: number | null,
  path: string
): ValidationIssue | null {
  if (!arrayElementType(inputDef.type)) return null
  const min = itemBound(inputDef.minItems)
  const max = itemBound(inputDef.maxItems)
  if (min === undefined && max === undefined) return null
  const bounds = describeItemBounds(min, max)
  if (count === null) {
    return { severity: 'warning', path, message: `Input ${inputName} takes ${bounds}; the array's length is checked at run time.` }
  }
  if ((min !== undefined && count < min) || (max !== undefined && count > max)) {
    return { severity: 'error', path, message: `Input ${inputName} takes ${bounds}, but the binding supplies ${count}.` }
  }
  return null
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

// Mirrors optional_step_output in neuroflow-core: a warning, since the tool can
// still produce the output.
function optionalStepOutput(
  ref: string,
  path: string,
  target: string,
  workflow: WorkflowDocument,
  toolMap: Map<string, ToolDefinition>
): ValidationIssue | null {
  const parts = ref.split('.')
  if (parts[0] !== 'steps' || parts.length !== 4 || parts[2] !== 'outputs') return null
  const step = workflow.steps[parts[1]]
  const tool = step ? resolveToolDefinition(toolMap, step.tool) : undefined
  if (tool?.outputs[parts[3]]?.optional !== true) return null
  return {
    severity: 'warning',
    path,
    message: `Output ${parts[3]} of ${tool.name} is optional, so ${target} may have no value when the step finishes.`,
    code: 'optional-output'
  }
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
