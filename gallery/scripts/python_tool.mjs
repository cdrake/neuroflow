#!/usr/bin/env node
/**
 * NeuroFlow adapter for Python tools (NiBabel, DIPY, NumPy/SciPy, ...).
 *
 * A tool document describes the Python-side entry under
 * `extensions["neuroflow/python"]`; this script finds an interpreter, checks
 * every declared requirement before running anything, runs the entry with the
 * `neuroflow` helper module importable, and maps the files it wrote to the
 * tool's declared outputs. Anything that needs a user to act (install a
 * package, point at another environment) is reported up front in one message,
 * never discovered as a traceback three steps into a workflow.
 *
 * Template fields:
 *   interpreter      { env, paths[], minVersion }
 *                    where to find Python: the override variable (default
 *                    NEUROFLOW_PYTHON), then `paths` ({{toolDir}} and ~ expand,
 *                    one `*` glob per path, newest first), then the interpreter
 *                    the runner exported (NEUROFLOW_INTERPRETER_PYTHON3), then
 *                    python3 and python on PATH. An interpreter below
 *                    `minVersion` fails with its path and version.
 *   requirements[]   "nibabel" or { import, package, minVersion, advice, optional }.
 *                    One probe imports every module and reports versions before
 *                    the entry runs; a missing or too-old required module fails
 *                    the step with `advice`, an optional one is only recorded.
 *                    A plain string means { import: s, package: s }.
 *   pythonpath[]     directories put on PYTHONPATH, relative to the tool
 *                    document (~ expands); the tool's own directory and the
 *                    gallery's scripts/python (the `neuroflow` helper) are
 *                    always included.
 *   singleThread     true (default) sets OMP/OPENBLAS/MKL/NUMEXPR_NUM_THREADS=1
 *   entry            what to run, one of
 *                      { kind: "function", module, name, args[], result? }
 *                          imports `module` and calls `name(args...)` from a
 *                          generated driver (nf_driver.py in the work dir);
 *                          args are literals or {{input}}, {{outputDir}},
 *                          {{workDir}}, {{outputFile}} placeholders (an exact
 *                          {{name}} passes the input with its JSON type, paths
 *                          as pathlib.Path; an unset input passes its declared
 *                          default, or None when optional; a placeholder inside
 *                          text yields a str). `result`
 *                          names a core:result-file output that
 *                          receives the return value as JSON.
 *                      { kind: "script", file }
 *                          runs the file with the helper importable
 *   outputs{}        name -> file written in the output dir, or { match, pick }
 *                    (as in neuroflow/cli); renamed to the declared delivery.path
 *   clearEnv[]       environment-variable names withheld from Python
 *
 * Python also sees PYTHONDONTWRITEBYTECODE=1, PYTHONUNBUFFERED=1 and
 * NEUROFLOW_TOOL_DOC (so the helper can type the inputs), and runs with the
 * work dir as cwd.
 *
 * Env: NEUROFLOW_SESSION / _OUTPUT_DIR / _OUTPUT_FILE / _WORK_DIR / _STEP
 * (session contract), NEUROFLOW_PYTHON, NEUROFLOW_INTERPRETER_PYTHON3.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  appendProvenance, checkInputsExist, expand, failer, findExecutable, findToolDoc, hasValue, mapOutputs, readSession,
} from './adapter_lib.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fail = failer('python_tool');

const { session, ctx, inputs, step, outputDir, workDir } = readSession(fail);
const outputFile = process.env.NEUROFLOW_OUTPUT_FILE || join(outputDir, 'result.json');

const found = findToolDoc(ctx.tool, here);
if (!found) fail(`tool document ${ctx.tool} not found next to ${here}`);
const { doc: tool, path: toolPath } = found;
const template = tool.extensions?.['neuroflow/python'];
if (!template) fail(`${ctx.tool} has no extensions["neuroflow/python"] template`);
const entry = template.entry;
if (!entry?.kind) fail('neuroflow/python.entry.kind is required (function | script)');
const toolDir = dirname(resolve(toolPath));
const relToTool = (p) => {
  const e = expand(p.replaceAll('{{toolDir}}', toolDir));
  return isAbsolute(e) ? e : resolve(toolDir, e);
};

checkInputsExist(tool, inputs, fail);

// ---- interpreter --------------------------------------------------------------------
const interp = template.interpreter ?? {};
const envVar = interp.env ?? 'NEUROFLOW_PYTHON';
const candidatePaths = (interp.paths ?? []).map(relToTool);
let python = findExecutable({ env: envVar, paths: candidatePaths }, fail);
if (!python && process.env.NEUROFLOW_INTERPRETER_PYTHON3) {
  python = expand(process.env.NEUROFLOW_INTERPRETER_PYTHON3);
  if (!existsSync(python)) fail(`NEUROFLOW_INTERPRETER_PYTHON3=${python} does not exist`);
}
if (!python) python = findExecutable({ command: 'python3' }, fail) ?? findExecutable({ command: 'python' }, fail);
if (!python) {
  fail(`no Python interpreter found; set ${envVar} to one or install python3 on PATH; ` +
    `looked in ${candidatePaths.join(', ') || 'no fixed locations'} and on PATH`);
}

// ---- environment --------------------------------------------------------------------
const childEnv = { ...process.env };
for (const name of template.clearEnv ?? []) delete childEnv[name];
const singleThread = template.singleThread !== false;
if (singleThread) {
  for (const v of ['OMP_NUM_THREADS', 'OPENBLAS_NUM_THREADS', 'MKL_NUM_THREADS', 'NUMEXPR_NUM_THREADS']) childEnv[v] = '1';
}
childEnv.PYTHONDONTWRITEBYTECODE = '1';
childEnv.PYTHONUNBUFFERED = '1';
childEnv.NEUROFLOW_TOOL_DOC = resolve(toolPath);
childEnv.NEUROFLOW_OUTPUT_FILE = outputFile;
const pythonPath = [
  ...(template.pythonpath ?? []).map(relToTool),
  toolDir,
  join(here, 'python'),
  ...(process.env.PYTHONPATH ?? '').split(delimiter).filter(Boolean),
];
childEnv.PYTHONPATH = [...new Set(pythonPath)].join(delimiter);

// ---- requirements probe -------------------------------------------------------------
// One interpreter start imports every declared module and reports the Python and
// package versions as JSON, so a missing package is caught before any code runs.
const requirements = (template.requirements ?? []).map((r) => {
  const spec = typeof r === 'string' ? { import: r, package: r } : { ...r };
  if (!spec.import) fail('every neuroflow/python.requirements entry needs an import name');
  spec.package ??= spec.import.split('.')[0];
  return spec;
});
const PROBE = `
import importlib, json, sys
mods = json.loads(sys.argv[1])
out = {"python": list(sys.version_info[:3]), "executable": sys.executable, "modules": {}}
for m in mods:
    try:
        mod = importlib.import_module(m["import"])
    except BaseException as exc:
        out["modules"][m["import"]] = {"error": "%s: %s" % (type(exc).__name__, exc)}
        continue
    v = None
    try:
        from importlib.metadata import version
        v = version(m["package"])
    except BaseException:
        v = getattr(mod, "__version__", None) or getattr(sys.modules.get(m["import"].split(".")[0]), "__version__", None)
    out["modules"][m["import"]] = {"version": v}
print(json.dumps(out))
`;
const probe = spawnSync(python, ['-c', PROBE, JSON.stringify(requirements.map(({ import: i, package: p }) => ({ import: i, package: p })))],
  { encoding: 'utf8', env: childEnv, cwd: toolDir, timeout: 120000 });
if (probe.error) fail(`cannot start ${python}: ${probe.error.message}`);
let info;
try { info = JSON.parse(probe.stdout.trim().split('\n').pop()); } catch { info = null; }
if (probe.status !== 0 || !info?.python) {
  fail(`${python} failed the environment probe (status ${probe.status}): ${(probe.stderr || probe.stdout || '').trim().split('\n').pop() ?? ''}`);
}
const pyVersion = info.python.join('.');
const cmpVersion = (a, b) => {
  const pa = String(a).split(/[^0-9]+/).filter(Boolean).map(Number);
  const pb = String(b).split(/[^0-9]+/).filter(Boolean).map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
};
if (interp.minVersion && cmpVersion(pyVersion, interp.minVersion) < 0) {
  fail(`${python} is Python ${pyVersion}, but ${tool.id} needs ${interp.minVersion} or newer. ` +
    `To fix: set ${envVar} to a newer interpreter`);
}
const packages = {};
const problems = [];
for (const r of requirements) {
  const m = info.modules[r.import] ?? { error: 'not probed' };
  const advice = r.advice ?? `pip install ${r.package} into that environment, or point ${envVar} at an environment that has it`;
  if (m.error) {
    packages[r.package] = null;
    if (!r.optional) problems.push(`lacks ${r.package}, required by ${tool.id} (${m.error}). To fix: ${advice}`);
    continue;
  }
  packages[r.package] = m.version ?? 'unknown';
  if (r.minVersion && m.version && cmpVersion(m.version, r.minVersion) < 0) {
    problems.push(`has ${r.package} ${m.version} but ${tool.id} needs ${r.minVersion} or newer. To fix: ${advice}`);
  }
}
if (problems.length) fail(`${python} (Python ${pyVersion}) ${problems.join('; ')}`);

// ---- entry ----------------------------------------------------------------------------
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MODULE = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;
// JSON value -> Python literal. JSON string syntax is valid Python string syntax.
function lit(v) {
  if (v === null || v === undefined) return 'None';
  if (typeof v === 'boolean') return v ? 'True' : 'False';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : `float(${JSON.stringify(Number.isNaN(v) ? 'nan' : v > 0 ? 'inf' : '-inf')})`;
  if (typeof v === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(lit).join(', ')}]`;
  return `{${Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}: ${lit(x)}`).join(', ')}}`;
}
const PLACEHOLDER = /\{\{([A-Za-z0-9_-]+)\}\}/g;
const exact = /^\{\{([A-Za-z0-9_-]+)\}\}$/;
const special = { outputDir: 's.output_dir', workDir: 's.work_dir', outputFile: 's.output_file' };
const specialValue = { outputDir, workDir, outputFile };
function expr(a) {
  if (typeof a !== 'string') return lit(a);
  const m = exact.exec(a);
  if (m) {
    const name = m[1];
    if (special[name]) return special[name];
    if (!hasValue(inputs, name)) {
      const decl = tool.inputs?.[name];
      if (decl?.default !== undefined) return lit(decl.default); // declared default
      if (decl?.optional) return 'None'; // optional, no default, left unset
      fail(`entry references input ${name}, which has no value`);
    }
    return `s.inputs[${JSON.stringify(name)}]`;
  }
  return lit(a.replace(PLACEHOLDER, (_, name) => {
    if (specialValue[name] !== undefined) return specialValue[name];
    if (!hasValue(inputs, name)) fail(`entry references input ${name}, which has no value`);
    const v = inputs[name];
    return Array.isArray(v) ? v.join(',') : String(v);
  }));
}

mkdirSync(outputDir, { recursive: true });
mkdirSync(workDir, { recursive: true });
let args;
let entryFile = null;
if (entry.kind === 'function') {
  if (!entry.module || !MODULE.test(entry.module)) fail('entry.module must be a Python module name (e.g. nf_dti_fit)');
  if (!entry.name || !IDENT.test(entry.name)) fail('entry.name must be a Python function name');
  if (entry.result && !tool.outputs?.[entry.result]) fail(`entry.result names output ${entry.result}, which the tool does not declare`);
  const call = `nf_module.${entry.name}(${(entry.args ?? []).map(expr).join(', ')})`;
  const driver = [
    `# Generated by NeuroFlow python_tool.mjs for ${tool.id} (step ${step}); do not edit.`,
    'import importlib',
    'from neuroflow import session',
    's = session()',
    `nf_module = importlib.import_module(${JSON.stringify(entry.module)})`,
    `nf_result = ${call}`,
    ...(entry.result ? [`s.result({${JSON.stringify(entry.result)}: nf_result})`] : []),
    '',
  ].join('\n');
  entryFile = join(workDir, 'nf_driver.py');
  writeFileSync(entryFile, driver);
  args = [entryFile];
} else if (entry.kind === 'script') {
  if (!entry.file) fail('entry.file is required for a script entry');
  entryFile = relToTool(entry.file);
  if (!existsSync(entryFile)) fail(`entry.file does not exist: ${entryFile}`);
  args = [entryFile];
} else {
  fail(`unknown entry.kind "${entry.kind}" (function | script)`);
}

// ---- run ----------------------------------------------------------------------------
const present = Object.entries(packages).filter(([, v]) => v !== null).map(([k, v]) => `${k} ${v}`);
const agent = [`Python ${pyVersion}`, ...present].join(' + ');
console.log(`python_tool: running ${python} ${args.join(' ')} (${agent})`);
const started = Date.now();
const status = await new Promise((res) => {
  const child = spawn(python, args, { cwd: workDir, env: childEnv, stdio: ['ignore', 'inherit', 'inherit'] });
  child.on('error', (err) => { console.error(`python_tool: ${err.message}`); res(127); });
  child.on('exit', (c, signal) => res(c ?? (signal ? 128 : 1)));
});
if (status !== 0) fail(`python exited with status ${status}`);

const produced = mapOutputs(tool, template.outputs, outputDir, fail, { label: 'the Python entry' });
if (entry.result && !existsSync(outputFile)) fail(`the Python entry did not write its result to ${outputFile}`);

appendProvenance(session, {
  step, tool: tool.id, agent, action: 'python', executable: python, args,
  entry: { kind: entry.kind, ...(entry.module ? { module: entry.module } : {}), ...(entry.name ? { name: entry.name } : {}), ...(entry.kind === 'script' ? { file: entryFile } : {}) },
  python: pyVersion, packages,
  durationMs: Date.now() - started, outputs: produced,
});
console.log(`python_tool: python finished in ${((Date.now() - started) / 1000).toFixed(1)} s`);
