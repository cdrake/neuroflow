// npm run test:gallery   (node --test "gallery/scripts/*.test.mjs")
// Exercises python_tool.mjs through the session contract: against a fake
// interpreter (a node script posing as `python`) for the adapter's own logic,
// against the real python3 with the `neuroflow` helper, and with NiBabel when
// it is importable there. DIPY-backed tools have their own test file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const here = dirname(fileURLToPath(import.meta.url));
const adapter = join(here, 'python_tool.mjs');
const root = realpathSync(mkdtempSync(join(tmpdir(), 'python-tool-')));

// ---- a minimal NIfTI-1 file (header + zero data) --------------------------------
function writeNifti(path, dim = [4, 3, 2], pixdim = [1.5, 2, 2.5]) {
  const h = Buffer.alloc(348);
  h.writeInt32LE(348, 0);
  h.writeInt16LE(dim.length, 40);
  dim.forEach((d, i) => h.writeInt16LE(d, 42 + 2 * i));
  h.writeInt16LE(16, 70); // float32
  h.writeInt16LE(32, 72);
  h.writeFloatLE(1, 76);
  pixdim.forEach((p, i) => h.writeFloatLE(p, 80 + 4 * i));
  h.writeFloatLE(352, 108);
  h.writeUInt8(10, 123);
  h.writeInt16LE(1, 252);
  h.writeInt16LE(2, 254);
  [[pixdim[0], 0, 0, -10], [0, pixdim[1], 0, -20], [0, 0, pixdim[2], -30]]
    .forEach((r, i) => r.forEach((v, j) => h.writeFloatLE(v, 280 + 16 * i + 4 * j)));
  h.write('n+1\0', 344);
  writeFileSync(path, gzipSync(Buffer.concat([h, Buffer.alloc(4 * dim.reduce((a, b) => a * b, 1) + 4)])));
  return path;
}
const image = writeNifti(join(root, 'img.nii.gz'));

// ---- a fake interpreter: answers the probe from FAKE_* variables, records the run ----
const fakePython = join(root, 'python');
writeFileSync(fakePython, `#!${process.execPath}
const fs = require('node:fs'); const path = require('node:path');
const a = process.argv.slice(2);
if (a[0] === '-c') { // the requirements probe: python -c <code> <json list of {import, package}>
  const spec = Object.fromEntries((process.env.FAKE_MODULES || '').split(',').filter(Boolean).map((s) => s.split('=')));
  const modules = {};
  for (const m of JSON.parse(a[2])) {
    const v = m.import in spec ? spec[m.import] : '9.9.0';
    modules[m.import] = v === '' ? { error: "ModuleNotFoundError: No module named '" + m.import + "'" } : { version: v };
  }
  if (process.env.FAKE_PROBE_EXIT) { console.error('boom'); process.exit(Number(process.env.FAKE_PROBE_EXIT)); }
  console.log(JSON.stringify({ python: (process.env.FAKE_PYVER || '3.99.0').split('.').map(Number), executable: process.argv[1], modules }));
  process.exit(0);
}
const script = a[0];
const keep = ['OMP_NUM_THREADS', 'OPENBLAS_NUM_THREADS', 'MKL_NUM_THREADS', 'NUMEXPR_NUM_THREADS', 'PYTHONPATH',
  'PYTHONDONTWRITEBYTECODE', 'PYTHONUNBUFFERED', 'NEUROFLOW_TOOL_DOC', 'NEUROFLOW_OUTPUT_FILE', 'BLOCKED'];
fs.writeFileSync(path.join(process.cwd(), 'fake_python.json'), JSON.stringify({
  argv: a, cwd: process.cwd(), script: fs.readFileSync(script, 'utf8'),
  env: Object.fromEntries(keep.map((k) => [k, process.env[k] ?? null])),
}));
const text = fs.readFileSync(script, 'utf8');
if (text.includes('s.result(') && !process.env.FAKE_NO_RESULT) fs.writeFileSync(process.env.NEUROFLOW_OUTPUT_FILE, '{"summary":{}}');
for (const f of (process.env.FAKE_WRITE || '').split(',').filter(Boolean)) fs.writeFileSync(path.join(process.env.NEUROFLOW_OUTPUT_DIR, f), f);
process.exit(Number(process.env.FAKE_EXIT || 0));
`);
chmodSync(fakePython, 0o755);

