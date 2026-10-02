import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import ts from 'typescript'

// Compile the real fallback modules; the same compiler is checked by npm run build.
const root = fileURLToPath(new URL('../../', import.meta.url))
const work = await mkdtemp(join(tmpdir(), 'neuroflow-qualifiers-'))
after(() => rm(work, { recursive: true, force: true }))
await writeFile(join(work, 'package.json'), '{"type":"commonjs"}')
await symlink(join(root, 'node_modules'), join(work, 'node_modules'), 'dir')
for (const name of ['neuroflow', 'typeCompatibility', 'registry', 'qualifiers', 'validation']) {
  const source = await readFile(new URL(`./${name}.ts`, import.meta.url), 'utf8')
  const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } })
  await writeFile(join(work, `${name}.js`), outputText)
}
const require = createRequire(join(work, 'package.json'))
const { compareQualifiers, resolveQualifiers, validateDocumentQualifiers } = require('./qualifiers.js')
const { validateWorkflowLocally } = require('./validation.js')
const { buildToolMap } = require('./registry.js')
const cases = JSON.parse(await readFile(join(root, 'crates/neuroflow-core/tests/fixtures/qualifiers.json'), 'utf8'))
for (const entry of cases) {
  test(`RFC conformance: ${entry.name}`, () => {
    const checks = compareQualifiers(entry.source, entry.target, entry.sourceIdentity, entry.targetIdentity)
    const outcome = checks.some((c) => c.outcome === 'incompatible') ? 'incompatible'
      : checks.some((c) => c.outcome === 'requires-runtime-check') ? 'requires-runtime-check' : 'compatible'
    assert.equal(outcome, entry.outcome)
  })
}

function graph() {
  const workflow = {
    neuroflow: '0.1.1', kind: 'workflow', id: 'test/chain', version: '1.0.0', description: 'Chain',
    inputs: { t1: { type: 'neuro:volume', formats: ['nii-gz'], space: 'individual', resolution: 1 } },
    steps: {
      a: { tool: 'test/pass', inputs: { image: { ref: 'inputs.t1' } } },
      b: { tool: 'test/pass', inputs: { image: { ref: 'steps.a.outputs.image' } } }
    },
    outputs: { image: { type: 'neuro:volume', formats: ['nifti'], ref: 'steps.b.outputs.image' } }
  }
  const tools = [{
    neuroflow: '0.1.1', kind: 'tool', id: 'test/pass', name: 'pass', version: '1.0.0',
    inputs: { image: { type: 'neuro:volume', formats: ['nifti'], space: 'individual' } },
    outputs: { image: { type: 'neuro:volume', formats: 'inputs.image', space: 'inputs.image', resolution: 'inputs.image' } }
  }]
  return { workflow, tools }
}

test('inheritance resolves through actual bindings and preserves acquisition identity', () => {
  const { workflow, tools } = graph()
  const resolved = resolveQualifiers('steps.b.outputs.image', workflow, buildToolMap(tools))
  assert.deepEqual(resolved.declaration.formats, ['nii-gz'])
  assert.equal(resolved.declaration.resolution, 1)
  assert.equal(resolved.spaceIdentity, 'inputs.t1')
  assert.deepEqual(validateWorkflowLocally(workflow, tools), { ok: true, issues: [] })
})

test('unknown values, constants and cycles do not establish qualifier facts', () => {
  const { workflow, tools } = graph()
  workflow.inputs.t1 = { type: 'neuro:volume' }
  const unknown = resolveQualifiers('steps.b.outputs.image', workflow, buildToolMap(tools))
  assert.equal(unknown.spaceIdentity, undefined)
  assert.equal(unknown.declaration.formats, undefined)
  assert.ok(validateWorkflowLocally(workflow, tools).issues.some((i) => i.message.includes('requires a runtime check')))
  workflow.steps.a.inputs.image = { constant: 'T1.nii.gz' }
  assert.ok(validateWorkflowLocally(workflow, tools).issues.some((i) => i.path === 'steps.a.inputs.image' && i.message.includes('requires a runtime check')))
  assert.ok(validateWorkflowLocally(workflow, tools).issues.some((i) => i.path === 'steps.a.inputs.image' && i.outcome === 'requires-runtime-check' && i.severity === 'warning'))
  workflow.steps.a.inputs.image = { ref: 'steps.b.outputs.image' }
  const cycle = resolveQualifiers('steps.b.outputs.image', workflow, buildToolMap(tools))
  assert.equal(cycle.spaceIdentity, undefined)
  assert.equal(cycle.declaration.formats, undefined)
})

test('known incompatible bindings and workflow outputs reject validation', () => {
  const { workflow, tools } = graph()
  workflow.inputs.t1.formats = ['mgz']
  const report = validateWorkflowLocally(workflow, tools)
  assert.equal(report.ok, false)
  for (const path of ['steps.a.inputs.image', 'outputs.image.ref']) {
    assert.ok(report.issues.some((i) => i.path === path && i.severity === 'error' && i.message.includes('formats is incompatible')))
  }
})

