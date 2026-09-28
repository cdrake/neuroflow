// npm run test:gallery   (node --test "gallery/scripts/*.test.mjs")
// Exercises cli_tool.mjs against a fake command (a node script) through the session contract.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const adapter = join(here, 'cli_tool.mjs');
const root = mkdtempSync(join(tmpdir(), 'cli-tool-'));

// A fake CLI: `fakecli --version` prints a version; otherwise it writes each
// `--out <file>` argument (content: the full argv) and exits with `--exit <n>`.
const fake = join(root, 'fakecli');
writeFileSync(fake, `#!${process.execPath}
const a = process.argv.slice(2);
if (a[0] === '--version') {
  if (process.env.FAKECLI_BLOCKED) { console.error('blocked by inherited environment'); process.exit(9); }
  console.log('fakecli v9.8.7 with -allineate'); process.exit(0);
}
const fs = require('node:fs');
for (let i = 0; i < a.length; i++) if (a[i] === '--out') fs.writeFileSync(a[i + 1], a.join(' '));
const e = a.indexOf('--exit'); process.exit(e >= 0 ? Number(a[e + 1]) : 0);
`);
chmodSync(fake, 0o755);

const baseTool = {
  kind: 'tool', id: 'test/fake', outputs: {
    result: { type: 'core:file', delivery: { mode: 'core:result-dir', path: 'result.txt' } },
    extra: { type: 'core:file', optional: true, delivery: { mode: 'core:result-dir', path: 'extra.txt' } },
  },
};

let n = 0;
function run(cli, inputs, { tool = baseTool } = {}) {
  const session = join(root, `s${++n}`);
  const outputDir = join(session, 'outputs', 'step');
  mkdirSync(outputDir, { recursive: true });
  mkdirSync(join(session, 'work'), { recursive: true });
  const doc = { ...tool, extensions: { 'neuroflow/cli': { command: 'fakecli', paths: [fake], ...cli } } };
  writeFileSync(join(session, 'tool.json'), JSON.stringify(doc));
  writeFileSync(join(session, 'context.json'), JSON.stringify({ tool: 'test/fake', step: 'step', inputs, outputDir, workDir: join(session, 'work') }));
  const r = spawnSync(process.execPath, [adapter], {
    encoding: 'utf8',
    env: { ...process.env, NEUROFLOW_SESSION: session, NEUROFLOW_OUTPUT_DIR: outputDir, NEUROFLOW_STEP: 'step', NEUROFLOW_TOOL_DOC: join(session, 'tool.json') },
  });
  const prov = existsSync(join(session, 'provenance.jsonl')) ? JSON.parse(readFileSync(join(session, 'provenance.jsonl'), 'utf8').trim()) : null;
  return { ...r, outputDir, prov };
}

test('fills placeholders, conditional groups, and records provenance', () => {
  const r = run({
    probe: { args: ['--version'], match: '-allineate', version: 'v[0-9.]+' },
    args: ['{{image}}', '-cost', '{{cost}}', { arg: '--fast', when: { mode: 'fast' } }, { arg: '--slow', when: { mode: 'slow' } },
      { args: ['-weight', '{{weight}}'], whenSet: 'weight' }, '--out', '{{outputDir}}/result.txt'],
    outputs: { result: 'result.txt' },
  }, { image: '/data/a.nii.gz', cost: 'fast', mode: 'fast' });
  assert.equal(r.status, 0, r.stderr);
  const written = readFileSync(join(r.outputDir, 'result.txt'), 'utf8');
  assert.equal(written, `/data/a.nii.gz -cost fast --fast --out ${join(r.outputDir, 'result.txt')}`);
  assert.equal(r.prov.action, 'cli');
  assert.equal(r.prov.agent, 'fakecli v9.8.7');
  assert.equal(r.prov.step, 'step');
  assert.deepEqual(r.prov.outputs, { result: 'result.txt' });
});

test('keeps a whenSet group only when the input has a value', () => {
  const cli = { args: [{ args: ['-weight', '{{weight}}'], whenSet: 'weight' }, '--out', '{{outputDir}}/result.txt'], outputs: { result: 'result.txt' } };
  const r = run(cli, { weight: '/data/w.nii.gz' });
  assert.match(readFileSync(join(r.outputDir, 'result.txt'), 'utf8'), /^-weight \/data\/w\.nii\.gz /);
  const r2 = run(cli, { weight: null });
  assert.match(readFileSync(join(r2.outputDir, 'result.txt'), 'utf8'), /^--out/);
});