const baseTool = {
  kind: 'tool', id: 'test/python', inputs: { image: { type: 'neuro:volume' }, label: { type: 'core:string', optional: true }, n: { type: 'core:integer', optional: true } },
  outputs: {
    header: { type: 'core:json', delivery: { mode: 'core:result-dir', path: 'header.json' } },
    extra: { type: 'core:file', optional: true, delivery: { mode: 'core:result-dir', path: 'extra.txt' } },
    summary: { type: 'core:json', delivery: { mode: 'core:result-file' } },
  },
};

let n = 0;
function run(pythonTemplate, inputs, { tool = baseTool, env = {}, interpreter = fakePython } = {}) {
  const session = join(root, `s${++n}`);
  const outputDir = join(session, 'outputs', 'step');
  const workDir = join(session, 'work');
  mkdirSync(outputDir, { recursive: true });
  mkdirSync(workDir, { recursive: true });
  const tpl = { ...(interpreter ? { interpreter: { paths: [interpreter] } } : {}), ...pythonTemplate };
  const doc = { ...tool, extensions: { 'neuroflow/python': tpl } };
  writeFileSync(join(session, 'tool.json'), JSON.stringify(doc));
  writeFileSync(join(session, 'context.json'), JSON.stringify({ runId: 'run-1', tool: tool.id, step: 'step', inputs, outputDir, workDir }));
  const childEnv = {
    ...process.env, NEUROFLOW_SESSION: session, NEUROFLOW_OUTPUT_DIR: outputDir, NEUROFLOW_STEP: 'step',
    NEUROFLOW_OUTPUT_FILE: join(session, 'result.json'), NEUROFLOW_TOOL_DOC: join(session, 'tool.json'),
  };
  for (const k of ['NEUROFLOW_PYTHON', 'NEUROFLOW_INTERPRETER_PYTHON3', 'PYTHONPATH', 'OMP_NUM_THREADS']) delete childEnv[k];
  Object.assign(childEnv, env);
  const r = spawnSync(process.execPath, [adapter], { encoding: 'utf8', env: childEnv });
  const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null);
  const prov = read(join(session, 'provenance.jsonl'));
  const fake = read(join(workDir, 'fake_python.json'));
  return {
    ...r, session, outputDir, workDir,
    prov: prov ? prov.trim().split('\n').map((l) => JSON.parse(l)) : null,
    fake: fake ? JSON.parse(fake) : null,
    driver: read(join(workDir, 'nf_driver.py')),
    result: read(join(session, 'result.json')),
  };
}
const fn = (extra = {}) => ({ entry: { kind: 'function', module: 'my_tool', name: 'run', args: [], ...extra } });

