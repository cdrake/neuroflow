/**
 * Helpers shared by the gallery's launch adapters and check_tool.mjs.
 *
 * Each adapter is a `neuroflow/launch` script: the runtime starts it with the
 * session contract (NEUROFLOW_SESSION and <session>/context.json), the adapter
 * reads its own template from the tool document, runs the real program, and
 * maps what the program wrote to the tool's declared outputs.
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, join } from 'node:path';

/** Input types whose values are literals rather than paths. */
export const SCALAR_TYPES = new Set(['core:string', 'core:integer', 'core:number', 'core:boolean', 'core:object']);

/** Print `<adapter>: message` to stderr and exit 1. */
export function failer(adapter) {
  return (message) => {
    console.error(`${adapter}: ${message}`);
    process.exit(1);
  };
}

/** Expand a leading `~/` to the home directory. */
export const expand = (p) => (p.startsWith('~/') ? join(homedir(), p.slice(2)) : p);

/**
 * Read the session contract: context.json plus the NEUROFLOW_* overrides.
 * Returns { session, ctx, inputs, step, outputDir, workDir }.
 */
export function readSession(fail) {
  const session = process.env.NEUROFLOW_SESSION;
  if (!session) fail('NEUROFLOW_SESSION is not set; run this through a NeuroFlow runtime');
  const ctx = JSON.parse(readFileSync(join(session, 'context.json'), 'utf8'));
  return {
    session,
    ctx,
    inputs: ctx.inputs ?? {},
    step: process.env.NEUROFLOW_STEP || ctx.step || 'step',
    outputDir: process.env.NEUROFLOW_OUTPUT_DIR || ctx.outputDir,
    workDir: process.env.NEUROFLOW_WORK_DIR || ctx.workDir || session,
  };
}

/**
 * Locate the tool document for `id`: NEUROFLOW_TOOL_DOC wins, otherwise the
 * gallery's tools directory next to the scripts directory is scanned.
 * Returns { doc, path } or null.
 */
export function findToolDoc(id, scriptsDir) {
  if (process.env.NEUROFLOW_TOOL_DOC) {
    const path = process.env.NEUROFLOW_TOOL_DOC;
    return { doc: JSON.parse(readFileSync(path, 'utf8')), path };
  }
  const stack = [join(scriptsDir, '..', 'tools')];
  while (stack.length) {
    const dir = stack.pop();
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(path);
      else if (entry.name.endsWith('.json')) {
        try {
          const doc = JSON.parse(readFileSync(path, 'utf8'));
          if (doc.kind === 'tool' && doc.id === id) return { doc, path };
        } catch { /* not a tool document */ }
      }
    }
  }
  return null;
}

/**
 * Resolve an executable: the override variable, then candidate paths (with
 * `~` expanded and a single `*` glob segment allowed, newest name first), then
 * PATH. Returns the path or null.
 */
export function findExecutable({ command, paths = [], env }, fail) {
  if (env && process.env[env]) {
    const p = expand(process.env[env]);
    if (!existsSync(p)) fail(`${env}=${p} does not exist`);
    return p;
  }
  for (const pattern of paths.map(expand)) {
    for (const p of globOne(pattern)) if (existsSync(p)) return p;
  }
  if (command) {
    for (const dir of (process.env.PATH ?? '').split(delimiter)) {
      if (dir && existsSync(join(dir, command))) return join(dir, command);
    }
  }
  return null;
}

/**
 * Expand one `*` inside a single path segment (e.g. /Applications/MATLAB_R*.app/bin/matlab),
 * returning matches sorted so the lexically greatest (newest release) comes first.
 */
