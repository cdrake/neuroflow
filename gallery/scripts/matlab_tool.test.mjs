// npm run test:gallery   (node --test "gallery/scripts/*.test.mjs")
// Exercises matlab_tool.mjs through the session contract: against a fake engine
// (a node script posing as `matlab`) for the adapter's own logic, against GNU
// Octave when installed (function, script, error and SPM-batch entries, the
// last with a stub SPM), and against MATLAB when NEUROFLOW_TEST_MATLAB=1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { globOne } from './adapter_lib.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const adapter = join(here, 'matlab_tool.mjs');
const root = mkdtempSync(join(tmpdir(), 'matlab-tool-'));

// ---- a minimal NIfTI-1 writer (header + zero data), enough for the header reader ----
function writeNifti(path, { dim = [4, 3, 2], pixdim = [1.5, 2, 2.5], sform = null, gz = true } = {}) {
  const h = Buffer.alloc(348);
  h.writeInt32LE(348, 0);
  h.writeInt16LE(dim.length, 40);
  dim.forEach((d, i) => h.writeInt16LE(d, 42 + 2 * i));
  h.writeInt16LE(16, 70); // float32
  h.writeInt16LE(32, 72);
  h.writeFloatLE(1, 76); // qfac
  pixdim.forEach((p, i) => h.writeFloatLE(p, 80 + 4 * i));
  h.writeFloatLE(352, 108);
  h.writeUInt8(10, 123); // mm + s
  h.write('nf test', 148);
  h.writeInt16LE(1, 252); // qform_code
  // identity quaternion, offset -10,-20,-30
  h.writeFloatLE(-10, 268); h.writeFloatLE(-20, 272); h.writeFloatLE(-30, 276);
  const rows = sform ?? [[pixdim[0], 0, 0, -10], [0, pixdim[1], 0, -20], [0, 0, pixdim[2], -30]];
  h.writeInt16LE(sform ? 2 : 1, 254);
  rows.forEach((r, i) => r.forEach((v, j) => h.writeFloatLE(v, 280 + 16 * i + 4 * j)));
  h.write('n+1\0', 344);
  const data = Buffer.alloc(4 * dim.reduce((a, b) => a * b, 1) + 4);
  const bytes = Buffer.concat([h, data]);
  writeFileSync(path, gz ? gzipSync(bytes) : bytes);
  return path;
}
const rasImage = writeNifti(join(root, 'ras.nii.gz'));
const lasImage = writeNifti(join(root, 'las.nii.gz'), { sform: [[-1.5, 0, 0, 10], [0, 2, 0, -20], [0, 0, 2.5, -30]] });
const plainImage = writeNifti(join(root, 'plain.nii'), { gz: false });

// ---- a fake engine: records argv and the wrapper, writes requested outputs ----
const fakeMatlab = join(root, 'matlab');
writeFileSync(fakeMatlab, `#!${process.execPath}
const fs = require('node:fs'); const path = require('node:path');
const a = process.argv.slice(2);
const runArg = a.find((x) => x.startsWith('run('));
const wrapper = a[1] === 'script' ? a[2] : /run\\('(.*)'\\)/.exec(runArg)[1];
const text = fs.readFileSync(wrapper, 'utf8');
if (text.includes('nf_result = ') && !process.env.FAKE_NO_RESULT) fs.writeFileSync(/nf\\.outputFile = '(.*)';/.exec(text)[1], '{"summary":{}}');
const workDir = path.dirname(wrapper);
const outputDir = /nf\\.outputDir = '(.*)';/.exec(text)[1];
fs.writeFileSync(path.join(workDir, 'fake_engine.json'), JSON.stringify({ argv: a, wrapper: text, env: { OMP_NUM_THREADS: process.env.OMP_NUM_THREADS ?? null, BLOCKED: process.env.BLOCKED ?? null } }));
fs.writeFileSync(path.join(workDir, 'nf_info.json'), JSON.stringify({ engine: 'matlab', version: '99.1.0 (R2099a)', spm: process.env.FAKE_SPM || undefined }));
for (const f of (process.env.FAKE_WRITE || '').split(',').filter(Boolean)) fs.writeFileSync(path.join(outputDir, f), f);
process.exit(Number(process.env.FAKE_EXIT ?? 0));
`);
chmodSync(fakeMatlab, 0o755);

