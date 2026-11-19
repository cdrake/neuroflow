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
import { RunPanel, type HostRunState, type RunPanelProps } from '../../src/components/RunPanel'
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

const runState = (over: Partial<HostRunState>): HostRunState => ({
  ticket: null,
  workflowId: 'w',
  status: 'running',
  progress: 0,
  total: 0,
  message: '',
  currentStep: null,
  finished: null,
  stderrTail: null,
  error: null,
  ...over
})
const panel = (run: HostRunState, extra: Partial<RunPanelProps> = {}) =>
  renderToStaticMarkup(
    createElement(RunPanel, {
      workflow: wf,
      available: true,
      report: { ok: true, issues: [] } as unknown as RunPanelProps['report'],
      runnable: null,
      environmentChecked: true,
      run,
      onStart: () => {},
      onCancel: () => {},
      onOpen: () => {},
      ...extra
    })
  )
const finished = (structured: Record<string, unknown>, record: Record<string, unknown> = {}) =>
  ({ ticket: 't', ok: true, runId: 'r1', status: 'completed', summary: '', sessionDir: '/s', record,
     structured: { runId: 'r1', status: 'completed', outputs: {}, provenance: '', ...structured } }) as HostRunState['finished']

test('RunPanel enables Stop while running even before a ticket arrives', () => {
  const html = panel(runState({ status: 'running' }))
  assert.match(html, /<button class="nf-action" title="Stop the current run"/)
})

test('RunPanel says a reused run reused an earlier one', () => {
  const html = panel(runState({ status: 'completed', finished: finished({ reused: true }) }))
  assert.match(html, /Reused run r1 · inputs unchanged/)
})

test('RunPanel counts completed steps from the run record when progress gave none', () => {
  const html = panel(runState({ status: 'completed', finished: finished({}, { steps: { a: { tool: 't', status: 'completed' } } }) }))
  assert.match(html, /Completed · 1 step</)
})

test('RunPanel lets the host name the output action', () => {
  const out = { o: { uri: 'u', type: 'neuro:volume', path: '/x/a.nii.gz', mediaType: 'application/x-nifti' } }
  const html = panel(runState({ status: 'completed', finished: finished({ outputs: out }) }), { openLabel: () => 'Load' })
  assert.match(html, /title="Load \/x\/a.nii.gz"/)
  assert.match(html, />Load<\/button>/)
})
