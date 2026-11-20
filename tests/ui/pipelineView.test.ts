// npm run test:ui
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server.browser'
import { buildPayload, missingInputs, seedValues } from '../../src/domain/runInputs'
import { wrapToolAsWorkflow } from '../../src/domain/wrapTool'
import { PipelineView, type PipelineViewProps } from '../../src/components/PipelineView'
import { WorkflowLibrary } from '../../src/components/WorkflowLibrary'
import { RunPanel, formatElapsed, stepRunStates, type HostRunState, type RunPanelProps } from '../../src/components/RunPanel'
import { parseProgressMessage } from '../../src/domain/progress'
import { buildWorkflowGraph } from '../../src/domain/graph'
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
const done = (structured: Record<string, unknown>, record: Record<string, unknown> = {}) =>
  ({ ticket: 't', ok: true, runId: 'r1', status: 'completed', summary: '', sessionDir: '/s', record,
     structured: { runId: 'r1', status: 'completed', outputs: {}, provenance: '', ...structured } }) as HostRunState['finished']

test('RunPanel counts completed steps from the run record when progress gave none', () => {
  const html = panel(runState({ status: 'completed', finished: done({}, { steps: { a: { tool: 't', status: 'completed' } } }) }))
  assert.match(html, /Completed · 1 step</)
})

test('RunPanel lets the host name the output action', () => {
  const out = { o: { uri: 'u', type: 'neuro:volume', path: '/x/a.nii.gz', mediaType: 'application/x-nifti' } }
  const html = panel(runState({ status: 'completed', finished: done({ outputs: out }) }), { openLabel: () => 'Load' })
  assert.match(html, /title="Load \/x\/a.nii.gz"/)
  assert.match(html, />Load<\/button>/)
})

test('formatElapsed uses seconds, then minutes, then hours', () => {
  assert.equal(formatElapsed(0), '0 s')
  assert.equal(formatElapsed(42_900), '42 s')
  assert.equal(formatElapsed(125_000), '2 min 05 s')
  assert.equal(formatElapsed(4_270_000), '1 h 11 min')
})

test('RunPanel shows how long the run and its current step have been going', () => {
  const steps = { recon: { tool: 'x/freesurfer-recon-all', inputs: {} }, aseg: { tool: 'x/freesurfer-asegstats', inputs: {} } }
  const now = Date.now()
  const html = panel(
    runState({ status: 'running', progress: 0, total: 2, message: 'step 1/2: recon', currentStep: 'recon', startedAt: now - 125_000, stepStartedAt: now - 65_000 }),
    { workflow: { ...wf, steps } as unknown as WorkflowDocument }
  )
  assert.match(html, /class="nf-run-elapsed" title="Elapsed">.*2 min 0\d s<\/span>/)
  assert.match(html, /freesurfer-recon-all · 1 min 0\d s/)
})

test('RunPanel shows a finished run\'s duration from run.json, and none it cannot know', () => {
  const record = { startedAt: '2026-11-20T17:38:28Z', endedAt: '2026-11-20T18:49:38Z' }
  const timed = panel(runState({ status: 'completed', finished: done({}, record) }))
  assert.match(timed, /title="Duration">.*1 h 11 min<\/span>/)
  // First seen already over, with no times: no clock rather than "0 s".
  assert.ok(!panel(runState({ status: 'completed', finished: done({}) })).includes('nf-run-elapsed'))
  // A reused run ran nothing, so it has no duration of its own.
  assert.ok(!panel(runState({ status: 'completed', finished: done({ reused: true }, record) })).includes('nf-run-elapsed'))
})

test('parseProgressMessage reads the step, tool and stage', () => {
  assert.deepEqual(parseProgressMessage('step 1/2: recon (neuroflow.gallery.tools/freesurfer-recon-all)'),
    { index: 1, total: 2, stepId: 'recon', toolId: 'neuroflow.gallery.tools/freesurfer-recon-all' })
  assert.deepEqual(parseProgressMessage('step 1/2: recon (neuroflow.gallery.tools/freesurfer-recon-all): Curv .H and .K lh'),
    { index: 1, total: 2, stepId: 'recon', toolId: 'neuroflow.gallery.tools/freesurfer-recon-all', stage: 'Curv .H and .K lh' })
  assert.deepEqual(parseProgressMessage('step 2/3: aseg'), { index: 2, total: 3, stepId: 'aseg' })
  assert.equal(parseProgressMessage('done'), null)
})

const twoSteps = {
  ...wf,
  steps: { recon: { tool: 'x/freesurfer-recon-all', inputs: {} }, aseg: { tool: 'x/freesurfer-asegstats', inputs: {} } }
} as unknown as WorkflowDocument
const reconRunning = runState({
  status: 'running', progress: 0.38, total: 2, currentStep: 'recon',
  message: 'step 1/2: recon (x/freesurfer-recon-all): Tessellate lh'
})

test('stepRunStates marks the running step with its stage and the rest by progress or run.json', () => {
  assert.deepEqual(stepRunStates(twoSteps, reconRunning), {
    recon: { status: 'running', stage: 'Tessellate lh' },
    aseg: { status: 'pending' }
  })
  assert.deepEqual(stepRunStates(twoSteps, { ...reconRunning, currentStep: 'aseg', message: 'step 2/2: aseg (x/freesurfer-asegstats)' }), {
    recon: { status: 'succeeded' },
    aseg: { status: 'running' }
  })
  const record = { steps: { recon: { tool: 'x', status: 'completed' }, aseg: { tool: 'x', status: 'failed' } } }
  assert.deepEqual(stepRunStates(twoSteps, runState({ status: 'failed', finished: done({}, record) })), {
    recon: { status: 'succeeded' },
    aseg: { status: 'failed' }
  })
  // Cancelled mid-step with no record: the step was stopped, not left "running".
  assert.deepEqual(stepRunStates(twoSteps, { ...reconRunning, status: 'cancelled' }).recon, { status: 'skipped' })
  assert.deepEqual(stepRunStates(twoSteps, null), {})
})

test('RunPanel shows the running step and its stage', () => {
  const html = panel(reconRunning, { workflow: twoSteps })
  assert.match(html, /<span>Step 1 of 2: recon<\/span>/)
  assert.match(html, /class="nf-run-stage" title="Current stage">Tessellate lh</)
  assert.equal(html.match(/nf-run-stage/g)?.length, 1, 'only the running step shows a stage')
})

test('the diagram graph carries each step\'s run state', () => {
  const graph = buildWorkflowGraph(twoSteps, new Map(), null, () => {}, {}, new Map(), stepRunStates(twoSteps, reconRunning))
  const data = (id: string) => graph.nodes.find((n) => n.id === `step:${id}`)?.data as { run?: unknown }
  assert.deepEqual(data('recon').run, { status: 'running', stage: 'Tessellate lh' })
  assert.deepEqual(data('aseg').run, { status: 'pending' })
  const idle = buildWorkflowGraph(twoSteps, new Map(), null, () => {})
  assert.equal((idle.nodes.find((n) => n.id === 'step:recon')?.data as { run?: unknown }).run, undefined)
})
