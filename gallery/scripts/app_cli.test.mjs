// npm run test:gallery   (node --test "gallery/scripts/*.test.mjs")
// Exercises app_cli.mjs against a fake app checkout and a fake runner through the session contract.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const adapter = join(here, 'app_cli.mjs');
const root = realpathSync(mkdtempSync(join(tmpdir(), 'app-cli-')));

// The app checkout, with its headless entry point.
const checkout = join(root, 'fakeapp');
mkdirSync(join(checkout, 'scripts'), { recursive: true });
writeFileSync(join(checkout, 'scripts', 'ingest.ts'), '// entry\n');

// A fake runner: records its cwd and argv, writes <outputDir>/bids unless told not to.
const runner = join(root, 'fakebun');
writeFileSync(runner, `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
if (process.argv.includes('--check')) {
  const ready = !process.env.FAKE_NOT_READY;
  console.log(JSON.stringify({ ready, version: 'v1.2.3', problems: ready ? [] : ['dcm2niix not found'] }));
  process.exit(ready ? 0 : 1);
}
const out = process.env.NEUROFLOW_OUTPUT_DIR;
fs.writeFileSync(path.join(out, 'call.json'), JSON.stringify({ cwd: process.cwd(), argv: process.argv.slice(2) }));
if (!process.env.FAKE_SKIP_OUTPUT) {
  fs.mkdirSync(path.join(out, 'bids'), { recursive: true });
  fs.writeFileSync(path.join(out, 'bids', 'dataset_description.json'), '{}');
}
process.exit(Number(process.env.FAKE_EXIT ?? 0));
`);
chmodSync(runner, 0o755);

const template = {
  app: 'fake-app', repo: 'fakeapp', entry: 'scripts/ingest.ts', command: 'fakebun', paths: [runner],
  args: ['run', 'scripts/ingest.ts', '--neuroflow-session', '{{session}}', '--out', '{{outputDir}}'],
};
const tool = {
  kind: 'tool', id: 'test/app', inputs: {},
  outputs: { bids_dir: { type: 'neuro:bids-dataset', delivery: { mode: 'core:result-dir', path: 'bids' } } },
};

let n = 0;
// docDir: where the tool document lives (the session by default); the sibling
// lookup starts from there.
function run({ env = {}, cli = {}, docDir } = {}) {
  const session = join(root, `s${++n}`);
  const outputDir = join(session, 'outputs', 'step');
  mkdirSync(outputDir, { recursive: true });
  const docPath = join(docDir ?? session, `tool${n}.json`);
  mkdirSync(dirname(docPath), { recursive: true });
  writeFileSync(docPath, JSON.stringify({ ...tool, extensions: { 'neuroflow/app-cli': { ...template, ...cli } } }));
  writeFileSync(join(session, 'context.json'), JSON.stringify({ tool: 'test/app', step: 'step', inputs: {}, outputDir, workDir: session }));
  const r = spawnSync(process.execPath, [adapter], {
    encoding: 'utf8',
    env: {
      ...process.env, NEUROFLOW_SESSION: session, NEUROFLOW_OUTPUT_DIR: outputDir, NEUROFLOW_STEP: 'step',
      NEUROFLOW_TOOL_DOC: docPath, NEUROFLOW_UI_APP_FAKE_APP: checkout, ...env,
    },
  });
  const callPath = join(outputDir, 'call.json');
  return { ...r, session, outputDir, call: existsSync(callPath) ? JSON.parse(readFileSync(callPath, 'utf8')) : null };
}

test('runs the entry point in the checkout with the session filled in', () => {
  const r = run();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(realpathSync(r.call.cwd), checkout);
  assert.deepEqual(r.call.argv, ['run', 'scripts/ingest.ts', '--neuroflow-session', r.session, '--out', r.outputDir]);
  assert.ok(existsSync(join(r.outputDir, 'bids', 'dataset_description.json')));
});

test('a failing app fails the step with its exit code', () => {
  const r = run({ env: { FAKE_EXIT: '1' } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /app_cli: fake-app exited with code 1/);
});

test('a declared output the app did not write fails the step', () => {
  const r = run({ env: { FAKE_SKIP_OUTPUT: '1' } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /finished without writing bids_dir \(bids\)/);
});

test('a missing checkout or entry point is reported before anything runs', () => {
  const gone = run({ env: { NEUROFLOW_UI_APP_FAKE_APP: join(root, 'nowhere') } });
  assert.equal(gone.status, 1);
  assert.match(gone.stderr, /fake-app checkout not found .*set NEUROFLOW_UI_APP_FAKE_APP/);
  assert.equal(gone.call, null);

  const old = run({ cli: { entry: 'scripts/missing.ts', branch: 'feature' } });
  assert.equal(old.status, 1);
  assert.match(old.stderr, /has no scripts\/missing\.ts; check out feature there/);
  assert.equal(old.call, null);
});

test('without an override the checkout is the sibling that holds the entry point', () => {
  // <root>/nf/gallery/tools/x.json: the walk looks at <root>/nf/fakeapp first,
  // which has no entry point (like BIDSvue's $TMPDIR/bidsui cache), then <root>/fakeapp.
  mkdirSync(join(root, 'nf', 'fakeapp'), { recursive: true });
  const docDir = join(root, 'nf', 'gallery', 'tools');
  const r = run({ docDir, env: { NEUROFLOW_UI_APP_FAKE_APP: '' } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(realpathSync(r.call.cwd), checkout);

  // An override that is not a directory falls through to the sibling, as in the runtime.
  const bad = run({ docDir, env: { NEUROFLOW_UI_APP_FAKE_APP: join(root, 'nowhere') } });
  assert.equal(bad.status, 0, bad.stderr);
  assert.equal(realpathSync(bad.call.cwd), checkout);
});

test('a missing runner is reported before anything runs', () => {
  const r = run({ cli: { paths: [join(root, 'no-such-bun')], command: 'no-such-bun-on-path' } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no-such-bun-on-path was not found/);
  assert.equal(r.call, null);
});

test("the app's probe gates the run and its problems are reported", () => {
  const probe = { args: ['--check'], match: '"ready":\\s*true', version: 'v\\d+\\.\\d+\\.\\d+', advice: 'install the deps' };
  const ok = run({ cli: { probe } });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /fake-app ready \(v1\.2\.3\)/);

  const not = run({ cli: { probe }, env: { FAKE_NOT_READY: '1' } });
  assert.equal(not.status, 1);
  assert.match(not.stderr, /fake-app at .* is not ready: dcm2niix not found; install the deps/);
  assert.equal(not.call, null);
});
