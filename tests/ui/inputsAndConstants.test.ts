// npm run test:ui
// validation.ts: mirrors the input-undeclared, output-ref-not-step and constant-invalid checks in neuroflow-core.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateWorkflowLocally } from '../../src/domain/validation'
import type { ToolDefinition, WorkflowDocument } from '../../src/domain/neuroflow'

function fixture(param: Record<string, unknown>, constant: unknown, ref = 'inputs.t1', outputRef = 'steps.strip.outputs.brain') {
  const workflow = {
    neuroflow: '0.1.0',
    kind: 'workflow',
    id: 'test/strip',
    version: '0.1.0',
    description: 'One-step workflow',
    inputs: { t1: { type: 'neuro:volume', description: 'T1' } },
    steps: { strip: { tool: 'test.tools/strip', inputs: { t1: { ref }, param: { constant } } } },
    outputs: { brain: { type: 'neuro:volume', ref: outputRef } }
  } as unknown as WorkflowDocument
  const tools = [
    {
      id: 'test.tools/strip',
      name: 'strip',
      inputs: { t1: { type: 'neuro:volume', description: 'T1' }, param: { description: 'Param', ...param } },
      outputs: { brain: { type: 'neuro:volume', description: 'Brain' } }
    }
  ] as unknown as ToolDefinition[]
  return validateWorkflowLocally(workflow, tools)
}

test('tags a workflow output that does not reference a step', () => {
  const report = fixture({ type: 'core:number' }, 1, 'inputs.t1', 'inputs.t1')
  const issue = report.issues.find((i) => i.code === 'output-ref-not-step')
  assert.equal(issue?.path, 'outputs.brain.ref')
})

test('rejects a reference to an undeclared workflow input', () => {
  const report = fixture({ type: 'core:number' }, 1, 'inputs.nonexistent')
  const issue = report.issues.find((i) => i.code === 'input-undeclared')
  assert.equal(report.ok, false)
  assert.equal(issue?.path, 'steps.strip.inputs.t1')
  assert.equal(issue?.hint, 'Declared inputs: t1.')
})

test('rejects an input declaration that is not an object', () => {
  const workflow = {
    neuroflow: '0.1.0', kind: 'workflow', id: 'test/x', version: '0.1.0', description: 'x',
    inputs: { image: null, other: 'hello' }, steps: {}, outputs: {}
  } as unknown as WorkflowDocument
  const paths = validateWorkflowLocally(workflow)
    .issues.filter((i) => i.message === 'Workflow input declaration must be an object.')
    .map((i) => i.path)
  assert.deepEqual(paths, ['inputs.image', 'inputs.other'])
})

test('rejects workflow inputs that are not an object', () => {
  const workflow = {
    neuroflow: '0.1.0', kind: 'workflow', id: 'test/x', version: '0.1.0', description: 'x',
    inputs: 'hello', steps: {}, outputs: {}
  } as unknown as WorkflowDocument
  const paths = validateWorkflowLocally(workflow)
    .issues.filter((i) => i.message === 'Workflow inputs must be an object.')
    .map((i) => i.path)
  assert.deepEqual(paths, ['inputs'])
})

test('checks a constant against the input declaration', () => {
  const invalid: [Record<string, unknown>, unknown][] = [
    [{ type: 'core:array<core:number>' }, '[10,20]'],
    [{ type: 'core:integer' }, 1.5],
    [{ type: 'core:number', min: 0 }, -3],
    [{ type: 'core:number', max: 1 }, 5],
    [{ type: 'core:number' }, '0.7'],
    [{ type: 'core:boolean' }, 'true'],
    [{ type: 'core:integer', enum: [1, 2, 3, 4] }, 7]
  ]
  for (const [declaration, constant] of invalid) {
    const issues = fixture(declaration, constant).issues.filter((i) => i.code === 'constant-invalid')
    assert.equal(issues.length, 1, `${JSON.stringify(declaration)} ${JSON.stringify(constant)}`)
    assert.equal(issues[0].path, 'steps.strip.inputs.param')
  }
  const valid: [Record<string, unknown>, unknown][] = [
    [{ type: 'core:array<core:number>' }, [10, 20]],
    [{ type: 'core:array<core:number>' }, 10],
    [{ type: 'core:integer', min: 0, enum: [1, 2] }, 2]
  ]
  for (const [declaration, constant] of valid) {
    const report = fixture(declaration, constant)
    assert.ok(report.ok, `${JSON.stringify(declaration)} ${JSON.stringify(constant)}: ${JSON.stringify(report.issues)}`)
  }
})
