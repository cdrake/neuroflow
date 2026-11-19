// npm run test:ui
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server.browser'
import { buildPayload, missingInputs, seedValues } from '../../src/domain/runInputs'
import { wrapToolAsWorkflow } from '../../src/domain/wrapTool'
import { PipelineView, type PipelineViewProps } from '../../src/components/PipelineView'
import type { HostRunState } from '../../src/components/RunPanel'
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
  assert.deepEqual(missingInputs(wf, { sigma: '2' }, { input: '' }), [])
  assert.deepEqual(buildPayload(wf, { input: 'x' }, { input: '' }), {})
  assert.deepEqual(seedValues({ a: '1' }, { a: null, b: undefined }), { a: '1' })
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

test('wrapToolAsWorkflow rejects non-tool input', () => {
  for (const bad of [null, 'x', {}, { id: 1 }, { id: 'a', kind: 'workflow' }]) {
    assert.throws(() => wrapToolAsWorkflow(bad), /expected a tool document/)
  }
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
  assert.ok(!html.includes('placeholder="/absolute/path inside a data root"'))
})

test('RunPanel Cancel follows the run status, not a host ticket', () => {
  const w = wrapToolAsWorkflow(toolDoc)
  const run = (status: HostRunState['status'], ticket: string | null): HostRunState => ({
    ticket, workflowId: w.id, status, progress: 0, total: 1, message: '', currentStep: null,
    finished: null, stderrTail: null, error: null
  })
  const cancel = (props: Record<string, unknown>): boolean => {
    const html = renderToStaticMarkup(
      createElement(PipelineView, {
        items: [], activeId: w.id, onSelect: () => {}, workflow: w, tools: new Map(),
        onStart: () => {}, onCancel: () => {}, onOpen: () => {}, run: null, ...props
      } as PipelineViewProps)
    )
    const button = html.match(/<button[^>]*title="Stop the current run"[^>]*>/)?.[0]
    assert.ok(button, 'Cancel button rendered')
    return !button.includes('disabled')
  }
  // A host without tickets (a batch runner) can still cancel a running run.
  assert.equal(cancel({ run: run('running', null) }), true)
  assert.equal(cancel({ run: run('starting', null) }), true)
  // A host can hold Cancel back until it can act, as the desktop does before its ticket arrives.
  assert.equal(cancel({ run: run('running', null), canCancel: false }), false)
  assert.equal(cancel({ run: run('running', 't1'), canCancel: true }), true)
  // Nothing to cancel once the run has ended, or before one starts.
  assert.equal(cancel({ run: run('completed', '') }), false)
  assert.equal(cancel({ run: null }), false)
})

test('RunPanel says a reused run ran nothing and offers Run anew with rerun', () => {
  const w = wrapToolAsWorkflow(toolDoc)
  const finished = (reused: boolean): HostRunState['finished'] => ({
    ticket: '', ok: true, runId: 'run-1', status: 'completed', summary: '', sessionDir: '',
    structured: { runId: 'run-1', status: 'completed', outputs: {}, provenance: '', ...(reused ? { reused: true } : {}) },
    record: {}
  })
  const render = (reused: boolean): string =>
    renderToStaticMarkup(
      createElement(PipelineView, {
        items: [], activeId: w.id, onSelect: () => {}, workflow: w, tools: new Map(),
        onStart: () => {}, onCancel: () => {}, onOpen: () => {},
        run: {
          ticket: '', workflowId: w.id, status: 'completed', progress: 0, total: 0, message: '', currentStep: null,
          finished: finished(reused), stderrTail: null, error: null
        }
      } as PipelineViewProps)
    )
  const reused = render(true)
  assert.ok(reused.includes('Reused run-1 · inputs unchanged, nothing ran'))
  assert.ok(reused.includes('Run anew'))
  assert.ok(!reused.includes('Completed · 0 steps'))
  const fresh = render(false)
  assert.ok(fresh.includes('Completed · 0 steps'))
  assert.ok(!fresh.includes('Run anew'))
})
