#!/usr/bin/env node
/**
 * NeuroFlow adapter for MATLAB / Octave / SPM tools.
 *
 * A tool document describes the MATLAB-side entry under
 * `extensions["neuroflow/matlab"]`; this script picks an engine (MATLAB,
 * GNU Octave, or a compiled SPM standalone on the MATLAB Runtime), generates a
 * wrapper script in the session work dir, runs it headlessly, and maps the files
 * it wrote to the tool's declared outputs. The wrapper builds an `nf` struct
 * from context.json as MATLAB literals (no jsondecode, so hyphenated names and
 * string arrays are not mangled), adds the tool's code and toolboxes to the
 * path, calls the entry inside try/catch, and exits non-zero on any error.
 *
 * Template fields:
 *   engine           "auto" | "matlab" | "octave" | "mcr" (default auto: MATLAB,
 *                    then Octave, then a standalone SPM when SPMMCRCMD is set).
 *                    NEUROFLOW_MATLAB_ENGINE overrides the document.
 *   matlab           { paths[], env, args[], requireSession, startupTimeout }
 *                    where to find `matlab`: the override variable (default
 *                    MATLAB), then `paths` (default /Applications/MATLAB_R*.app,
 *                    /usr/local/MATLAB/R*, newest first; a list here replaces
 *                    the default), then PATH; `args` are extra command-line
 *                    args (e.g. "-nojvm"). `requireSession` ("auto" | true |
 *                    false, default auto) fails the step before launch unless an
 *                    interactive MATLAB from the same install is running; auto
 *                    requires it only under online (sign-in) licensing, read
 *                    from <matlabroot>/licenses/license_info.xml, because a
 *                    headless MATLAB with no signed-in session blocks forever on
 *                    a login it cannot show. NEUROFLOW_MATLAB_REQUIRE_SESSION
 *                    (0/1) overrides. `startupTimeout` (seconds, default 120,
 *                    0 disables) stops a MATLAB that has run no code by then.
 *   octave           { paths[], env, args[] }  same for `octave-cli` ($OCTAVE)
 *   mcr              { env, rootEnv }  standalone SPM launcher (`run_spm12.sh`,
 *                    $SPMMCRCMD) and the MATLAB Runtime root ($MCR_ROOT);
 *                    the launcher is run as `<cmd> <root> script <wrapper>`
 *   singleThread     true (default) adds -singleCompThread / OMP_NUM_THREADS=1
 *   addpath[]        directories of the tool's own .m files, relative to the
 *                    tool document (~ expands); skipped when deployed
 *   toolboxes[]      [{ name, env, paths[], required, advice }]: directories
 *                    added to the path, located like executables (override
 *                    variable, candidate paths with one `*` glob, newest first).
 *                    A missing required toolbox fails the step with `advice`.
 *                    A toolbox named "spm" also records spm('Ver') in provenance.
 *   entry            what to run, one of
 *                      { kind: "function", name, args[], result? }
 *                          `name(args...)`; args are literals or {{input}},
 *                          {{outputDir}}, {{workDir}} placeholders (an exact
 *                          {{name}} passes the input's value with its JSON type;
 *                          a placeholder inside text yields a char array).
 *                          `result` names a core:result-file output that
 *                          receives the function's return value as JSON.
 *                      { kind: "script", file }
 *                          run(file) with `nf` in the workspace
 *                      { kind: "batch", file, inputs[], defaults? }
 *                          SPM batch: `file` is a .mat holding `matlabbatch` or
 *                          a .m script that defines it (it may read `nf`);
 *                          `inputs` fill the batch's open inputs in order;
 *                          runs spm('Defaults', defaults) (default "fmri"),
 *                          spm_jobman('initcfg'), spm_get_defaults('cmdline', true),
 *                          spm_jobman('run', matlabbatch, inputs{:})
 *   outputs{}        name -> file written in the output dir, or { match, pick }
 *                    (as in neuroflow/cli); renamed to the declared delivery.path
 *   clearEnv[]       environment-variable names withheld from the engine
 *
 * The wrapper sees `nf` (runId, step, tool, session, outputDir, workDir,
 * outputFile, inputs.<name>) and runs with the work dir as cwd. It writes
 * nf_info.json (engine version, toolbox versions) beside itself, which this
 * adapter folds into the provenance line.
 *
 * Env: NEUROFLOW_SESSION / _OUTPUT_DIR / _OUTPUT_FILE / _WORK_DIR / _STEP
 * (session contract), NEUROFLOW_MATLAB_ENGINE, MATLAB, OCTAVE, SPMMCRCMD,
 * MCR_ROOT, plus each toolbox's own override variable.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  appendProvenance, checkInputsExist, expand, failer, findExecutable, findToolDoc, hasValue, mapOutputs, readSession,
} from './adapter_lib.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fail = failer('matlab_tool');

const { session, ctx, inputs, step, outputDir, workDir } = readSession(fail);
const outputFile = process.env.NEUROFLOW_OUTPUT_FILE || join(outputDir, 'result.json');

const found = findToolDoc(ctx.tool, here);
if (!found) fail(`tool document ${ctx.tool} not found next to ${here}`);
const { doc: tool, path: toolPath } = found;
const template = tool.extensions?.['neuroflow/matlab'];
if (!template) fail(`${ctx.tool} has no extensions["neuroflow/matlab"] template`);
const entry = template.entry;
if (!entry?.kind) fail('neuroflow/matlab.entry.kind is required (function | script | batch)');
const toolDir = dirname(resolve(toolPath));
const relToTool = (p) => (isAbsolute(expand(p)) ? expand(p) : resolve(toolDir, p));

// Input ids become struct fields of `nf.inputs`, so they must be identifiers.
const IDENT = /^[A-Za-z][A-Za-z0-9_]{0,62}$/;
for (const name of Object.keys(tool.inputs ?? {})) {
  if (!IDENT.test(name)) fail(`input id "${name}" is not a MATLAB identifier (letter, then letters, digits or _)`);
}
checkInputsExist(tool, inputs, fail);

// ---- engine -----------------------------------------------------------------
const ENGINE_DEFAULTS = {
  matlab: {
    command: 'matlab', env: 'MATLAB',
    paths: ['/Applications/MATLAB_R*.app/bin/matlab', '/usr/local/MATLAB/R*/bin/matlab', '/opt/MATLAB/R*/bin/matlab'],
  },
  octave: {
    command: 'octave-cli', env: 'OCTAVE',
    paths: ['/opt/homebrew/bin/octave-cli', '/usr/local/bin/octave-cli', '/usr/bin/octave-cli',
      '/Applications/Octave-*.app/Contents/Resources/usr/bin/octave-cli'],
  },
  mcr: { env: 'SPMMCRCMD', rootEnv: 'MCR_ROOT' },
};
const engineSpec = (name) => {
  const d = ENGINE_DEFAULTS[name];
  const t = template[name] ?? {};
  return { ...d, ...t, paths: t.paths ?? d.paths ?? [], args: t.args ?? [] };
};
const locate = (name) => {
  const spec = engineSpec(name);
  if (name === 'mcr') {
    const cmd = process.env[spec.env];
    if (!cmd) return null;
    if (!existsSync(expand(cmd))) fail(`${spec.env}=${cmd} does not exist`);
    return expand(cmd);
  }
  return findExecutable(spec, fail);
};