const baseTool = {
  kind: 'tool', id: 'test/matlab', inputs: { image: { type: 'neuro:volume' }, label: { type: 'core:string', optional: true } },
  outputs: {
    header: { type: 'core:json', delivery: { mode: 'core:result-dir', path: 'header.json' } },
    extra: { type: 'core:file', optional: true, delivery: { mode: 'core:result-dir', path: 'extra.txt' } },
    summary: { type: 'core:json', delivery: { mode: 'core:result-file' } },
  },
};

let n = 0;
function run(matlab, inputs, { tool = baseTool, env = {}, engine } = {}) {
  const session = join(root, `s${++n}`);
  const outputDir = join(session, 'outputs', 'step');
  const workDir = join(session, 'work');
  mkdirSync(outputDir, { recursive: true });
  mkdirSync(workDir, { recursive: true });
  const doc = { ...tool, extensions: { 'neuroflow/matlab': { matlab: { paths: [fakeMatlab] }, ...matlab } } };
  writeFileSync(join(session, 'tool.json'), JSON.stringify(doc));
  writeFileSync(join(session, 'context.json'), JSON.stringify({ runId: 'run-1', tool: 'test/matlab', step: 'step', inputs, outputDir, workDir }));
  const childEnv = {
    ...process.env, NEUROFLOW_SESSION: session, NEUROFLOW_OUTPUT_DIR: outputDir, NEUROFLOW_STEP: 'step',
    NEUROFLOW_OUTPUT_FILE: join(session, 'result.json'), NEUROFLOW_TOOL_DOC: join(session, 'tool.json'), ...env,
  };
  delete childEnv.NEUROFLOW_MATLAB_ENGINE;
  if (engine) childEnv.NEUROFLOW_MATLAB_ENGINE = engine;
  const r = spawnSync(process.execPath, [adapter], { encoding: 'utf8', env: childEnv });
  const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null);
  const prov = read(join(session, 'provenance.jsonl'));
  const fake = read(join(workDir, 'fake_engine.json'));
  return {
    ...r, session, outputDir, workDir,
    prov: prov ? JSON.parse(prov.trim()) : null,
    fake: fake ? JSON.parse(fake) : null,
    wrapper: read(join(workDir, 'nf_wrapper.m')),
    result: read(join(session, 'result.json')),
  };
}

const octave = spawnSync('which', ['octave-cli'], { encoding: 'utf8' }).stdout.trim() || null;
const matlab = process.env.NEUROFLOW_TEST_MATLAB ? (globOne('/Applications/MATLAB_R*.app/bin/matlab').find(existsSync) ?? process.env.MATLAB ?? null) : null;

// ---------------------------------------------------------------------------
// Fake engine: adapter logic
// ---------------------------------------------------------------------------
test('generates a wrapper with literal inputs, a function call, and headless MATLAB flags', () => {
  const r = run({
    addpath: ['./m'], entry: { kind: 'function', name: 'my_tool', args: ['{{image}}', '{{outputDir}}', 'label={{label}}', 3, true], result: 'summary' },
    outputs: { header: 'header.json' },
  }, { image: rasImage, label: "it's" }, { env: { FAKE_WRITE: 'header.json' } });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.fake.argv.slice(0, 1), ['-batch']);
  assert.ok(r.fake.argv.includes('-singleCompThread'));
  assert.equal(r.fake.env.OMP_NUM_THREADS, '1');
  assert.match(r.wrapper, /nf\.inputs\.image = '.*ras\.nii\.gz';/);
  assert.match(r.wrapper, /nf\.inputs\.label = 'it''s';/);
  assert.match(r.wrapper, /nf\.runId = 'run-1';/);
  assert.match(r.wrapper, new RegExp(`addpath\\('${r.session.replace(/[/.]/g, '\\$&')}/m'\\);`));
  assert.match(r.wrapper, /nf_result = my_tool\(nf\.inputs\.image, nf\.outputDir, 'label=it''s', 3, true\);/);
  assert.match(r.wrapper, /jsonencode\(struct\('summary', \{nf_result\}\)\)/);
  assert.match(r.wrapper, /^exit\(nf_status\);$/m);
  assert.equal(r.prov.action, 'matlab');
  assert.equal(r.prov.engine, 'matlab');
  assert.equal(r.prov.agent, 'MATLAB 99.1.0 (R2099a)');
  assert.deepEqual(r.prov.entry, { kind: 'function', name: 'my_tool' });
  assert.deepEqual(r.prov.outputs, { header: 'header.json' });
});

