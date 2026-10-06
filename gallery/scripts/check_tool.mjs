/**
 * check_tool.mjs: the up-front environment check behind the desktop builder's
 * Environment panel.
 *
 *   node check_tool.mjs <tool.json>...          check these tool documents
 *   node check_tool.mjs --tools-dir <dir>...    check every tool document under dirs
 *
 * Prints one JSON array, one entry per tool:
 *   { id, adapter, status, detail, fix, executable, version, packages }
 *   status: ready | needsSetup | interactive | unsupported
 *
 * Each adapter's probe is the same the adapter itself runs before launching
 * (cli_tool.mjs probe/match/version, python_tool.mjs requirement imports and
 * minVersion, matlab_tool.mjs engine search, neurodesk_job.mjs app search), so
 * what this reports as ready is what a run will find. Nothing here needs a
 * session: it never starts the real program.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { expand, findExecutable } from './adapter_lib.mjs';

class Setup extends Error {
  constructor(detail, fix) { super(detail); this.fix = fix ?? null; }
}
const fail = (message) => { throw new Setup(message); };

// ---- shared with the adapters ---------------------------------------------------------
const cmpVersion = (a, b) => {
  const pa = String(a).split(/[^0-9]+/).filter(Boolean).map(Number);
  const pb = String(b).split(/[^0-9]+/).filter(Boolean).map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
};

const PY_PROBE = `
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

const MATLAB_ENGINES = {
  matlab: {
    command: 'matlab', env: 'MATLAB',
    paths: ['/Applications/MATLAB_R*.app/bin/matlab', '/usr/local/MATLAB/R*/bin/matlab', '/opt/MATLAB/R*/bin/matlab'],
  },
  octave: {
    command: 'octave-cli', env: 'OCTAVE',
    paths: ['/opt/homebrew/bin/octave-cli', '/usr/local/bin/octave-cli', '/usr/bin/octave-cli',
      '/Applications/Octave-*.app/Contents/Resources/usr/bin/octave-cli'],
  },
  mcr: { env: 'SPMMCRCMD' },
};

const NEURODESK_ADVICE = 'Download the Neurodesk Webapps suite from the webapps-v* releases at https://github.com/neurodesk/webapps/releases, move neurodesk-webapps.app to /Applications, or set NEURODESK_WEBAPPS to its executable, e.g. /Applications/neurodesk-webapps.app/Contents/MacOS/neurodesk-webapps';

// ---- per-adapter checks ---------------------------------------------------------------
function checkCli(tool) {
  const template = tool.extensions?.['neuroflow/cli'];
  if (!template) fail(`${tool.id} has no extensions["neuroflow/cli"] template`);
  const exe = findExecutable(template, fail);
  if (!exe) {
    throw new Setup(`${template.command} was not found`,
      `install ${template.command}${template.env ? ` or set ${template.env} to its path` : ''}; looked in ${(template.paths ?? []).join(', ') || 'no fixed locations'} and on PATH`);
  }
  let version = null;
  const p = template.probe;
  if (p) {
    const env = { ...process.env };
    for (const name of template.clearEnv ?? []) delete env[name];
    const r = spawnSync(exe, p.args ?? [], { encoding: 'utf8', env, timeout: 60000 });
    const text = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
    const matched = p.match ? new RegExp(p.match).test(text) : r.status === 0;
    if (r.error || (!matched && r.status !== 0)) {
      throw new Setup(`${exe} probe ${r.error ? 'could not start' : `exited with status ${r.status}`}`, p.advice ?? null);
    }
    if (!matched) throw new Setup(`${exe} does not look like a usable ${template.command}: output lacks /${p.match}/`, p.advice ?? null);
    if (p.version) version = new RegExp(p.version).exec(text)?.[0] ?? null;
  }
  return { executable: exe, version, detail: version ? `${template.command} ${version}` : template.command };
}