const requested = process.env.NEUROFLOW_MATLAB_ENGINE || template.engine || 'auto';
if (!['auto', 'matlab', 'octave', 'mcr'].includes(requested)) fail(`unknown engine "${requested}" (auto | matlab | octave | mcr)`);
let engine = null;
let exe = null;
for (const name of requested === 'auto' ? ['matlab', 'octave', 'mcr'] : [requested]) {
  exe = locate(name);
  if (exe) { engine = name; break; }
}
if (!engine) {
  const hint = requested === 'auto'
    ? 'install MATLAB (or set MATLAB to its bin/matlab), GNU Octave (or set OCTAVE), or set SPMMCRCMD to a standalone SPM launcher'
    : `set ${engineSpec(requested).env} to the ${requested} executable`;
  fail(`no ${requested === 'auto' ? 'MATLAB engine' : requested} found; ${hint}`);
}
if (engine === 'mcr' && entry.kind === 'function') {
  console.error('matlab_tool: warning: a standalone SPM can only run functions compiled into it');
}

// ---- MATLAB license pre-flight ------------------------------------------------------
// Under online (sign-in) licensing a headless `matlab -batch` that finds no signed-in
// session blocks forever on a MathWorks login it cannot display. Signing in is a user
// intervention, so detect the situation and fail before anything is launched.
const matlabRoot = (exePath) => {
  let real = exePath;
  try { real = realpathSync(exePath); } catch { /* keep as given */ }
  return resolve(dirname(dirname(real)));
};
const matlabLicenseMode = (root) => {
  try {
    const xml = readFileSync(join(root, 'licenses', 'license_info.xml'), 'utf8');
    return /<licmode>\s*([^<\s]+)\s*<\/licmode>/.exec(xml)?.[1] ?? 'unknown';
  } catch { return 'unknown'; }
};
// Roots of interactive MATLAB sessions (not -batch), from the process list.
const runningMatlabRoots = () => {
  if (process.platform === 'win32') return null;
  const ps = spawnSync('ps', ['-A', '-o', 'command='], { encoding: 'utf8', env: { ...process.env, COLUMNS: '10000' } });
  if (ps.status !== 0) return null;
  const roots = new Set();
  for (const line of ps.stdout.split('\n')) {
    if (/\s-batch(\s|$)/.test(line)) continue;
    const cmd = line.trim().split(/\s+/)[0];
    if (!cmd || !cmd.startsWith('/')) continue;
    const m = /^(.*)\/(Contents\/MacOS\/MATLAB_mac[ai]64|bin\/glnxa64\/MATLAB)$/.exec(resolve(cmd));
    if (!m) continue;
    try { roots.add(realpathSync(m[1])); } catch { roots.add(m[1]); }
  }
  return [...roots];
};
if (engine === 'matlab') {
  const root = matlabRoot(exe);
  const licmode = matlabLicenseMode(root);
  const envRequire = process.env.NEUROFLOW_MATLAB_REQUIRE_SESSION;
  const setting = envRequire !== undefined ? (envRequire !== '0' && envRequire !== 'false') : (engineSpec('matlab').requireSession ?? 'auto');
  const required = setting === 'auto' ? licmode === 'onlinelicensing' : setting === true;
  if (required) {
    const running = runningMatlabRoots();
    if (running === null) {
      console.error('matlab_tool: warning: cannot list MATLAB sessions on this platform; relying on the startup timeout');
    } else if (!running.includes(root)) {
      const others = running.filter((r) => r !== root);
      const why = licmode === 'onlinelicensing'
        ? `MATLAB at ${root} uses online (sign-in) licensing and no MATLAB session from that install is running`
        : `MATLAB at ${root} requires a running session (matlab.requireSession) and none from that install is running`;
      const because = 'a headless MATLAB would block indefinitely waiting for a MathWorks sign-in that it cannot display';
      const fix = `start MATLAB from ${root} and sign in before running this workflow`
        + (others.length ? `, or set MATLAB to the launcher of an install whose session is running (${others.map((r) => join(r, 'bin', 'matlab')).join(' or ')})` : '')
        + '; set NEUROFLOW_MATLAB_REQUIRE_SESSION=0 (or matlab.requireSession=false) if a license file or server provides the license instead';
      fail(`${why}; ${because}. To fix: ${fix}`);
    }
  }
}