// ---------------------------------------------------------------------------
// Fake interpreter: adapter logic
// ---------------------------------------------------------------------------
test('generates a driver with typed arguments, runs it with the helper on PYTHONPATH, records provenance', () => {
  const r = run({
    pythonpath: ['./py'], requirements: ['nibabel', { import: 'scipy.ndimage', package: 'scipy', optional: true }],
    ...fn({ args: ['{{image}}', '{{outputDir}}', 'label={{label}}', '{{n}}', 3.5, true, null, { k: [1, 'two'] }], result: 'summary' }),
    outputs: { header: 'header.json' },
  }, { image, label: 'it"s', n: 7 }, { env: { FAKE_WRITE: 'header.json', FAKE_MODULES: 'nibabel=5.4.0,scipy.ndimage=1.15.3' } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.driver, /^from neuroflow import session$/m);
  assert.match(r.driver, /nf_module = importlib\.import_module\("my_tool"\)/);
  assert.match(r.driver, /nf_result = nf_module\.run\(s\.inputs\["image"\], s\.output_dir, "label=it\\"s", s\.inputs\["n"\], 3\.5, True, None, \{"k": \[1, "two"\]\}\)/);
  assert.match(r.driver, /s\.result\(\{"summary": nf_result\}\)/);
  assert.deepEqual(r.fake.argv, [join(r.workDir, 'nf_driver.py')]);
  assert.equal(r.fake.cwd, r.workDir);
  const pp = r.fake.env.PYTHONPATH.split(':');
  assert.equal(pp[0], join(r.session, 'py'));
  assert.ok(pp.includes(r.session), 'tool dir on PYTHONPATH');
  assert.ok(pp.includes(join(here, 'python')), 'helper dir on PYTHONPATH');
  assert.equal(r.fake.env.OMP_NUM_THREADS, '1');
  assert.equal(r.fake.env.OPENBLAS_NUM_THREADS, '1');
  assert.equal(r.fake.env.PYTHONDONTWRITEBYTECODE, '1');
  assert.equal(r.fake.env.PYTHONUNBUFFERED, '1');
  assert.equal(r.fake.env.NEUROFLOW_TOOL_DOC, join(r.session, 'tool.json'));
  assert.equal(r.result, '{"summary":{}}');
  const p = r.prov[0];
  assert.equal(p.action, 'python');
  assert.equal(p.agent, 'Python 3.99.0 + nibabel 5.4.0 + scipy 1.15.3');
  assert.equal(p.python, '3.99.0');
  assert.deepEqual(p.packages, { nibabel: '5.4.0', scipy: '1.15.3' });
  assert.deepEqual(p.entry, { kind: 'function', module: 'my_tool', name: 'run' });
  assert.deepEqual(p.outputs, { header: 'header.json' });
  assert.equal(p.executable, fakePython);
});

test('fails before launch when a required package is missing or too old, with the fix', () => {
  const missing = run({ requirements: ['nibabel', { import: 'dipy', package: 'dipy', advice: 'pip install dipy' }], ...fn() }, {},
    { env: { FAKE_MODULES: 'dipy=', FAKE_PYVER: '3.12.12' } });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /python_tool: .*python \(Python 3\.12\.12\) lacks dipy, required by test\/python \(ModuleNotFoundError: No module named 'dipy'\)\. To fix: pip install dipy/);
  assert.equal(missing.fake, null, 'nothing ran');
  assert.equal(missing.prov, null);
  const old = run({ requirements: [{ import: 'dipy', minVersion: '1.9' }], ...fn() }, {}, { env: { FAKE_MODULES: 'dipy=1.5.0' } });
  assert.equal(old.status, 1);
  assert.match(old.stderr, /has dipy 1\.5\.0 but test\/python needs 1\.9 or newer\. To fix: pip install dipy into that environment, or point NEUROFLOW_PYTHON at an environment that has it/);
  const both = run({ requirements: ['a', 'b'], ...fn() }, {}, { env: { FAKE_MODULES: 'a=,b=' } });
  assert.match(both.stderr, /lacks a, .*; lacks b, /, 'every problem in one message');
  const optional = run({ requirements: [{ import: 'scipy', optional: true }], ...fn() }, {}, { env: { FAKE_MODULES: 'scipy=' } });
  assert.equal(optional.status, 0, optional.stderr);
  assert.deepEqual(optional.prov[0].packages, { scipy: null });
  assert.equal(optional.prov[0].agent, 'Python 3.99.0');
});

test('enforces interpreter.minVersion and reports a broken probe', () => {
  const old = run({ interpreter: { paths: [fakePython], minVersion: '3.10' }, ...fn() }, {}, { env: { FAKE_PYVER: '3.9.1' } });
  assert.equal(old.status, 1);
  assert.match(old.stderr, /is Python 3\.9\.1, but test\/python needs 3\.10 or newer\. To fix: set NEUROFLOW_PYTHON/);
  const ok = run({ interpreter: { paths: [fakePython], minVersion: '3.10' }, ...fn() }, {}, { env: { FAKE_PYVER: '3.10.0' } });
  assert.equal(ok.status, 0, ok.stderr);
  const broken = run(fn(), {}, { env: { FAKE_PROBE_EXIT: '2' } });
  assert.equal(broken.status, 1);
  assert.match(broken.stderr, /failed the environment probe \(status 2\): boom/);
});

test('resolves the interpreter: NEUROFLOW_PYTHON, then template paths with {{toolDir}}, then the runner export', () => {
  const viaEnv = run({ interpreter: { paths: [join(root, 'nope')] }, ...fn() }, {}, { env: { NEUROFLOW_PYTHON: fakePython } });
  assert.equal(viaEnv.status, 0, viaEnv.stderr);
  assert.equal(viaEnv.prov[0].executable, fakePython);
  const badEnv = run(fn(), {}, { env: { NEUROFLOW_PYTHON: join(root, 'nope') } });
  assert.equal(badEnv.status, 1);
  assert.match(badEnv.stderr, /NEUROFLOW_PYTHON=.*nope does not exist/);
  const custom = run({ interpreter: { env: 'MY_PY', paths: [] }, ...fn() }, {}, { env: { MY_PY: fakePython } });
  assert.equal(custom.status, 0, custom.stderr);
  // {{toolDir}} is the directory of the tool document (the session dir in this harness)
  const venv = run({ interpreter: { paths: ['{{toolDir}}/.venv/bin/python'] }, ...fn() }, {}, { interpreter: null, env: { PATH: '/nonexistent' } });
  assert.equal(venv.status, 1);
  assert.match(venv.stderr, new RegExp(`no Python interpreter found; set NEUROFLOW_PYTHON .*looked in ${venv.session.replace(/[/.]/g, '\\$&')}/\\.venv/bin/python`));
  const runner = run({ interpreter: { paths: [] }, ...fn() }, {}, { interpreter: null, env: { PATH: '/nonexistent', NEUROFLOW_INTERPRETER_PYTHON3: fakePython } });
  assert.equal(runner.status, 0, runner.stderr);
  assert.equal(runner.prov[0].executable, fakePython);
});

test('honours singleThread:false and clearEnv', () => {
  const r = run({ singleThread: false, clearEnv: ['BLOCKED'], ...fn() }, {}, { env: { BLOCKED: 'yes' } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.fake.env.OMP_NUM_THREADS, null);
  assert.equal(r.fake.env.MKL_NUM_THREADS, null);
  assert.equal(r.fake.env.BLOCKED, null);
});

test('rejects bad entries, placeholders without a value, and missing inputs', () => {
  const missing = run(fn({ args: ['{{label}}'] }), {});
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /references input label, which has no value/);
  const absent = run(fn({ args: ['{{image}}'] }), { image: join(root, 'nope.nii.gz') });
  assert.equal(absent.status, 1);
  assert.match(absent.stderr, /input image \(neuro:volume\) does not exist/);
  const badModule = run(fn({ module: 'my-tool' }), {});
  assert.match(badModule.stderr, /entry\.module must be a Python module name/);
  const badResult = run(fn({ result: 'nothing' }), {});
  assert.match(badResult.stderr, /entry\.result names output nothing, which the tool does not declare/);
  const noFile = run({ entry: { kind: 'script', file: './missing.py' } }, {});
  assert.match(noFile.stderr, /entry\.file does not exist/);
  const unknown = run({ entry: { kind: 'notebook' } }, {});
  assert.match(unknown.stderr, /unknown entry\.kind "notebook"/);
});

test('fails on a non-zero exit, a missing output, and a missing result file', () => {
  const exit = run(fn(), {}, { env: { FAKE_EXIT: '3' } });
  assert.equal(exit.status, 1);
  assert.match(exit.stderr, /python exited with status 3/);
  assert.equal(exit.prov, null);
  const none = run({ ...fn(), outputs: { header: 'header.json' } }, {});
  assert.equal(none.status, 1);
  assert.match(none.stderr, /the Python entry did not write output header/);
  const noResult = run(fn({ result: 'summary' }), {}, { env: { FAKE_NO_RESULT: '1' } });
  assert.equal(noResult.status, 1);
  assert.match(noResult.stderr, /did not write its result/);
});

test('runs a script entry relative to the tool document and renames matched outputs', () => {
  const session = join(root, `s${n + 1}`);
  mkdirSync(session, { recursive: true });
  writeFileSync(join(session, 'tool_script.py'), 'print("hi")\n');
  const r = run({ entry: { kind: 'script', file: './tool_script.py' }, outputs: { header: { match: '^hdr.*\\.json$' } } }, {},
    { env: { FAKE_WRITE: 'hdr_1.json' } });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.fake.argv, [join(r.session, 'tool_script.py')]);
  assert.ok(existsSync(join(r.outputDir, 'header.json')));
  assert.deepEqual(r.prov[0].entry, { kind: 'script', file: join(r.session, 'tool_script.py') });
});

// ---------------------------------------------------------------------------
// Real python3: the helper module, then NiBabel when importable
// ---------------------------------------------------------------------------
const python3 = spawnSync('which', ['python3'], { encoding: 'utf8' }).stdout.trim() || null;
const hasNibabel = python3 && spawnSync(python3, ['-c', 'import nibabel'], { encoding: 'utf8' }).status === 0;

test('real python: the helper types inputs, writes results, logs and appends provenance', { skip: !python3 && 'python3 not on PATH' }, () => {
  const mod = join(root, 'realmod');
  mkdirSync(mod, { recursive: true });
  writeFileSync(join(mod, 'nf_echo.py'), `
from pathlib import Path
from neuroflow import session

def run(image, out_dir, label, n):
    s = session()
    assert isinstance(image, Path) and image == s.inputs["image"], (image, s.inputs)
    assert isinstance(out_dir, Path) and out_dir == s.output_dir
    assert isinstance(s.inputs["label"], str) and s.inputs["n"] == 7
    s.output_path("header").write_text('{"ok": true}')
    s.log("echoed", n, "inputs")
    s.provenance(action="echo", label=label)
    return {"label": label, "n": n, "image": image.name, "step": s.step, "run": s.run_id}
`);
  const r = run({ pythonpath: [mod], requirements: ['json'], ...fn({ module: 'nf_echo', args: ['{{image}}', '{{outputDir}}', 'tag={{label}}', '{{n}}'], result: 'summary' }), outputs: { header: 'header.json' } },
    { image, label: 'x', n: 7 }, { interpreter: python3 });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /^python: echoed 7 inputs$/m);
  assert.deepEqual(JSON.parse(r.result), { summary: { label: 'tag=x', n: 7, image: 'img.nii.gz', step: 'step', run: 'run-1' } });
  assert.equal(r.prov.length, 2);
  assert.equal(r.prov[0].action, 'echo');
  assert.equal(r.prov[0].label, 'tag=x');
  assert.equal(r.prov[0].tool, 'test/python');
  assert.equal(r.prov[1].action, 'python');
  assert.match(r.prov[1].agent, /^Python 3\.\d+\.\d+ \+ json /);
  assert.equal(r.prov[1].executable, python3);
});