test('honours singleThread:false and extra engine args', () => {
  const r = run({ singleThread: false, matlab: { paths: [fakeMatlab], args: ['-nojvm'] }, entry: { kind: 'function', name: 'f', args: [] }, outputs: {} }, {});
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!r.fake.argv.includes('-singleCompThread'));
  assert.ok(r.fake.argv.includes('-nojvm'));
  assert.equal(r.fake.env.OMP_NUM_THREADS, null);
});

test('rejects input ids that are not MATLAB identifiers and placeholders without a value', () => {
  const bad = run({ entry: { kind: 'function', name: 'f', args: [] }, outputs: {} }, { 'bad-name': 1 },
    { tool: { ...baseTool, inputs: { 'bad-name': { type: 'core:integer' } } } });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /input id "bad-name" is not a MATLAB identifier/);
  const missing = run({ entry: { kind: 'function', name: 'f', args: ['{{label}}'] }, outputs: {} }, {});
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /references input label, which has no value/);
  const absent = run({ entry: { kind: 'function', name: 'f', args: ['{{image}}'] }, outputs: {} }, { image: join(root, 'nope.nii.gz') });
  assert.equal(absent.status, 1);
  assert.match(absent.stderr, /input image \(neuro:volume\) does not exist/);
});

test('fails on a non-zero engine exit, a missing output, and a missing result file', () => {
  const exit = run({ entry: { kind: 'function', name: 'f', args: [] }, outputs: {} }, {}, { env: { FAKE_EXIT: '1' } });
  assert.equal(exit.status, 1);
  assert.match(exit.stderr, /matlab exited with status 1/);
  assert.equal(exit.prov, null);
  const none = run({ entry: { kind: 'function', name: 'f', args: [] }, outputs: { header: 'header.json' } }, {});
  assert.equal(none.status, 1);
  assert.match(none.stderr, /did not write output header/);
  const noResult = run({ entry: { kind: 'function', name: 'f', args: [], result: 'summary' }, outputs: {} }, {}, { env: { FAKE_NO_RESULT: '1' } });
  assert.equal(noResult.status, 1);
  assert.match(noResult.stderr, /did not write its result/);
});

test('locates toolboxes, records them, and fails on a required one that is missing', () => {
  const spm = join(root, 'spm12'); mkdirSync(spm, { recursive: true });
  const ok = run({
    toolboxes: [{ name: 'spm', env: 'TEST_SPM_HOME', paths: [join(root, 'no-spm')] }],
    entry: { kind: 'function', name: 'f', args: [] }, outputs: {},
  }, {}, { env: { TEST_SPM_HOME: spm, FAKE_SPM: 'SPM12 (7771)' } });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.wrapper, new RegExp(`addpath\\('${spm.replace(/[/.]/g, '\\$&')}'\\); % toolbox spm`));
  assert.deepEqual(ok.prov.toolboxes, { spm: { path: spm, version: 'SPM12 (7771)' } });
  assert.equal(ok.prov.agent, 'MATLAB 99.1.0 (R2099a) + SPM12 (7771)');
  const missing = run({
    toolboxes: [{ name: 'spm', env: 'TEST_SPM_HOME', paths: [join(root, 'no-spm')], advice: 'Install SPM12.' }],
    entry: { kind: 'function', name: 'f', args: [] }, outputs: {},
  }, {}, { env: { TEST_SPM_HOME: '' } });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /toolbox spm was not found \(set TEST_SPM_HOME to its directory\).*Install SPM12\./);
  const optional = run({
    toolboxes: [{ name: 'spm', paths: [join(root, 'no-spm')], required: false }],
    entry: { kind: 'function', name: 'f', args: [] }, outputs: {},
  }, {});
  assert.equal(optional.status, 0, optional.stderr);
  assert.deepEqual(optional.prov.toolboxes, {});
});