const childEnv = { ...process.env };
for (const name of template.clearEnv ?? []) delete childEnv[name];
const singleThread = template.singleThread !== false;
if (singleThread) childEnv.OMP_NUM_THREADS = '1';
if (engine === 'mcr') childEnv.MCR_INHIBIT_CTF_LOCK = '1';

// ---- toolboxes ----------------------------------------------------------------
const toolboxes = {};
for (const tb of template.toolboxes ?? []) {
  if (!tb?.name) fail('every neuroflow/matlab.toolboxes entry needs a name');
  let dir = null;
  if (tb.env && process.env[tb.env]) {
    dir = expand(process.env[tb.env]);
    if (!existsSync(dir)) fail(`${tb.env}=${dir} does not exist`);
  } else {
    dir = findExecutable({ paths: tb.paths ?? [] }, fail);
  }
  if (!dir) {
    if (engine === 'mcr') continue; // compiled in, or absent: the standalone decides
    if (tb.required !== false) {
      fail(`toolbox ${tb.name} was not found${tb.env ? ` (set ${tb.env} to its directory)` : ''}; ` +
        `looked in ${(tb.paths ?? []).join(', ') || 'no fixed locations'}. ${tb.advice ?? ''}`.trim());
    }
    continue;
  }
  toolboxes[tb.name] = dir;
}

