// npm run test:gallery   (node --test "gallery/scripts/*.test.mjs")
// check_tool.mjs: the up-front environment check reports ready / needsSetup (with a fix) /
// interactive / unsupported per tool without starting any program.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const checker = join(here, 'check_tool.mjs');
const root = mkdtempSync(join(tmpdir(), 'check-tool-'));
const toolsDir = join(root, 'tools');
mkdirSync(toolsDir);

const fake = join(root, 'fakecli');
// Prints a banner then exits 3 (as dcm2niix -v does): a matching banner must win over the status.
writeFileSync(fake, `#!${process.execPath}\nconsole.log('fakecli v1.2.3 ready'); process.exit(process.env.FAKECLI_STATUS ? Number(process.env.FAKECLI_STATUS) : 3);\n`);
chmodSync(fake, 0o755);
const python3 = spawnSync('which', ['python3'], { encoding: 'utf8' }).stdout.trim() || null;

let n = 0;
function doc(tool) {
  const path = join(toolsDir, `t${++n}.tool.json`);
  writeFileSync(path, JSON.stringify({ kind: 'tool', version: '0.1.0', inputs: {}, outputs: {}, ...tool }));
  return path;
}
function check(paths, env = {}) {
  const r = spawnSync(process.execPath, [checker, ...paths], { encoding: 'utf8', env: { ...process.env, ...env } });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}
// Scripts are resolved relative to the tool document, so point at the real adapters absolutely.
const launch = (file, extra = {}) => ({ kind: 'script', interpreter: 'node', script: join(here, file), completion: 'exit', interactive: false, ...extra });