function checkPython(tool, toolPath) {
  const template = tool.extensions?.['neuroflow/python'];
  if (!template) fail(`${tool.id} has no extensions["neuroflow/python"] template`);
  const toolDir = dirname(resolve(toolPath));
  const relToTool = (p) => {
    const e = expand(p.replaceAll('{{toolDir}}', toolDir));
    return isAbsolute(e) ? e : resolve(toolDir, e);
  };
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
    throw new Setup('no Python interpreter found',
      `set ${envVar} to one or install python3 on PATH; looked in ${candidatePaths.join(', ') || 'no fixed locations'} and on PATH`);
  }
  const requirements = (template.requirements ?? []).map((r) => {
    const spec = typeof r === 'string' ? { import: r, package: r } : { ...r };
    spec.package ??= spec.import.split('.')[0];
    return spec;
  });
  const probe = spawnSync(python, ['-c', PY_PROBE, JSON.stringify(requirements.map(({ import: i, package: p }) => ({ import: i, package: p })))],
    { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }, cwd: toolDir, timeout: 120000 });
  if (probe.error) throw new Setup(`cannot start ${python}: ${probe.error.message}`, `set ${envVar} to a working interpreter`);
  let info;
  try { info = JSON.parse(probe.stdout.trim().split('\n').pop()); } catch { info = null; }
  if (probe.status !== 0 || !info?.python) {
    throw new Setup(`${python} failed the environment probe (status ${probe.status}): ${(probe.stderr || probe.stdout || '').trim().split('\n').pop() ?? ''}`,
      `set ${envVar} to a working interpreter`);
  }
  const pyVersion = info.python.join('.');
  if (interp.minVersion && cmpVersion(pyVersion, interp.minVersion) < 0) {
    throw new Setup(`${python} is Python ${pyVersion}, but ${tool.id} needs ${interp.minVersion} or newer`, `set ${envVar} to a newer interpreter`);
  }
  const packages = {};
  const problems = [];
  const fixes = [];
  for (const r of requirements) {
    const m = info.modules[r.import] ?? { error: 'not probed' };
    const advice = r.advice ?? `pip install ${r.package} into that environment, or point ${envVar} at an environment that has it`;
    if (m.error) {
      packages[r.package] = null;
      if (!r.optional) { problems.push(`${r.package} is missing`); fixes.push(advice); }
      continue;
    }
    packages[r.package] = m.version ?? 'unknown';
    if (r.minVersion && m.version && cmpVersion(m.version, r.minVersion) < 0) {
      problems.push(`${r.package} ${m.version} is older than the required ${r.minVersion}`);
      fixes.push(advice);
    }
  }
  if (problems.length) {
    const e = new Setup(`${python} (Python ${pyVersion}): ${problems.join('; ')}`, [...new Set(fixes)].join(' '));
    e.extra = { executable: python, version: pyVersion, packages };
    throw e;
  }
  const have = Object.entries(packages).filter(([, v]) => v).map(([k, v]) => `${k} ${v}`);
  return { executable: python, version: pyVersion, packages, detail: `Python ${pyVersion}${have.length ? ` with ${have.join(', ')}` : ''}` };
}

function checkMatlab(tool) {
  const template = tool.extensions?.['neuroflow/matlab'] ?? {};
  const spec = (name) => {
    const d = MATLAB_ENGINES[name];
    const t = template[name] ?? {};
    return { ...d, ...t, paths: t.paths ?? d.paths ?? [] };
  };
  const requested = process.env.NEUROFLOW_MATLAB_ENGINE || template.engine || 'auto';
  if (!['auto', 'matlab', 'octave', 'mcr'].includes(requested)) fail(`unknown engine "${requested}" (auto | matlab | octave | mcr)`);
  for (const name of requested === 'auto' ? ['matlab', 'octave', 'mcr'] : [requested]) {
    const s = spec(name);
    let exe;
    if (name === 'mcr') {
      const cmd = process.env[s.env];
      if (!cmd) continue;
      if (!existsSync(expand(cmd))) fail(`${s.env}=${cmd} does not exist`);
      exe = expand(cmd);
    } else {
      exe = findExecutable(s, fail);
    }
    if (exe) return { executable: exe, version: null, detail: `${name === 'mcr' ? 'standalone SPM' : name} at ${exe}` };
  }
  const fix = requested === 'auto'
    ? 'install MATLAB (or set MATLAB to its bin/matlab), GNU Octave (or set OCTAVE), or set SPMMCRCMD to a standalone SPM launcher'
    : `set ${spec(requested).env} to the ${requested} executable`;
  throw new Setup(`no ${requested === 'auto' ? 'MATLAB engine' : requested} found`, fix);
}