// ---- wrapper generation --------------------------------------------------------
const str = (s) => `'${String(s).replace(/'/g, "''")}'`;
// JSON value -> MATLAB literal (strings as char arrays, arrays of one kind as
// vectors/cells, objects as structs).
function lit(v) {
  if (v === null || v === undefined) return '[]';
  if (typeof v === 'string') return str(v);
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : (Number.isNaN(v) ? 'NaN' : (v > 0 ? 'Inf' : '-Inf'));
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) {
    if (v.length && v.every((x) => typeof x === 'number')) return `[${v.map(lit).join(', ')}]`;
    return `{${v.map(lit).join(', ')}}`;
  }
  const fields = Object.entries(v).map(([k, x]) => {
    if (!IDENT.test(k)) fail(`object field "${k}" is not a MATLAB identifier`);
    // struct() spreads cell values across a struct array; wrap them once.
    const l = lit(x);
    return `${str(k)}, ${l.startsWith('{') ? `{${l}}` : l}`;
  });
  return fields.length ? `struct(${fields.join(', ')})` : 'struct()';
}
const PLACEHOLDER = /\{\{([A-Za-z0-9_-]+)\}\}/g;
const exact = /^\{\{([A-Za-z0-9_-]+)\}\}$/;
const special = { outputDir: 'nf.outputDir', workDir: 'nf.workDir', outputFile: 'nf.outputFile' };
const specialValue = { outputDir, workDir, outputFile };
// One entry argument -> MATLAB expression.
function expr(a) {
  if (typeof a !== 'string') return lit(a);
  const m = exact.exec(a);
  if (m) {
    const name = m[1];
    if (special[name]) return special[name];
    if (!hasValue(inputs, name)) fail(`entry references input ${name}, which has no value`);
    return `nf.inputs.${name}`;
  }
  return str(a.replace(PLACEHOLDER, (_, name) => {
    if (specialValue[name] !== undefined) return specialValue[name];
    if (!hasValue(inputs, name)) fail(`entry references input ${name}, which has no value`);
    const v = inputs[name];
    return Array.isArray(v) ? v.join(',') : String(v);
  }));
}

const lines = [];
const L = (...s) => lines.push(...s);
L(`% Generated by NeuroFlow matlab_tool.mjs for ${tool.id} (step ${step}); do not edit.`);
L('nf = struct();');
for (const [k, v] of Object.entries({
  runId: ctx.runId ?? '', step, tool: tool.id, session, outputDir, workDir, outputFile,
})) L(`nf.${k} = ${lit(v)};`);
L('nf.inputs = struct();');
for (const [k, v] of Object.entries(inputs)) {
  if (!IDENT.test(k)) fail(`input id "${k}" is not a MATLAB identifier`);
  L(`nf.inputs.${k} = ${lit(v)};`);
}
L('nf_status = 1;',
  'try',
  "  nf_deployed = exist('isdeployed', 'builtin') == 5 && isdeployed;",
  "  nf_octave = exist('OCTAVE_VERSION', 'builtin') == 5;",
  '  if ~nf_deployed');