export function globOne(pattern) {
  const star = pattern.indexOf('*');
  if (star < 0) return [pattern];
  const segStart = pattern.lastIndexOf('/', star) + 1;
  const segEnd = pattern.indexOf('/', star);
  const dir = pattern.slice(0, segStart) || '.';
  const seg = pattern.slice(segStart, segEnd < 0 ? undefined : segEnd);
  const rest = segEnd < 0 ? '' : pattern.slice(segEnd);
  if (!existsSync(dir)) return [];
  const re = new RegExp(`^${seg.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
  return readdirSync(dir).filter((name) => re.test(name)).sort().reverse().map((name) => join(dir, name) + rest);
}

/**
 * Every non-scalar input is a path; fail by input name when one is missing so
 * a broken reference is not reported as the program's own error.
 */
export function checkInputsExist(tool, inputs, fail) {
  for (const [name, decl] of Object.entries(tool.inputs ?? {})) {
    const v = inputs[name];
    if (v === undefined || v === null || typeof decl.type !== 'string') continue;
    const element = /^core:array<(.+)>$/.exec(decl.type)?.[1] ?? decl.type;
    if (SCALAR_TYPES.has(element)) continue;
    for (const p of Array.isArray(v) ? v : [v]) {
      if (typeof p === 'string' && p !== '' && !existsSync(p)) fail(`input ${name} (${decl.type}) does not exist: ${p}`);
    }
  }
}

/** True when the input has a usable value. */
export const hasValue = (inputs, name) => inputs[name] !== undefined && inputs[name] !== null && inputs[name] !== '';

/**
 * Map the files a program wrote in `outputDir` to the tool's declared outputs.
 * `spec` is name -> file name, or name -> { match, pick } (regex over the output
 * dir; pick "first" | "largest"; default exactly one match). Each file is
 * renamed to the output's declared delivery.path. Returns name -> final path.
 */
export function mapOutputs(tool, spec, outputDir, fail, { label = 'the program', log = console.log } = {}) {
  const produced = {};
  const written = existsSync(outputDir)
    ? readdirSync(outputDir).filter((f) => statSync(join(outputDir, f)).isFile())
    : [];
  for (const [name, rule] of Object.entries(spec ?? {})) {
    const decl = tool.outputs?.[name];
    let file = null;
    if (typeof rule === 'string') {
      if (existsSync(join(outputDir, rule))) file = rule;
    } else {
      const re = new RegExp(rule.match);
      const hits = written.filter((f) => re.test(f)).sort();
      if (hits.length === 1 || (hits.length > 1 && rule.pick === 'first')) file = hits[0];
      else if (hits.length > 1 && rule.pick === 'largest') {
        file = hits.map((f) => [f, statSync(join(outputDir, f)).size]).sort((a, b) => b[1] - a[1])[0][0];
      } else if (hits.length > 1) fail(`output ${name}: ${hits.length} files match /${rule.match}/ (${hits.join(', ')}); set pick`);
    }
    if (!file) {
      if (decl?.optional) continue;
      fail(`${label} did not write output ${name} (${typeof rule === 'string' ? rule : `/${rule.match}/`}); ` +
        `output dir holds: ${written.join(', ') || 'nothing'}`);
    }
    const target = decl?.delivery?.path ?? file;
    if (target !== file) {
      mkdirSync(dirname(join(outputDir, target)), { recursive: true });
      renameSync(join(outputDir, file), join(outputDir, target));
      log(`${basename(process.argv[1] ?? 'adapter', '.mjs')}: ${file} -> ${name} (${target})`);
    }
    produced[name] = target;
  }
  return produced;
}

/** Append one provenance line to <session>/provenance.jsonl. */
export function appendProvenance(session, record) {
  appendFileSync(join(session, 'provenance.jsonl'), JSON.stringify({
    ts: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    ...record,
  }) + '\n');
}

/**
 * Locate an app's source checkout, the way the runtime finds a `uiApp`'s:
 * NEUROFLOW_UI_APP_<APP> when it names a directory, otherwise a directory named
 * `repo` beside the NeuroFlow checkout that `fromDir` (a tool document's
 * directory) lives in. An override that is not a directory falls through to the
 * sibling, as in the runtime (`registry.rs` `launch_of`). With `entry`, a
 * sibling only counts when it holds that file, so an unrelated directory of the
 * same name (BIDSvue's WebKit cache `$TMPDIR/bidsui`) is skipped.
 * Returns { path, key, tried } where path is null when nothing was found.
 */
export function findAppCheckout({ app, repo, entry }, fromDir) {
  const key = `NEUROFLOW_UI_APP_${String(app).toUpperCase().replace(/-/g, '_')}`;
  const isDir = (p) => existsSync(p) && statSync(p).isDirectory();
  const tried = [];
  if (process.env[key]) {
    const p = expand(process.env[key]);
    tried.push(`${key}=${p}`);
    if (isDir(p)) return { path: p, key, tried };
  }
  if (repo) {
    // fromDir is the tools directory; like the Rust runtime (registry.rs
    // default_checkout), treat its registry root and the next two ancestors as
    // "the NeuroFlow checkout" and look beside each.
    let dir = dirname(fromDir);
    for (let i = 0; i < 3; i++) {
      const parent = dirname(dir);
      if (parent === dir) break;
      const candidate = join(parent, repo);
      if (isDir(candidate) && entry && !existsSync(join(candidate, entry))) {
        tried.push(`${candidate} (no ${entry})`);
      } else {
        tried.push(candidate);
        if (isDir(candidate)) return { path: candidate, key, tried };
      }
      dir = parent;
    }
  }
  return { path: null, key, tried };
}

/**
 * Run a template's `probe` ({ args, match, version }) with `exe` and judge it. A
 * matching output is proof enough: some tools exit non-zero after printing their
 * version (dcm2niix -v returns 3), so a bad status only counts when the output
 * does not match either. Returns { ok, reason, version, stdout }: reason is
 * 'could not start', 'exited with status N' or 'mismatch'.
 */
export function runProbe(exe, probe, { env = process.env, cwd } = {}) {
  const r = spawnSync(exe, probe.args ?? [], { encoding: 'utf8', env, cwd, timeout: 60000 });
  const text = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
  const matched = probe.match ? new RegExp(probe.match).test(text) : r.status === 0;
  if (r.error || (!matched && r.status !== 0)) {
    return { ok: false, reason: r.error ? 'could not start' : `exited with status ${r.status}`, stdout: r.stdout ?? '' };
  }
  if (!matched) return { ok: false, reason: 'mismatch', stdout: r.stdout ?? '' };
  const version = probe.version ? new RegExp(probe.version).exec(text)?.[0] ?? null : null;
  return { ok: true, version, stdout: r.stdout ?? '' };
}

/**
 * Everything an `neuroflow/app-cli` run needs before it starts, checked the same
 * way by app_cli.mjs and check_tool.mjs: the app checkout, its `entry` file, the
 * runner (`command`), and the app's own readiness `probe` run in the checkout.
 * The probe is the app's to define (BIDSvue: `neuroflow-ingest --check`, which
 * prints one JSON line `{ ready, problems[] }`), so NeuroFlow does not copy the
 * app's dependency lookup. Returns { checkout, exe, version } or { problem, fix }.
 */
export function resolveAppCli(t, fromDir) {
  const checkout = findAppCheckout(t, fromDir);
  if (!checkout.path) {
    return {
      problem: `${t.app} checkout not found (looked at ${checkout.tried.join(', ')})`,
      fix: `clone ${t.repo ?? t.app}${t.branch ? ` (branch ${t.branch})` : ''} beside the NeuroFlow checkout, or set ${checkout.key} to its directory`,
    };
  }
  if (t.entry && !existsSync(join(checkout.path, t.entry))) {
    return { problem: `${checkout.path} has no ${t.entry}`, fix: t.branch ? `check out ${t.branch} there` : null };
  }
  let exe;
  try {
    exe = findExecutable(t, (message) => { throw new Error(message); });
  } catch (e) {
    return { problem: e.message, fix: `point ${t.env} at ${t.command}, or unset it` };
  }
  if (!exe) {
    return {
      problem: `${t.command} was not found (looked in ${(t.paths ?? []).join(', ') || 'no fixed locations'} and on PATH)`,
      fix: `install ${t.command}${t.env ? ` or set ${t.env} to its path` : ''}`,
    };
  }
  let version = null;
  if (t.probe) {
    const r = runProbe(exe, t.probe, { cwd: checkout.path });
    if (!r.ok) {
      const said = appProblems(r.stdout);
      const why = said ?? (r.reason === 'mismatch' ? `its output lacks /${t.probe.match}/` : `the probe ${r.reason}`);
      return { problem: `${t.app} at ${checkout.path} is not ready: ${why}`, fix: t.probe.advice ?? null };
    }
    version = r.version;
  }
  return { checkout: checkout.path, exe, version };
}

/** The `problems` an app's probe printed as its last JSON line, joined; null if none. */
function appProblems(stdout) {
  const last = String(stdout).trim().split('\n').pop();
  try {
    const parsed = JSON.parse(last);
    return Array.isArray(parsed?.problems) && parsed.problems.length ? parsed.problems.join('; ') : null;
  } catch {
    return null;
  }
}