test('real python: a missing module is reported with the real interpreter and version', { skip: !python3 && 'python3 not on PATH' }, () => {
  const r = run({ requirements: [{ import: 'nf_no_such_module_xyz', package: 'nf-no-such', advice: 'pip install nf-no-such' }], ...fn() }, {}, { interpreter: python3 });
  assert.equal(r.status, 1);
  assert.match(r.stderr, new RegExp(`${python3.replace(/[/.]/g, '\\$&')} \\(Python 3\\.\\d+\\.\\d+\\) lacks nf-no-such, required by test/python \\(ModuleNotFoundError: No module named 'nf_no_such_module_xyz'\\)\\. To fix: pip install nf-no-such`));
});

test('real python: a traceback in the entry fails the step and leaves the driver to inspect', { skip: !python3 && 'python3 not on PATH' }, () => {
  const mod = join(root, 'badmod');
  mkdirSync(mod, { recursive: true });
  writeFileSync(join(mod, 'nf_bad.py'), 'def run():\n    raise ValueError("nope")\n');
  const r = run({ pythonpath: [mod], ...fn({ module: 'nf_bad' }) }, {}, { interpreter: python3 });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /ValueError: nope/);
  assert.match(r.stderr, /python exited with status 1/);
  assert.ok(existsSync(join(r.workDir, 'nf_driver.py')));
});