for (const p of template.addpath ?? []) L(`    addpath(${str(relToTool(p))});`);
for (const [name, dir] of Object.entries(toolboxes)) L(`    addpath(${str(dir)}); % toolbox ${name}`);
L('  end',
  '  nf_info = struct();',
  `  nf_info.engine = ${str(engine)};`,
  '  nf_info.version = version();',
  '  nf_info.octave = nf_octave;',
  '  nf_info.deployed = nf_deployed;',
  '  nf_info.toolboxes = struct();');
for (const [name, dir] of Object.entries(toolboxes)) L(`  nf_info.toolboxes.${name} = ${str(dir)};`);
L("  if exist('spm', 'file') == 2",
  '    try',
  "      [nf_spm_v, nf_spm_r] = spm('Ver');",
  "      nf_info.spm = sprintf('%s (%s)', nf_spm_v, nf_spm_r);",
  '    catch',
  "      try, nf_info.spm = spm('Ver'); catch, end",
  '    end',
  '  end',
  `  nf_fid = fopen(${str(join(workDir, 'nf_info.json'))}, 'w');`,
  '  if nf_fid > 0',
  "    if exist('jsonencode', 'file') == 2 || exist('jsonencode', 'builtin') == 5",
  "      fprintf(nf_fid, '%s', jsonencode(nf_info));",
  '    else',
  `      fprintf(nf_fid, '{"engine":"%s","version":"%s"}', nf_info.engine, strrep(strrep(nf_info.version, '\\', '\\\\'), '"', '\\"'));`,
  '    end',
  '    fclose(nf_fid);',
  '  end',
  `  cd(${str(workDir)});`);

const entryFile = entry.file ? relToTool(entry.file) : null;
if (entry.kind === 'function') {
  if (!entry.name || !IDENT.test(entry.name)) fail('entry.name must be a MATLAB function name');
  const call = `${entry.name}(${(entry.args ?? []).map(expr).join(', ')})`;
  if (entry.result) {
    if (!tool.outputs?.[entry.result]) fail(`entry.result names output ${entry.result}, which the tool does not declare`);
    L(`  nf_result = ${call};`,
      "  nf_fid = fopen(nf.outputFile, 'w');",
      "  if nf_fid < 0, error('matlab_tool:outputFile', 'cannot write %s', nf.outputFile); end",
      `  fprintf(nf_fid, '%s', jsonencode(struct(${str(entry.result)}, {nf_result})));`,
      '  fclose(nf_fid);');
  } else {
    L(`  ${call};`);
  }
} else if (entry.kind === 'script') {
  if (!entryFile) fail('entry.file is required for a script entry');
  if (!existsSync(entryFile)) fail(`entry.file does not exist: ${entryFile}`);
  L(`  run(${str(entryFile)});`);
} else if (entry.kind === 'batch') {
  if (!entryFile) fail('entry.file is required for a batch entry');
  if (!existsSync(entryFile)) fail(`entry.file does not exist: ${entryFile}`);
  if (entryFile.endsWith('.mat')) {
    L(`  nf_batch = load(${str(entryFile)});`,
      "  if ~isfield(nf_batch, 'matlabbatch'), error('matlab_tool:batch', 'batch file holds no matlabbatch'); end",
      '  matlabbatch = nf_batch.matlabbatch;');
  } else {
    L(`  run(${str(entryFile)});`,
      "  if ~exist('matlabbatch', 'var'), error('matlab_tool:batch', 'batch script did not define matlabbatch'); end");
  }
  L(`  spm('Defaults', ${str(entry.defaults ?? 'fmri')});`,
    "  spm_jobman('initcfg');",
    "  spm_get_defaults('cmdline', true);",
    `  nf_batch_inputs = {${(entry.inputs ?? []).map(expr).join(', ')}};`,
    "  spm_jobman('run', matlabbatch, nf_batch_inputs{:});");
} else {
  fail(`unknown entry.kind "${entry.kind}" (function | script | batch)`);
}
L('  nf_status = 0;',
  'catch nf_err',
  "  fprintf(2, 'matlab_tool: %s\\n', nf_err.message);",
  '  for nf_k = 1:numel(nf_err.stack)',
  "    fprintf(2, '  at %s (%s:%d)\\n', nf_err.stack(nf_k).name, nf_err.stack(nf_k).file, nf_err.stack(nf_k).line);",
  '  end',
  'end',
  'exit(nf_status);',
  '');

