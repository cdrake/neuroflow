// npm run test:ui   (esbuild bundles tests/ui/*.test.ts, then node --test runs them)
// registrySources.ts: loading registries by URL and folder, and merging them with the gallery.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  loadRegistryFromFiles,
  loadRegistryFromUrl,
  mergeSources,
  parseRegistryIndex,
  parseWorkflowFile,
  registryIndexUrl,
  sourceFromDocuments,
  startupRegistryUrls
} from '../../src/data/registrySources'
import { buildToolRegistry } from '../../src/domain/registry'

const tool = (id: string, extra: Record<string, unknown> = {}) => ({
  neuroflow: '0.1.1',
  kind: 'tool',
  id,
  version: '1.0.0',
  inputs: {},
  outputs: {},
  ...extra
})

const workflow = (id: string) => ({ neuroflow: '0.1', kind: 'workflow', id, version: '1', inputs: {}, steps: {}, outputs: {} })

function site(files: Record<string, unknown>) {
  const requested: string[] = []
  const fetchJson = async (url: string) => {
    requested.push(url)
    if (!(url in files)) throw new Error('404 Not Found')
    return files[url]
  }
  return { fetchJson, requested }
}

test('registryIndexUrl appends the index file to a folder URL and rejects non-http', () => {
  assert.equal(registryIndexUrl('https://ex.org/bundle/'), 'https://ex.org/bundle/neuroflow-registry.json')
  assert.equal(registryIndexUrl('https://ex.org/b/neuroflow-registry.json'), 'https://ex.org/b/neuroflow-registry.json')
  assert.equal(registryIndexUrl('bundle/', 'http://127.0.0.1:4173/app/'), 'http://127.0.0.1:4173/app/bundle/neuroflow-registry.json')
  assert.throws(() => registryIndexUrl('file:///tmp/x.json'), /http\(s\)/)
  assert.throws(() => registryIndexUrl('  '), /enter the URL/)
})

test('loadRegistryFromUrl reads the index then each document relative to it', async () => {
  const { fetchJson, requested } = site({
    'https://ex.org/nd/neuroflow-registry.json': {
      neuroflow: '0.1.1',
      kind: 'neuroflow/registry-index',
      title: 'Neurodesk web apps',
      tools: ['tools/bet/extract.tool.json', 'tools/missing.tool.json'],
      workflows: ['workflows/bet-then-seg.workflow.json']
    },
    'https://ex.org/nd/tools/bet/extract.tool.json': tool('neurodesk.webapps/brain-extraction/extract', {
      extensions: { 'neuroflow/mcp': { title: 'Brain extraction: Extract brain' } }
    }),
    'https://ex.org/nd/workflows/bet-then-seg.workflow.json': workflow('neurodesk.webapps/workflows/bet-then-seg')
  })
  const source = await loadRegistryFromUrl('https://ex.org/nd/', fetchJson)
  assert.equal(source.origin, 'url')
  assert.equal(source.label, 'Neurodesk web apps')
  assert.equal(source.key, 'url:https://ex.org/nd/neuroflow-registry.json')
  assert.deepEqual(source.tools.map((t) => t.name), ['extract'])
  assert.deepEqual(source.workflows.map((w) => w.id), ['neurodesk.webapps/workflows/bet-then-seg'])
  assert.equal(source.warnings.length, 1)
  assert.match(source.warnings[0], /missing\.tool\.json: 404/)
  assert.ok(requested.includes('https://ex.org/nd/tools/bet/extract.tool.json'))

  // Palette label comes from the MCP title when the tool has no niivue/ui block.
  const [entry] = buildToolRegistry(source.tools)
  assert.equal(entry.label, 'Brain extraction: Extract brain')
})

test('loadRegistryFromUrl reports an unreadable or wrong index', async () => {
  await assert.rejects(loadRegistryFromUrl('https://ex.org/none/', site({}).fetchJson), /cannot read .*404/)
  const wrong = site({ 'https://ex.org/w/neuroflow-registry.json': { kind: 'tool' } })
  await assert.rejects(loadRegistryFromUrl('https://ex.org/w/', wrong.fetchJson), /not a NeuroFlow registry index/)
})

