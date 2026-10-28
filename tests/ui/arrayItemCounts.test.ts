// npm run test:ui
// validation.ts itemCountIssue: mirrors item_count_issue in neuroflow-core.
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
    inputs: {
      t1: { type: 'neuro:volume', description: 'T1' },
      images: { type: 'core:array<neuro:volume>', description: 'Images' }
    },
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
      inputs: { brain: { type: 'core:array<neuro:volume>', description: 'Brain', maxItems: 3 } },
      outputs: { labels: { type: 'neuro:label-map', description: 'Labels' } }
    }
  ] as unknown as ToolDefinition[]
  return { workflow, tools }
}

function countIssues(workflow: WorkflowDocument, tools: ToolDefinition[]): string[] {
  return validateWorkflowLocally(workflow, tools)
    .issues.filter((issue) => issue.message.startsWith('Input brain takes'))
    .map((issue) => `${issue.severity}: ${issue.message}`)
}

test('a single ref counts as one item', () => {
  const { workflow, tools } = fixture()
  assert.deepEqual(countIssues(workflow, tools), [])
  tools[1].inputs.brain.minItems = 2
  assert.deepEqual(countIssues(workflow, tools), ['error: Input brain takes between 2 and 3 items, but the binding supplies 1.'])
})

test('an array constant counts its items', () => {
  const { workflow, tools } = fixture()
  tools[1].inputs.brain.minItems = 2
  workflow.steps.segment.inputs.brain = { constant: ['/a', '/b', '/c', '/d'] }
  assert.deepEqual(countIssues(workflow, tools), ['error: Input brain takes between 2 and 3 items, but the binding supplies 4.'])
  workflow.steps.segment.inputs.brain = { constant: ['/a', '/b'] }
  assert.deepEqual(countIssues(workflow, tools), [])
})

test('an array ref is counted at run time', () => {
  const { workflow, tools } = fixture()
  tools[1].inputs.brain.minItems = 2
  tools[1].inputs.brain.maxItems = 2
  workflow.steps.segment.inputs.brain = { ref: 'inputs.images' }
  const report = validateWorkflowLocally(workflow, tools)
  assert.equal(report.ok, true, JSON.stringify(report.issues))
  assert.deepEqual(countIssues(workflow, tools), ["warning: Input brain takes exactly 2 items; the array's length is checked at run time."])
})

test('item counts on a scalar input are ignored', () => {
  const { workflow, tools } = fixture()
  tools[1].inputs.brain = { type: 'neuro:volume', description: 'Brain', minItems: 2 }
  assert.deepEqual(countIssues(workflow, tools), [])
})