mkdirSync(outputDir, { recursive: true });
mkdirSync(workDir, { recursive: true });
const wrapper = join(workDir, 'nf_wrapper.m');
writeFileSync(wrapper, lines.join('\n'));

// ---- command line ----------------------------------------------------------------
const runExpr = `run(${str(wrapper)})`;
let args;
if (engine === 'matlab') {
  args = ['-batch', runExpr, ...(singleThread ? ['-singleCompThread'] : []), ...engineSpec('matlab').args];
} else if (engine === 'octave') {
  args = ['--no-gui', '-q', ...engineSpec('octave').args, '--eval', runExpr];
} else {
  const rootEnv = engineSpec('mcr').rootEnv;
  const root = process.env[rootEnv];
  if (!root) fail(`${rootEnv} must point at the MATLAB Runtime root when using a standalone SPM`);
  args = [expand(root), 'script', wrapper];
}

// ---- run ----------------------------------------------------------------------------
console.log(`matlab_tool: running ${engine} ${exe} ${args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}`);
const started = Date.now();
// Startup watchdog (MATLAB only): the wrapper writes nf_info.json as its first act, so a
// MATLAB that has not written it after `startupTimeout` seconds is stuck before running
// any code, which in practice means a license prompt or an unreachable license server.
const startupTimeout = engine === 'matlab' ? Number(engineSpec('matlab').startupTimeout ?? 120) : 0;
const infoFile = join(workDir, 'nf_info.json');
let stalled = false;
const status = await new Promise((res) => {
  const child = spawn(exe, args, { cwd: workDir, env: childEnv, stdio: ['ignore', 'inherit', 'inherit'] });
  let timer = null;
  const stop = () => { if (timer) clearInterval(timer); };
  child.on('error', (err) => { stop(); console.error(`matlab_tool: ${err.message}`); res(127); });
  child.on('exit', (c, signal) => { stop(); res(c ?? (signal ? 128 : 1)); });
  if (startupTimeout > 0) {
    timer = setInterval(() => {
      if (existsSync(infoFile)) { stop(); return; }
      if (Date.now() - started < startupTimeout * 1000) return;
      stop();
      stalled = true;
      child.kill('SIGTERM');
      setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already gone */ } }, 5000).unref();
    }, 500);
  }
});
if (stalled) {
  fail(`MATLAB started but ran no code within ${startupTimeout} s and was stopped; it was most likely waiting for a MathWorks `
    + 'sign-in or a license server. To fix: start MATLAB and sign in before running this workflow, or raise matlab.startupTimeout '
    + 'for a slow machine (0 disables the watchdog)');
}
if (status !== 0) fail(`${engine} exited with status ${status}`);

let info = {};
try { info = JSON.parse(readFileSync(join(workDir, 'nf_info.json'), 'utf8')); } catch { /* wrapper never got that far */ }
const produced = mapOutputs(tool, template.outputs, outputDir, fail, { label: `the ${engine} entry` });
if (entry.result && !existsSync(outputFile)) fail(`the ${engine} entry did not write its result to ${outputFile}`);

const agentName = engine === 'octave' ? 'GNU Octave' : engine === 'mcr' ? 'MATLAB Runtime' : 'MATLAB';
const agent = [info.version ? `${agentName} ${info.version}` : agentName, info.spm].filter(Boolean).join(' + ');
appendProvenance(session, {
  step, tool: tool.id, agent, action: 'matlab', engine, executable: exe, args,
  entry: { kind: entry.kind, ...(entry.name ? { name: entry.name } : {}), ...(entryFile ? { file: entryFile } : {}) },
  toolboxes: Object.fromEntries(Object.entries(toolboxes).map(([k, dir]) => [k, { path: dir, ...(k === 'spm' && info.spm ? { version: info.spm } : {}) }])),
  durationMs: Date.now() - started, outputs: produced,
});
console.log(`matlab_tool: ${engine} finished in ${((Date.now() - started) / 1000).toFixed(1)} s`);