test('finds outputs by regex and renames them to the declared delivery path', () => {
  const r = run({
    args: ['--out', '{{outputDir}}/sub_T1w.nii.gz', '--out', '{{outputDir}}/sub_T1w.json'],
    outputs: { result: { match: '\\.nii\\.gz$' }, extra: { match: '\\.json$' } },
  }, {});
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(join(r.outputDir, 'result.txt')));
  assert.ok(existsSync(join(r.outputDir, 'extra.txt')));
  assert.ok(!existsSync(join(r.outputDir, 'sub_T1w.nii.gz')));
  assert.deepEqual(r.prov.outputs, { result: 'result.txt', extra: 'extra.txt' });
});

test('an ambiguous regex fails unless pick is set', () => {
  const args = ['--out', '{{outputDir}}/a.nii.gz', '--out', '{{outputDir}}/b.nii.gz'];
  const bad = run({ args, outputs: { result: { match: '\\.nii\\.gz$' } } }, {});
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /2 files match/);
  const ok = run({ args, outputs: { result: { match: '\\.nii\\.gz$', pick: 'first' } } }, {});
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(readFileSync(join(ok.outputDir, 'result.txt'), 'utf8'), /a\.nii\.gz/);
});

test('fails on a failed probe, a missing input, a non-zero exit, and a missing output', () => {
  const probe = run({ probe: { args: ['--version'], match: 'no-such-op', advice: 'Upgrade it.' }, args: [], outputs: {} }, {});
  assert.equal(probe.status, 1);
  assert.match(probe.stderr, /output lacks \/no-such-op\/. Upgrade it\./);
  const missing = run({ args: ['{{image}}'], outputs: {} }, {});
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /references input image, which has no value/);
  const exit = run({ args: ['--exit', '3'], outputs: {} }, {});
  assert.equal(exit.status, 1);
  assert.match(exit.stderr, /exited with status 3/);
  const none = run({ args: [], outputs: { result: 'result.txt' } }, {});
  assert.equal(none.status, 1);
  assert.match(none.stderr, /did not write output result/);
  assert.equal(none.prov, null);
});

test('clears template-selected variables for both probing and execution', () => {
  const previous = process.env.FAKECLI_BLOCKED;
  process.env.FAKECLI_BLOCKED = '1';
  try {
    const blocked = run({ probe: { args: ['--version'], match: '-allineate' }, args: [], outputs: {} }, {});
    assert.equal(blocked.status, 1);
    assert.match(blocked.stderr, /probe exited with status 9/);
    const clear = run({ clearEnv: ['FAKECLI_BLOCKED'], probe: { args: ['--version'], match: '-allineate' }, args: [], outputs: {} }, {});
    assert.equal(clear.status, 0, clear.stderr);
  } finally {
    if (previous === undefined) delete process.env.FAKECLI_BLOCKED;
    else process.env.FAKECLI_BLOCKED = previous;
  }
});

test('honours the override variable and reports a missing executable', () => {
  const session = join(root, 'env');
  mkdirSync(join(session, 'outputs', 'step'), { recursive: true });
  writeFileSync(join(session, 'tool.json'), JSON.stringify({ ...baseTool, extensions: { 'neuroflow/cli': { command: 'definitely-not-installed-xyz', env: 'FAKECLI', args: [], outputs: {} } } }));
  writeFileSync(join(session, 'context.json'), JSON.stringify({ tool: 'test/fake', step: 'step', inputs: {}, outputDir: join(session, 'outputs', 'step'), workDir: session }));
  const env = { ...process.env, NEUROFLOW_SESSION: session, NEUROFLOW_TOOL_DOC: join(session, 'tool.json') };
  const absent = spawnSync(process.execPath, [adapter], { encoding: 'utf8', env });
  assert.equal(absent.status, 1);
  assert.match(absent.stderr, /was not found \(set FAKECLI to its path\)/);
  const viaEnv = spawnSync(process.execPath, [adapter], { encoding: 'utf8', env: { ...env, FAKECLI: fake } });
  assert.equal(viaEnv.status, 0, viaEnv.stderr);
});
