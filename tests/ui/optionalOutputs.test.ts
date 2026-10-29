// npm run test:ui
// validation.ts optionalStepOutput: mirrors optional_step_output in neuroflow-core.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateWorkflowLocally } from '../../src/domain/validation'
import type { ToolDefinition, WorkflowDocument } from '../../src/domain/neuroflow'

function fixture(): { workflow: WorkflowDocument; tools: ToolDefinition[] } {
  const workflow = {
    neuroflow: '0.1.0',
    kind: 'workflow',
    id: 'test/strip-segment',
    version: '0.1.0',
    description: 'Two-step workflow',
    inputs: { t1: { type: 'neuro:volume', description: 'T1' } },
    steps: {
      strip: { tool: 'test.tools/strip', inputs: { t1: { ref: 'inputs.t1' } } },
      segment: { tool: 'test.tools/segment', inputs: { brain: { ref: 'steps.strip.outputs.brain' } } }
    },
    outputs: { labels: { type: 'neuro:label-map', ref: 'steps.segment.outputs.labels' } }
  } as unknown as WorkflowDocument
  const tools = [
    {
      id: 'test.tools/strip',
      name: 'strip',
      inputs: { t1: { type: 'neuro:volume', description: 'T1' } },
      outputs: { brain: { type: 'neuro:volume', description: 'Brain' } }
    },
    {
      id: 'test.tools/segment',
      name: 'segment',
      inputs: { brain: { type: 'neuro:volume', description: 'Brain' } },
      outputs: { labels: { type: 'neuro:label-map', description: 'Labels' } }
    }
  ] as unknown as ToolDefinition[]
  return { workflow, tools }
}

function optionalWarnings(workflow: WorkflowDocument, tools: ToolDefinition[]): string[] {
  const report = validateWorkflowLocally(workflow, tools)
  assert.equal(report.ok, true, JSON.stringify(report.issues))
  return report.issues
    .filter((issue) => issue.severity === 'warning' && issue.code === 'optional-output')
    .map((issue) => issue.path ?? '')
}

test('an optional output feeding a required input is a warning', () => {
  const { workflow, tools } = fixture()
  assert.deepEqual(optionalWarnings(workflow, tools), [])
  tools[0].outputs.brain.optional = true
  assert.deepEqual(optionalWarnings(workflow, tools), ['steps.segment.inputs.brain'])
  tools[1].inputs.brain.optional = true
  assert.deepEqual(optionalWarnings(workflow, tools), [])
  tools[1].inputs.brain.optional = false
  tools[1].inputs.brain.default = 'brain.nii.gz'
  assert.deepEqual(optionalWarnings(workflow, tools), [])
})

test('a workflow output bound to an optional output is a warning', () => {
  const { workflow, tools } = fixture()
  tools[1].outputs.labels.optional = true
  assert.deepEqual(optionalWarnings(workflow, tools), ['outputs.labels.ref'])
})

test('an optional workflow output accepts an absent value', () => {
  const { workflow, tools } = fixture()
  tools[1].outputs.labels.optional = true
  workflow.neuroflow = '0.1.3'
  workflow.outputs.labels.optional = true
  assert.deepEqual(optionalWarnings(workflow, tools), [])
})

test('workflow output fields need spec 0.1.3', () => {
  const { workflow, tools } = fixture()
  Object.assign(workflow.outputs.labels, { optional: true, label: 'Labels', default: 'labels.nii.gz' })
  const errors = validateWorkflowLocally(workflow, tools).issues
    .filter((issue) => issue.severity === 'error')
    .map((issue) => `${issue.path}: ${issue.message}`)
    .sort()
  assert.deepEqual(errors, [
    'outputs.labels.default: A workflow output takes no default; its value comes from ref.',
    'outputs.labels.label: Workflow output label requires neuroflow 0.1.3.',
    'outputs.labels.optional: Workflow output optional requires neuroflow 0.1.3.'
  ])
})