test('parseRegistryIndex only accepts relative paths', () => {
  const base = { neuroflow: '0.1.1', kind: 'neuroflow/registry-index' }
  assert.throws(() => parseRegistryIndex({ ...base, tools: ['https://evil.example/t.json'] }), /relative/)
  assert.throws(() => parseRegistryIndex({ ...base, tools: ['/abs/t.json'] }), /relative/)
  assert.throws(() => parseRegistryIndex({ ...base, tools: ['//other.example/t.json'] }), /relative/)
  assert.throws(() => parseRegistryIndex({ ...base, tools: 'tools/a.json' }), /list of relative paths/)
  assert.deepEqual(parseRegistryIndex({ ...base, tools: ['a.json'] }).workflows, [])
})

test('sourceFromDocuments skips unsupported versions, missing ids and duplicates', () => {
  const source = sourceFromDocuments({ origin: 'folder', label: 'f', location: 'f' }, [
    { path: 'a', value: tool('x/a') },
    { path: 'b', value: tool('x/b', { neuroflow: '0.2' }) },
    { path: 'c', value: { kind: 'tool', neuroflow: '0.1' } },
    { path: 'd', value: tool('x/a') },
    { path: 'e', value: { kind: 'other' } },
    { path: 'f', value: [] }
  ])
  assert.deepEqual(source.tools.map((t) => t.id), ['x/a'])
  assert.equal(source.warnings.length, 4)
})

test('loadRegistryFromFiles reads a picked folder and ignores its index', async () => {
  const file = (path: string, value: unknown) => ({
    name: path.split('/').pop() as string,
    webkitRelativePath: path,
    text: async () => (typeof value === 'string' ? value : JSON.stringify(value))
  })
  const source = await loadRegistryFromFiles([
    file('nd/neuroflow-registry.json', { kind: 'neuroflow/registry-index' }),
    file('nd/tools/a.tool.json', tool('nd/a')),
    file('nd/scripts/contract.mjs', 'export {}'),
    file('nd/tools/broken.tool.json', '{')
  ])
  assert.equal(source.label, 'nd')
  assert.deepEqual(source.tools.map((t) => t.id), ['nd/a'])
  assert.match(source.warnings[0], /broken\.tool\.json/)
  await assert.rejects(loadRegistryFromFiles([file('x/readme.txt', '')]), /no \.json/)
})

test('mergeSources keeps the first copy of an id and reports only real conflicts', () => {
  const gallery = sourceFromDocuments({ origin: 'gallery', label: 'gallery', location: 'b' }, [{ path: '1', value: tool('g/a') }])
  const host = sourceFromDocuments({ origin: 'host', label: 'host', location: 'h' }, [
    { path: '1', value: tool('g/a') },
    { path: '2', value: tool('nd/b') }
  ])
  const url = sourceFromDocuments({ origin: 'url', label: 'url', location: 'u' }, [
    { path: '1', value: tool('nd/b', { version: '2.0.0' }) },
    { path: '2', value: workflow('nd/w') }
  ])
  const merged = mergeSources([gallery, host, url])
  assert.deepEqual(merged.tools.map((t) => t.id), ['g/a', 'nd/b'])
  assert.equal(merged.tools[1].version, '1.0.0')
  assert.deepEqual(merged.library.map((w) => w.id), ['nd/w'])
  assert.equal(merged.sourceOf.get('nd/b'), 'host')
  assert.deepEqual(merged.warnings, ["url: nd/b differs from the copy in host; keeping host's"])
})

test('startupRegistryUrls combines the build setting and ?registry= without repeats', () => {
  assert.deepEqual(
    startupRegistryUrls('?registry=https://a/&registry=https://b/&x=1', 'https://c/, https://a/'),
    ['https://c/', 'https://a/', 'https://b/']
  )
  assert.deepEqual(startupRegistryUrls('', undefined), [])
})

test('parseWorkflowFile accepts a 0.1 workflow and explains anything else', () => {
  assert.equal(parseWorkflowFile(JSON.stringify(workflow('a/b')), 'w.json').id, 'a/b')
  assert.throws(() => parseWorkflowFile('{', 'w.json'), /w\.json/)
  assert.throws(() => parseWorkflowFile(JSON.stringify(tool('a/b')), 't.json'), /not a NeuroFlow workflow/)
  assert.throws(() => parseWorkflowFile(JSON.stringify({ ...workflow('a/b'), neuroflow: '1.0' }), 'w.json'), /not supported/)
})