test('semantic checks reject old envelopes, misplaced or impossible inheritance and invalid values', () => {
  const { tools } = graph()
  assert.deepEqual(validateDocumentQualifiers(tools[0]), [])
  tools[0].neuroflow = '0.1.0'
  assert.ok(validateDocumentQualifiers(tools[0]).some((i) => i.message.includes('require neuroflow 0.1.1')))
  for (const [type, qualifier, value] of [
    ['neuro:transform', 'space', 'MNI152Lin'], ['core:string', 'formats', ['nifti']],
    ['neuro:surface', 'resolution', 1], ['neuro:volume', 'density', '32k'],
    ['neuro:mask', 'labelSystem', 'binary'], ['neuro:volume', 'formats', []],
    ['neuro:volume', 'formats', ['nifti', 'nifti']], ['neuro:volume', 'formats', ['neuro:nifti']],
    ['neuro:volume', 'resolution', 0], ['neuro:volume', 'space', '@7'],
    ['neuro:volume', 'space', 'steps.a.outputs.image'], ['neuro:volume', 'space', 'inputs.image']
  ]) {
    const doc = { kind: 'tool', neuroflow: '0.1.1', inputs: { image: { type, [qualifier]: value } }, outputs: {} }
    assert.ok(validateDocumentQualifiers(doc).length > 0, `must reject ${JSON.stringify(doc)}`)
  }
  for (const input of ['missing', 'name']) {
    assert.ok(validateDocumentQualifiers({ kind: 'tool', neuroflow: '0.1.1', inputs: { name: { type: 'core:string' } }, outputs: { out: { type: 'neuro:volume', space: `inputs.${input}` } } }).length > 0)
  }
})

test('mutable context declarations never prove acquisition identity', () => {
  const workflow = { context: { fields: { image: { type: 'neuro:volume', space: 'individual' } } } }
  assert.equal(resolveQualifiers('context.image', workflow, new Map()).spaceIdentity, undefined)
})

test('versioned references resolve exactly; unrelated invalid registry tools do not block', () => {
  const { workflow, tools } = graph()
  tools[0].version = '1.2.3'
  workflow.steps.a.tool = 'test/pass@1.2.3'
  tools.push({ id: 'test/unrelated', kind: 'tool', neuroflow: '0.1.0', inputs: { x: { type: 'core:string', space: 'individual' } }, outputs: {} })
  assert.deepEqual(validateWorkflowLocally(workflow, tools), { ok: true, issues: [] })
  assert.equal(resolveQualifiers('steps.b.outputs.image', workflow, buildToolMap(tools)).spaceIdentity, 'inputs.t1')
  workflow.steps.a.tool = 'test/pass@1.2.4'
  assert.equal(validateWorkflowLocally(workflow, tools).ok, false)
})

test('unversioned qualifier resolution selects the same registry entry as validation', () => {
  const { workflow, tools } = graph()
  const replacement = structuredClone(tools[0])
  replacement.outputs.image.formats = ['mgz']
  tools.push(replacement)
  assert.deepEqual(resolveQualifiers('steps.b.outputs.image', workflow, buildToolMap(tools)).declaration.formats, ['mgz'])
  assert.equal(validateWorkflowLocally(workflow, tools).ok, false)
})

test('missing registry does not silently drop workflow-output obligations', () => {
  const { workflow } = graph()
  assert.ok(validateWorkflowLocally(workflow).issues.some((i) => i.path === 'outputs.image.ref' && i.message.includes('requires a runtime check')))
})

test('context output mappings enforce declared requirements before consumers', () => {
  const { workflow, tools } = graph()
  workflow.context = { fields: { image: { type: 'neuro:volume', formats: ['nifti'] } } }
  workflow.steps.a.outputMappings = { image: 'image' }
  workflow.steps.b.inputs.image = { ref: 'context.image' }
  const compatible = validateWorkflowLocally(workflow, tools)
  assert.equal(compatible.ok, true)
  assert.ok(!compatible.issues.some((i) => i.path === 'steps.a.outputMappings.image'))

  workflow.inputs.t1.formats = ['mgz']
  assert.ok(validateWorkflowLocally(workflow, tools).issues.some((i) => i.severity === 'error' && i.path === 'steps.a.outputMappings.image' && i.message.includes('formats is incompatible')))

  delete workflow.inputs.t1.formats
  assert.ok(validateWorkflowLocally(workflow, tools).issues.some((i) => i.severity === 'warning' && i.path === 'steps.a.outputMappings.image' && i.message.includes('formats requires a runtime check')))

  workflow.context.fields.image.space = 'individual'
  assert.ok(validateWorkflowLocally(workflow, tools).issues.some((i) => i.path === 'steps.a.outputMappings.image' && i.message.includes('space requires a runtime check')))
})

test('qualified context defaults require inspection rather than filename guesses', () => {
  const { workflow, tools } = graph()
  workflow.context = { fields: { image: { type: 'neuro:volume', formats: ['nifti'], default: 'looks-like-nifti.nii' } } }
  assert.ok(validateWorkflowLocally(workflow, tools).issues.some((i) => i.path === 'context.fields.image.default' && i.message.includes('formats requires a runtime check')))
})