test('real python + nibabel: reads a header through the adapter', { skip: !hasNibabel && 'nibabel not importable by python3' }, () => {
  const mod = join(root, 'nibmod');
  mkdirSync(mod, { recursive: true });
  writeFileSync(join(mod, 'nf_header.py'), `
import json
import nibabel as nib

def run(image, out_dir):
    img = nib.load(str(image))
    rec = {"shape": list(img.shape), "zooms": [float(z) for z in img.header.get_zooms()], "orientation": "".join(nib.aff2axcodes(img.affine))}
    (out_dir / "header.json").write_text(json.dumps(rec))
    return rec
`);
  const r = run({ pythonpath: [mod], requirements: ['nibabel', { import: 'numpy', minVersion: '1.20' }], ...fn({ module: 'nf_header', args: ['{{image}}', '{{outputDir}}'], result: 'summary' }), outputs: { header: 'header.json' } },
    { image }, { interpreter: python3 });
  assert.equal(r.status, 0, r.stderr);
  const summary = JSON.parse(r.result).summary;
  assert.deepEqual(summary.shape, [4, 3, 2]);
  assert.deepEqual(summary.zooms, [1.5, 2, 2.5]);
  assert.equal(summary.orientation, 'RAS');
  assert.deepEqual(JSON.parse(readFileSync(join(r.outputDir, 'header.json'), 'utf8')), summary);
  assert.match(r.prov[0].agent, /^Python 3\.\d+\.\d+ \+ nibabel \d+\.\d+\.\d+ \+ numpy \d+\.\d+/);
});
