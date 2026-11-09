// npm run test:ui
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server.browser'
import { buildPayload, missingInputs, seedValues } from '../../src/domain/runInputs'
import { wrapToolAsWorkflow } from '../../src/domain/wrapTool'
import { PipelineView } from '../../src/components/PipelineView'
import { WorkflowLibrary } from '../../src/components/WorkflowLibrary'
import type { WorkflowDocument } from '../../src/domain/neuroflow'

const toolDoc = JSON.parse(
  readFileSync(new URL('../../gallery/tools/python-volume-filter.tool.json', import.meta.url).pathname, 'utf8')
)

const wf = {
  neuroflow: '0.1.0',
  kind: 'workflow',
  id: 'w',
  version: '0.1.0',
  description: '',
  inputs: { input: { type: 'core:string' }, sigma: { type: 'core:number' } },
  steps: {},
  outputs: {}
} as WorkflowDocument

test('seedValues lets initial win and stringifies non-strings', () => {
  assert.deepEqual(seedValues({ a: '1', b: 'x' }, { b: 'y', c: 3 }), { a: '1', b: 'y', c: '3' })
})

test('missingInputs skips locked inputs', () => {
  assert.deepEqual(missingInputs(wf, { sigma: '2' }, { input: '3 volumes' }), [])
  assert.deepEqual(missingInputs(wf, { sigma: '2' }), ['input'])
})

test('buildPayload leaves locked inputs out', () => {
  assert.deepEqual(buildPayload(wf, { input: 'x', sigma: '2' }, { input: '3 volumes' }), { sigma: 2 })
  assert.deepEqual(buildPayload(wf, { input: 'x', sigma: '2' }), { input: 'x', sigma: 2 })
})

test('wrapToolAsWorkflow binds every tool input by ref and exposes every output', () => {
  const w = wrapToolAsWorkflow(toolDoc)
  assert.equal(w.id, toolDoc.id)
  const [stepId, step] = Object.entries(w.steps)[0]
  assert.equal(stepId, 'python-volume-filter')
  assert.equal(Object.keys(w.steps).length, 1)
  for (const name of Object.keys(toolDoc.inputs)) {
    assert.deepEqual(step.inputs[name], { ref: `inputs.${name}` })
    assert.ok(w.inputs[name])
  }
  assert.deepEqual(Object.keys(w.outputs), Object.keys(toolDoc.outputs))
})

test('WorkflowLibrary hides New without onCreate', () => {
  const html = renderToStaticMarkup(createElement(WorkflowLibrary, { items: [], activeId: '', onSelect: () => {} }))
  assert.ok(!html.includes('New workflow'))
})

test('PipelineView renders library, diagram slot, targets and locked label', () => {
  const w = wrapToolAsWorkflow(toolDoc)
  const html = renderToStaticMarkup(
    createElement(PipelineView, {
      items: [{ id: w.id, label: 'Filter', description: 'd', workflow: w }],
      activeId: w.id,
      onSelect: () => {},
      workflow: w,
      tools: new Map(),
      run: null,
      lockedInputs: { bids_dir: '3 volumes' },
      onStart: () => {},
      onCancel: () => {},
      onOpen: () => {},
      targets: createElement('p', null, 'TARGETS')
    })
  )
  assert.ok(html.includes('nf-pipeline-view'))
  assert.ok(html.includes('Filter'))
  assert.ok(html.includes('TARGETS'))
  assert.ok(html.includes('3 volumes'))
  assert.ok(!html.includes('<input name="bids_dir"'))
  assert.ok(!html.includes('placeholder="/absolute/path inside a data root"'))
})
