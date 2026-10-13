// npm run test:ui
// registry.ts getToolProvider: which adapter a script tool runs through, read from its extensions.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ToolDefinition } from '../../src/domain/neuroflow'
import { getToolProvider } from '../../src/domain/registry'

const scriptTool = (extensions: Record<string, unknown> = {}) => ({
  neuroflow: '0.1.1',
  kind: 'tool',
  id: 't/tool',
  extensions: { 'neuroflow/launch': { kind: 'script', command: 'node', script: '../scripts/x.mjs' }, ...extensions }
}) as unknown as ToolDefinition

test('script tools are labelled by their adapter extension', () => {
  const kind = (ext: Record<string, unknown>) => getToolProvider(scriptTool(ext)).kind
  assert.equal(kind({}), 'script')
  assert.equal(kind({ 'neuroflow/cli': {} }), 'cli')
  assert.equal(kind({ 'neuroflow/python': {} }), 'python')
  assert.equal(kind({ 'neuroflow/matlab': {} }), 'matlab')
  assert.equal(kind({ 'neuroflow/app-cli': {} }), 'appCli')
  assert.equal(getToolProvider(scriptTool({ 'neuroflow/app-cli': {} })).label, 'App CLI')
})
