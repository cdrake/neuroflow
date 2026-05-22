import { invoke } from '@tauri-apps/api/core'
import type { ValidationIssue, ValidationReport, WorkflowDocument, WorkflowPlan } from './neuroflow'

const REF_PATTERN =
  /^(inputs\.[A-Za-z][A-Za-z0-9_-]*|context|context\.[A-Za-z][A-Za-z0-9_-]*|steps\.[A-Za-z][A-Za-z0-9_-]*\.outputs\.[A-Za-z][A-Za-z0-9_-]*)$/

function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

export async function validateWorkflow(workflow: WorkflowDocument): Promise<ValidationReport> {
  if (isTauriRuntime()) {
    return invoke<ValidationReport>('validate_workflow', { workflow })
  }
  return validateWorkflowLocally(workflow)
}

export async function planWorkflow(workflow: WorkflowDocument): Promise<WorkflowPlan> {
  if (isTauriRuntime()) {
    return invoke<WorkflowPlan>('plan_workflow', { workflow })
  }
  return planWorkflowLocally(workflow)
}

export function validateWorkflowLocally(workflow: WorkflowDocument): ValidationReport {
  const issues: ValidationIssue[] = []
  const stepNames = new Set(Object.keys(workflow.steps))
  const contextFields = new Set(Object.keys(workflow.context?.fields ?? {}))

  if (workflow.kind !== 'workflow') {
    issues.push({ severity: 'error', path: 'kind', message: 'Document kind must be workflow.' })
  }

  for (const [stepName, step] of Object.entries(workflow.steps)) {
    if (!step.tool) {
      issues.push({ severity: 'error', path: `steps.${stepName}.tool`, message: 'Step has no tool.' })
    }

    for (const [inputName, binding] of Object.entries(step.inputs)) {
      if ('ref' in binding) {
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

    for (const [, contextField] of Object.entries(step.outputMappings ?? {})) {
      if (!contextFields.has(contextField)) {
        issues.push({
          severity: 'warning',
          path: `steps.${stepName}.outputMappings`,
          message: `Output mapping writes undeclared context field ${contextField}.`
        })
      }
    }
  }

  for (const [outputName, output] of Object.entries(workflow.outputs)) {
    if (!output.ref.startsWith('steps.')) {
      issues.push({
        severity: 'error',
        path: `outputs.${outputName}.ref`,
        message: 'Workflow outputs must reference step outputs.'
      })
    }
  }

  return { ok: issues.every((issue) => issue.severity !== 'error'), issues }
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