test('cli tools: ready with version, not found, and a failed probe each carry the reason', () => {
  const [ok, missing, bad] = check([
    doc({ id: 't/ok', extensions: { 'neuroflow/launch': launch('cli_tool.mjs'), 'neuroflow/cli': { command: 'fakecli', env: 'FAKECLI', probe: { args: ['--version'], match: 'fakecli v', version: 'v[0-9.]+' } } } }),
    doc({ id: 't/missing', extensions: { 'neuroflow/launch': launch('cli_tool.mjs'), 'neuroflow/cli': { command: 'definitely-not-installed-xyz', env: 'NOPE_BIN', paths: ['/nonexistent/bin/x'] } } }),
    doc({ id: 't/bad', extensions: { 'neuroflow/launch': launch('cli_tool.mjs'), 'neuroflow/cli': { command: 'fakecli', env: 'FAKECLI', probe: { args: ['--version'], match: 'needs --magic', advice: 'Upgrade fakecli to 2.0.' } } } }),
  ], { FAKECLI: fake, NOPE_BIN: '', FAKECLI_STATUS: '' });
  assert.equal(ok.status, 'ready');
  assert.equal(ok.adapter, 'cli');
  assert.equal(ok.executable, fake);
  assert.equal(ok.version, 'v1.2.3');
  assert.equal(ok.detail, 'fakecli v1.2.3');
  assert.equal(missing.status, 'needsSetup');
  assert.equal(missing.detail, 'definitely-not-installed-xyz was not found');
  assert.match(missing.fix, /set NOPE_BIN to its path; looked in \/nonexistent\/bin\/x and on PATH/);
  assert.equal(bad.status, 'needsSetup');
  assert.match(bad.detail, /probe exited with status 3/);
  assert.equal(bad.fix, 'Upgrade fakecli to 2.0.');
  const [clean] = check([doc({ id: 't/bad0', extensions: { 'neuroflow/launch': launch('cli_tool.mjs'), 'neuroflow/cli': { command: 'fakecli', env: 'FAKECLI', probe: { args: ['--version'], match: 'needs --magic', advice: 'Upgrade fakecli to 2.0.' } } } })], { FAKECLI: fake, FAKECLI_STATUS: '0' });
  assert.match(clean.detail, /does not look like a usable fakecli: output lacks \/needs --magic\//);
  assert.equal(clean.fix, 'Upgrade fakecli to 2.0.');
});

test('an override variable pointing nowhere is reported, not followed', () => {
  const [r] = check([doc({ id: 't/env', extensions: { 'neuroflow/launch': launch('cli_tool.mjs'), 'neuroflow/cli': { command: 'fakecli', env: 'FAKECLI' } } })], { FAKECLI: '/no/such/fakecli' });
  assert.equal(r.status, 'needsSetup');
  assert.equal(r.detail, 'FAKECLI=/no/such/fakecli does not exist');
});

test('python tools: a missing required package names the fix; optional ones do not', { skip: !python3 && 'no python3' }, () => {
  const [missing, ok] = check([
    doc({ id: 't/py-missing', extensions: { 'neuroflow/launch': launch('python_tool.mjs'), 'neuroflow/python': { interpreter: { env: 'NF_TEST_PY' }, requirements: ['json', { import: 'definitely_not_a_module_xyz', package: 'xyzpkg', advice: 'pip install xyzpkg' }], entry: { kind: 'function', module: 'm', name: 'f' } } } }),
    doc({ id: 't/py-ok', extensions: { 'neuroflow/launch': launch('python_tool.mjs'), 'neuroflow/python': { interpreter: { env: 'NF_TEST_PY', minVersion: '3.0' }, requirements: ['json', { import: 'definitely_not_a_module_xyz', package: 'xyzpkg', optional: true }], entry: { kind: 'function', module: 'm', name: 'f' } } } }),
  ], { NF_TEST_PY: python3 });
  assert.equal(missing.status, 'needsSetup');
  assert.equal(missing.adapter, 'python');
  assert.match(missing.detail, /\(Python 3\.\d+\.\d+\): xyzpkg is missing$/);
  assert.equal(missing.fix, 'pip install xyzpkg');
  assert.equal(missing.executable, python3);
  assert.equal(missing.packages.xyzpkg, null);
  assert.equal(ok.status, 'ready');
  assert.match(ok.detail, /^Python 3\.\d+\.\d+ with json/);
  assert.equal(ok.packages.xyzpkg, null);
});

test('python: an interpreter below minVersion is a setup problem', { skip: !python3 && 'no python3' }, () => {
  const [r] = check([doc({ id: 't/py-old', extensions: { 'neuroflow/launch': launch('python_tool.mjs'), 'neuroflow/python': { interpreter: { env: 'NF_TEST_PY', minVersion: '99.0' }, requirements: [], entry: { kind: 'function', module: 'm', name: 'f' } } } })], { NF_TEST_PY: python3 });
  assert.equal(r.status, 'needsSetup');
  assert.match(r.detail, /needs 99\.0 or newer/);
  assert.equal(r.fix, 'set NF_TEST_PY to a newer interpreter');
});

test('matlab: a chosen engine that is absent explains how to point at one', () => {
  const [r, ok] = check([
    doc({ id: 't/ml', extensions: { 'neuroflow/launch': launch('matlab_tool.mjs'), 'neuroflow/matlab': { engine: 'auto', matlab: { paths: ['/nonexistent/MATLAB_R*/bin/matlab'] }, entry: { kind: 'function', name: 'f' } } } }),
    doc({ id: 't/ml-ok', extensions: { 'neuroflow/launch': launch('matlab_tool.mjs'), 'neuroflow/matlab': { engine: 'octave', entry: { kind: 'function', name: 'f' } } } }),
  ], { NEUROFLOW_MATLAB_ENGINE: '', MATLAB: '', OCTAVE: fake, SPMMCRCMD: '', PATH: '/nonexistent' });
  // t/ml asks for auto with no MATLAB (template paths point nowhere, PATH is empty) but OCTAVE is set: auto finds octave.
  assert.equal(r.status, 'ready');
  assert.equal(r.detail, `octave at ${fake}`);
  assert.equal(ok.status, 'ready');
  const [none] = check([doc({ id: 't/ml-none', extensions: { 'neuroflow/launch': launch('matlab_tool.mjs'), 'neuroflow/matlab': { engine: 'mcr', entry: { kind: 'function', name: 'f' } } } })], { NEUROFLOW_MATLAB_ENGINE: '', SPMMCRCMD: '' });
  assert.equal(none.status, 'needsSetup');
  assert.equal(none.detail, 'no mcr found');
  assert.equal(none.fix, 'set SPMMCRCMD to the mcr executable');
});

test('neurodesk: NEURODESK_WEBAPPS wins; interactive apps and launch-less tools are classified', () => {
  const [nd, ui, none, missingScript] = check([
    doc({ id: 't/nd', extensions: { 'neuroflow/launch': launch('neurodesk_job.mjs'), 'neurodesk/job': { app: 'x' } } }),
    doc({ id: 't/ui', extensions: { 'neuroflow/launch': { kind: 'uiApp', app: 'bidsvue', completion: 'appClosed', interactive: true } } }),
    doc({ id: 't/none', extensions: {} }),
    doc({ id: 't/gone', extensions: { 'neuroflow/launch': { kind: 'script', interpreter: 'node', script: './not_here.mjs', completion: 'exit' } } }),
  ], { NEURODESK_WEBAPPS: fake });
  assert.equal(nd.status, 'ready');
  assert.equal(nd.adapter, 'neurodesk');
  assert.equal(nd.executable, fake);
  assert.equal(ui.status, 'interactive');
  assert.equal(ui.adapter, 'uiApp');
  assert.match(ui.detail, /interactive bidsvue/);
  assert.equal(none.status, 'unsupported');
  assert.equal(missingScript.status, 'needsSetup');
  assert.match(missingScript.detail, /launch script \.\/not_here\.mjs not found/);
});

test('plain node scripts: npm requirements must resolve', () => {
  const [ok, missing] = check([
    doc({ id: 't/node', extensions: { 'neuroflow/launch': launch('fold_provenance.mjs') } }),
    doc({ id: 't/node-missing', extensions: { 'neuroflow/launch': launch('fold_provenance.mjs', { requirements: ['@nope/not-installed-xyz', 'Needs a brain'] }) } }),
  ]);
  assert.equal(ok.status, 'ready');
  assert.equal(ok.detail, `node ${process.version}`);
  assert.equal(missing.status, 'needsSetup');
  assert.equal(missing.detail, '@nope/not-installed-xyz not installed');
  assert.equal(missing.fix, 'run npm install in the repository root');
});

test('--tools-dir walks a directory and the real gallery checks cleanly', () => {
  const r = spawnSync(process.execPath, [checker, '--tools-dir', join(here, '..', 'tools')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const list = JSON.parse(r.stdout);
  assert.ok(list.length >= 13);
  for (const t of list) {
    assert.ok(['ready', 'needsSetup', 'interactive', 'unsupported'].includes(t.status), `${t.id}: ${t.status}`);
    if (t.status === 'needsSetup') assert.ok(t.detail, `${t.id} needs a detail`);
  }
  assert.equal(list.filter((t) => t.status === 'interactive').length, 2);
});