test('emits the SPM batch sequence for a batch entry', () => {
  const batch = join(root, 'batch.m'); writeFileSync(batch, 'matlabbatch = {};\n');
  const r = run({ entry: { kind: 'batch', file: batch, inputs: ['{{image}}', '{{outputDir}}'], defaults: 'pet' }, outputs: {} }, { image: rasImage });
  assert.equal(r.status, 0, r.stderr);
  const w = r.wrapper;
  assert.match(w, /run\('.*batch\.m'\);/);
  assert.match(w, /spm\('Defaults', 'pet'\);/);
  assert.match(w, /spm_jobman\('initcfg'\);/);
  assert.match(w, /spm_get_defaults\('cmdline', true\);/);
  assert.match(w, /nf_batch_inputs = \{nf\.inputs\.image, nf\.outputDir\};/);
  assert.match(w, /spm_jobman\('run', matlabbatch, nf_batch_inputs\{:\}\);/);
  assert.equal(r.prov.entry.file, batch);
  const mat = run({ entry: { kind: 'batch', file: join(root, 'no.mat') }, outputs: {} }, {});
  assert.equal(mat.status, 1);
  assert.match(mat.stderr, /entry\.file does not exist/);
});

test('selects the engine from NEUROFLOW_MATLAB_ENGINE and reports when none is found', () => {
  const none = run({ matlab: { paths: [join(root, 'no-matlab')] }, octave: { paths: [join(root, 'no-octave')] }, entry: { kind: 'function', name: 'f', args: [] }, outputs: {} }, {},
    { engine: 'matlab', env: { PATH: '/nonexistent' } });
  assert.equal(none.status, 1);
  assert.match(none.stderr, /no matlab found; set MATLAB to the matlab executable/);
  const mcr = run({ entry: { kind: 'batch', file: join(root, 'batch.m') }, outputs: {} }, {},
    { engine: 'mcr', env: { SPMMCRCMD: fakeMatlab, MCR_ROOT: '/opt/mcr' } });
  assert.equal(mcr.status, 0, mcr.stderr);
  assert.deepEqual(mcr.fake.argv, ['/opt/mcr', 'script', join(mcr.workDir, 'nf_wrapper.m')]);
  assert.equal(mcr.prov.engine, 'mcr');
  assert.match(mcr.prov.agent, /^MATLAB Runtime/);
  const viaEnv = run({ matlab: { paths: [] }, entry: { kind: 'function', name: 'f', args: [] }, outputs: {} }, {}, { env: { MATLAB: fakeMatlab } });
  assert.equal(viaEnv.status, 0, viaEnv.stderr);
  assert.equal(viaEnv.prov.executable, fakeMatlab);
});