function checkNeurodesk() {
  const env = process.env.NEURODESK_WEBAPPS;
  if (env) {
    if (!existsSync(env)) fail(`NEURODESK_WEBAPPS=${env} does not exist`);
    return { executable: env, version: null, detail: `neurodesk-webapps at ${env}` };
  }
  const bundles = ['neurodesk-webapps.app', 'Neurodesk Webapps.app'];
  const roots = ['/Applications', join(homedir(), 'Applications'), join(homedir(), 'Downloads')];
  for (const root of roots) {
    for (const bundle of bundles) {
      const exe = join(root, bundle, 'Contents', 'MacOS', 'neurodesk-webapps');
      if (existsSync(exe)) return { executable: exe, version: null, detail: `neurodesk-webapps at ${exe}` };
    }
  }
  for (const dir of (process.env.PATH || '').split(delimiter)) {
    for (const name of ['neurodesk-webapps', 'neurodesk-webapps.exe']) {
      if (dir && existsSync(join(dir, name))) return { executable: join(dir, name), version: null, detail: `neurodesk-webapps at ${join(dir, name)}` };
    }
  }
  const container = existsSync('/Applications/NeurodeskApp.app')
    ? ' NeurodeskApp.app is installed, but that is the container-based Neurodesk desktop; this tool needs the separate Neurodesk Webapps suite.'
    : '';
  throw new Setup(`neurodesk-webapps was not found.${container}`, NEURODESK_ADVICE);
}

// A plain node script: its npm requirements must resolve from the script's location.
function checkNodeScript(launch, scriptPath) {
  const req = createRequire(scriptPath);
  const missing = [];
  for (const r of launch.requirements ?? []) {
    if (typeof r !== 'string' || !/^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/.test(r)) continue;
    try { req.resolve(r); } catch { missing.push(r); }
  }
  if (missing.length) throw new Setup(`${missing.join(', ')} not installed`, 'run npm install in the repository root');
  return { executable: scriptPath, version: process.version, detail: `node ${process.version}` };
}

// ---- one tool -------------------------------------------------------------------------
export function checkTool(toolPath) {
  let tool;
  try { tool = JSON.parse(readFileSync(toolPath, 'utf8')); } catch (e) {
    return { id: toolPath, adapter: null, status: 'unsupported', detail: `cannot read tool document: ${e.message}`, fix: null };
  }
  const base = { id: tool.id ?? toolPath, adapter: null, status: 'ready', detail: '', fix: null, executable: null, version: null, packages: null };
  const launch = tool.extensions?.['neuroflow/launch'];
  if (!launch) return { ...base, status: 'unsupported', detail: 'no neuroflow/launch extension: nothing can start this tool' };
  if (launch.kind === 'uiApp') {
    return { ...base, adapter: 'uiApp', status: 'interactive', detail: `interactive ${launch.app ?? 'app'}; runs in a host window (MCP Apps, RFC 0009 section 6), not from the builder yet` };
  }
  if (launch.kind !== 'script') return { ...base, status: 'unsupported', detail: `launch kind ${JSON.stringify(launch.kind)} is not supported` };
  if (launch.interactive) return { ...base, adapter: 'script', status: 'interactive', detail: 'interactive scripts need a host window' };
  const scriptPath = resolve(dirname(resolve(toolPath)), launch.script ?? '');
  if (!launch.script || !existsSync(scriptPath)) {
    return { ...base, adapter: 'script', status: 'needsSetup', detail: `launch script ${launch.script ?? '(none)'} not found`, fix: 'restore the gallery scripts directory' };
  }
  const ext = tool.extensions ?? {};
  const adapter = ext['neuroflow/cli'] ? 'cli' : ext['neuroflow/python'] ? 'python' : ext['neuroflow/matlab'] ? 'matlab' : ext['neurodesk/job'] ? 'neurodesk' : 'script';
  try {
    const found = adapter === 'cli' ? checkCli(tool)
      : adapter === 'python' ? checkPython(tool, toolPath)
        : adapter === 'matlab' ? checkMatlab(tool)
          : adapter === 'neurodesk' ? checkNeurodesk()
            : checkNodeScript(launch, scriptPath);
    return { ...base, adapter, ...found };
  } catch (e) {
    if (e instanceof Setup) return { ...base, adapter, ...(e.extra ?? {}), status: 'needsSetup', detail: e.message, fix: e.fix };
    return { ...base, adapter, status: 'needsSetup', detail: `check failed: ${e.message}`, fix: null };
  }
}

function listToolDocs(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    if (!existsSync(d)) continue;
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      if (entry.isDirectory()) stack.push(p);
      else if (entry.name.endsWith('.json')) {
        try { if (JSON.parse(readFileSync(p, 'utf8')).kind === 'tool') out.push(p); } catch { /* skip */ }
      }
    }
  }
  return out.sort();
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  const args = process.argv.slice(2);
  const paths = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--tools-dir') paths.push(...listToolDocs(resolve(args[++i])));
    else paths.push(resolve(args[i]));
  }
  if (!paths.length) {
    console.error('usage: node check_tool.mjs <tool.json>... | --tools-dir <dir>...');
    process.exit(2);
  }
  process.stdout.write(`${JSON.stringify(paths.map(checkTool))}\n`);
}
