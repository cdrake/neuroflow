// npm run test:gallery   (node --test "gallery/scripts/*.test.mjs")
// registry_index.mjs: the index a published registry folder needs so a browser can load it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildIndex } from './registry_index.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, 'registry_index.mjs');

function bundle() {
  const root = mkdtempSync(join(tmpdir(), 'registry-index-'));
  const put = (path, value) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), typeof value === 'string' ? value : JSON.stringify(value));
  };
  put('tools/b/run.tool.json', { neuroflow: '0.1.1', kind: 'tool', id: 'nd/b/run' });
  put('tools/a/run.tool.json', { neuroflow: '0.1.1', kind: 'tool', id: 'nd/a/run' });
  put('workflows/w.workflow.json', { neuroflow: '0.1', kind: 'workflow', id: 'nd/w' });
  put('tools/old.tool.json', { neuroflow: '0.0.9', kind: 'tool', id: 'nd/old' });
  put('tools/dup.tool.json', { neuroflow: '0.1.1', kind: 'tool', id: 'nd/a/run' });
  put('scripts/package.json', { name: 'not-a-document' });
  put('node_modules/x/t.tool.json', { neuroflow: '0.1', kind: 'tool', id: 'nd/vendored' });
  put('broken.json', '{');
  return root;
}

test('buildIndex lists 0.1 tools and workflows by sorted relative path', () => {
  const { index, skipped } = buildIndex(bundle(), { title: 'Neurodesk' });
  assert.deepEqual(index, {
    neuroflow: '0.1.1',
    kind: 'neuroflow/registry-index',
    title: 'Neurodesk',
    tools: ['tools/a/run.tool.json', 'tools/b/run.tool.json'],
    workflows: ['workflows/w.workflow.json'],
  });
  assert.equal(skipped.length, 3);
});

test('the CLI writes the index, keeps its title, and --check catches drift', () => {
  const root = bundle();
  const run = (...args) => spawnSync(process.execPath, [script, root, ...args], { encoding: 'utf8' });
  assert.equal(run('--check').status, 1);
  assert.equal(run('--title', 'Neurodesk web apps').status, 0);
  const first = readFileSync(join(root, 'neuroflow-registry.json'), 'utf8');
  assert.equal(JSON.parse(first).title, 'Neurodesk web apps');
  assert.equal(run('--check').status, 0);
  // Re-running without --title keeps it, and the output is byte-identical.
  assert.equal(run().status, 0);
  assert.equal(readFileSync(join(root, 'neuroflow-registry.json'), 'utf8'), first);
  writeFileSync(join(root, 'tools/c.tool.json'), JSON.stringify({ neuroflow: '0.1.1', kind: 'tool', id: 'nd/c' }));
  assert.equal(run('--check').status, 1);
});