test('withholds clearEnv variables from the engine', () => {
  const r = run({ clearEnv: ['BLOCKED'], entry: { kind: 'function', name: 'f', args: [] }, outputs: {} }, {}, { env: { BLOCKED: '1' } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.fake.env.BLOCKED, null);
});

test('globOne returns the newest matching directory first', () => {
  const apps = join(root, 'apps');
  for (const v of ['MATLAB_R2023b.app', 'MATLAB_R2025a.app', 'Other.app']) mkdirSync(join(apps, v, 'bin'), { recursive: true });
  assert.deepEqual(globOne(join(apps, 'MATLAB_R*.app/bin/matlab')), [join(apps, 'MATLAB_R2025a.app/bin/matlab'), join(apps, 'MATLAB_R2023b.app/bin/matlab')]);
  assert.deepEqual(globOne('/no/such/dir/*'), []);
});

// ---------------------------------------------------------------------------
// Real engines
// ---------------------------------------------------------------------------
const headerTool = {
  kind: 'tool', id: 'neuroflow.gallery.tools/nifti-header-matlab', inputs: { image: { type: 'neuro:volume' } },
  outputs: baseTool.outputs,
};
const headerTemplate = {
  addpath: [join(here, 'matlab')],
  entry: { kind: 'function', name: 'nf_nifti_header', args: ['{{image}}', '{{outputDir}}'], result: 'summary' },
  outputs: { header: 'header.json' },
};

function realEngineTests(name, engine, exePath) {
  const opts = (extra = {}) => ({ engine, env: { ...(engine === 'matlab' ? { MATLAB: exePath } : { OCTAVE: exePath }), ...extra } });
  const label = (s) => `${name}: ${s}`;

  test(label('reads a gzipped NIfTI-1 header and returns it inline'), () => {
    const r = run(headerTemplate, { image: rasImage }, { tool: headerTool, ...opts() });
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    const h = JSON.parse(readFileSync(join(r.outputDir, 'header.json'), 'utf8'));
    assert.equal(h.format, 'nifti-1');
    assert.deepEqual(h.dim, [4, 3, 2]);
    assert.deepEqual(h.voxelSize, [1.5, 2, 2.5]);
    assert.equal(h.datatype, 'float32');
    assert.equal(h.spatialUnits, 'mm');
    assert.equal(h.temporalUnits, 's');
    assert.equal(h.descrip, 'nf test');
    assert.equal(h.qformCode, 1);
    assert.equal(h.sformCode, 1);
    assert.deepEqual(h.sform, [[1.5, 0, 0, -10], [0, 2, 0, -20], [0, 0, 2.5, -30], [0, 0, 0, 1]]);
    assert.deepEqual(h.qform, h.sform);
    assert.equal(h.qformSformAgree, true);
    assert.equal(h.orientation, 'RAS');
    assert.equal(h.voxels, 24);
    const inline = JSON.parse(r.result);
    assert.deepEqual(inline.summary.dim, [4, 3, 2]);
    assert.equal(r.prov.action, 'matlab');
    assert.equal(r.prov.engine, engine);
    assert.match(r.prov.agent, engine === 'octave' ? /^GNU Octave \d/ : /^MATLAB \d/);
    assert.deepEqual(r.prov.outputs, { header: 'header.json' });
  });

  test(label('reports disagreeing affines, an LAS orientation, and reads a plain .nii'), () => {
    const r = run(headerTemplate, { image: lasImage }, { tool: headerTool, ...opts() });
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    const h = JSON.parse(readFileSync(join(r.outputDir, 'header.json'), 'utf8'));
    assert.equal(h.sformCode, 2);
    assert.equal(h.qformSformAgree, false);
    assert.equal(h.orientation, 'LAS');
    const p = run(headerTemplate, { image: plainImage }, { tool: headerTool, ...opts() });
    assert.equal(p.status, 0, `${p.stdout}\n${p.stderr}`);
    assert.equal(JSON.parse(readFileSync(join(p.outputDir, 'header.json'), 'utf8')).orientation, 'RAS');
  });

  test(label('an error in the entry fails the step with the message on stderr'), () => {
    const bad = join(root, 'bad.txt'); writeFileSync(bad, 'not a nifti file at all, padded to be long enough..........');
    const r = run(headerTemplate, { image: bad }, { tool: headerTool, ...opts() });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /matlab_tool: .*is not a NIfTI file/);
    assert.match(r.stderr, /exited with status 1/);
    assert.equal(r.prov, null);
  });

  test(label('a script entry sees nf and can write outputs'), () => {
    const script = join(root, 'script_entry.m');
    writeFileSync(script, [
      "fid = fopen(fullfile(nf.outputDir, 'header.json'), 'w');",
      "fprintf(fid, '%s', jsonencode(struct('step', nf.step, 'image', nf.inputs.image, 'n', nf.inputs.n, 'flag', nf.inputs.flag, 'list', {nf.inputs.list})));",
      'fclose(fid);',
    ].join('\n'));
    const tool = { ...headerTool, inputs: { image: { type: 'neuro:volume' }, n: { type: 'core:number' }, flag: { type: 'core:boolean' }, list: { type: 'core:array<core:string>' } } };
    const r = run({ entry: { kind: 'script', file: script }, outputs: { header: 'header.json' } },
      { image: rasImage, n: 2.5, flag: true, list: ['a', 'b-c'] }, { tool, ...opts() });
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    const h = JSON.parse(readFileSync(join(r.outputDir, 'header.json'), 'utf8'));
    assert.deepEqual(h, { step: 'step', image: rasImage, n: 2.5, flag: true, list: ['a', 'b-c'] });
  });

  test(label('a batch entry drives SPM (stubbed) with the initcfg/cmdline/run sequence'), () => {
    const spm = join(root, `stub-spm-${engine}`);
    mkdirSync(spm, { recursive: true });
    const log = join(spm, 'calls.txt').replace(/'/g, "''");
    writeFileSync(join(spm, 'spm.m'), [
      'function varargout = spm(action, varargin)',
      `  fid = fopen('${log}', 'a'); fprintf(fid, 'spm %s\\n', action); fclose(fid);`,
      "  if strcmpi(action, 'Ver'), varargout = {'SPM12', '7771'}; end",
      'end',
    ].join('\n'));
    writeFileSync(join(spm, 'spm_jobman.m'), [
      'function spm_jobman(action, varargin)',
      `  fid = fopen('${log}', 'a');`,
      "  if strcmp(action, 'run')",
      "    fprintf(fid, 'run jobs=%d inputs=%s\\n', numel(varargin{1}), strjoin(cellfun(@(x) num2str(x), varargin(2:end), 'UniformOutput', false), ','));",
      "    out = varargin{1}{1}.out; fid2 = fopen(out, 'w'); fprintf(fid2, 'done'); fclose(fid2);",
      '  else',
      "    fprintf(fid, 'jobman %s\\n', action);",
      '  end',
      '  fclose(fid);',
      'end',
    ].join('\n'));
    writeFileSync(join(spm, 'spm_get_defaults.m'), [
      'function spm_get_defaults(name, value)',
      `  fid = fopen('${log}', 'a'); fprintf(fid, 'defaults %s=%d\\n', name, value); fclose(fid);`,
      'end',
    ].join('\n'));
    const batch = join(root, 'batch_entry.m');
    writeFileSync(batch, "matlabbatch = {struct('out', fullfile(nf.outputDir, 'header.json'))};\n");
    const tool = { ...headerTool, inputs: { image: { type: 'neuro:volume' }, fwhm: { type: 'core:number' } } };
    const r = run({
      toolboxes: [{ name: 'spm', env: 'TEST_SPM_HOME' }],
      entry: { kind: 'batch', file: batch, inputs: ['{{image}}', '{{fwhm}}'] },
      outputs: { header: 'header.json' },
    }, { image: rasImage, fwhm: 6 }, { tool, ...opts({ TEST_SPM_HOME: spm }) });
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    const calls = readFileSync(join(spm, 'calls.txt'), 'utf8').trim().split('\n');
    assert.deepEqual(calls, ['spm Ver', 'spm Defaults', 'jobman initcfg', 'defaults cmdline=1', `run jobs=1 inputs=${rasImage},6`]);
    assert.equal(r.prov.toolboxes.spm.version, 'SPM12 (7771)');
    assert.match(r.prov.agent, /\+ SPM12 \(7771\)$/);
  });
}

if (octave) realEngineTests('octave', 'octave', octave);
else test('octave: skipped (octave-cli not on PATH)', { skip: true }, () => {});
if (matlab) realEngineTests('matlab', 'matlab', matlab);
else test('matlab: skipped (set NEUROFLOW_TEST_MATLAB=1 with a licensed MATLAB installed)', { skip: true }, () => {});
