#!/usr/bin/env node
/**
 * NeuroFlow adapter for native command-line tools (dcm2niix, niimath, brainchop, ...).
 *
 * A tool document describes the command under `extensions["neuroflow/cli"]`;
 * this script fills the argument template from the session inputs, runs the
 * command, and maps the files it wrote to the tool's declared outputs. It is
 * the native-only counterpart of the `native` block in neurodesk_job.mjs.
 *
 * Template fields:
 *   command              executable name (searched on PATH last)
 *   paths[]              candidate install locations, tried in order (~ expands)
 *   env                  environment variable that overrides the location
 *   probe (optional)     { args, match, advice, version }: run the executable with
 *                        `args` before the job and fail with `advice` unless its
 *                        output matches the `match` regex (e.g. an old release
 *                        lacking an operation); `version` is a regex whose match is
 *                        recorded in provenance
 *   args[]               strings with {{input}}, {{outputDir}} and {{workDir}}
 *                        placeholders, or conditional groups:
 *                          { "arg": "--fast", "when": { "mode": "fast" } }
 *                          { "args": ["-weight", "{{weight}}"], "whenSet": "weight" }
 *                        `when` keeps the group when every listed input equals the
 *                        value; `whenSet` keeps it when that input has a value
 *   outputs{}            name -> file the command writes in the output dir, or
 *                        name -> { match, pick } to find it by regex over the
 *                        output dir (pick: "first" | "largest"; default: exactly
 *                        one match). The file is renamed to the output's
 *                        declared delivery.path.
 *   cwd (optional)       "outputDir" | "workDir" (default workDir)
 *   clearEnv (optional)  environment-variable names withheld from the command
 *
 * Env: NEUROFLOW_SESSION / _OUTPUT_DIR / _WORK_DIR / _STEP (session contract),
 * plus the template's own override variable.
 */
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const fail = (message) => {
  console.error(`cli_tool: ${message}`);
  process.exit(1);
};

const session = process.env.NEUROFLOW_SESSION;
if (!session) fail('NEUROFLOW_SESSION is not set; run this through a NeuroFlow runtime');
const ctx = JSON.parse(readFileSync(join(session, 'context.json'), 'utf8'));
const inputs = ctx.inputs ?? {};
const step = process.env.NEUROFLOW_STEP || ctx.step || 'cli';
const outputDir = process.env.NEUROFLOW_OUTPUT_DIR || ctx.outputDir;
const workDir = process.env.NEUROFLOW_WORK_DIR || ctx.workDir || session;

// Locate the tool document for this step.
function findToolDoc(id) {
  if (process.env.NEUROFLOW_TOOL_DOC) return JSON.parse(readFileSync(process.env.NEUROFLOW_TOOL_DOC, 'utf8'));
  const stack = [join(here, '..', 'tools')];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(path);
      else if (entry.name.endsWith('.json')) {
        try {
          const doc = JSON.parse(readFileSync(path, 'utf8'));
          if (doc.kind === 'tool' && doc.id === id) return doc;
        } catch { /* not a tool document */ }
      }
    }
  }
  return null;
}
const tool = findToolDoc(ctx.tool);
if (!tool) fail(`tool document ${ctx.tool} not found next to ${here}`);
const template = tool.extensions?.['neuroflow/cli'];
if (!template) fail(`${ctx.tool} has no extensions["neuroflow/cli"] template`);

// Find the executable: override variable, candidate paths, then PATH.
const expand = (p) => (p.startsWith('~/') ? join(homedir(), p.slice(2)) : p);
function findExecutable(t) {
  if (t.env && process.env[t.env]) {
    const p = expand(process.env[t.env]);
    if (!existsSync(p)) fail(`${t.env}=${p} does not exist`);
    return p;
  }
  for (const p of (t.paths ?? []).map(expand)) if (existsSync(p)) return p;
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir && existsSync(join(dir, t.command))) return join(dir, t.command);
  }
  return null;
}
const exe = findExecutable(template);
if (!exe) {
  fail(`${template.command} was not found${template.env ? ` (set ${template.env} to its path)` : ''}; ` +
    `looked in ${(template.paths ?? []).join(', ') || 'no fixed locations'} and on PATH`);
}

// Commands occasionally reuse generic environment names with incompatible
// meanings (for example, tinygrad expects DEBUG to be an integer). A trusted
// tool template can opt out of forwarding such variables without changing the
// ambient environment of the runtime or other tools.
const childEnv = { ...process.env };
for (const name of template.clearEnv ?? []) delete childEnv[name];

// Probe the release before running.
let version = null;
if (template.probe) {
  const p = template.probe;
  const r = spawnSync(exe, p.args ?? [], { encoding: 'utf8', env: childEnv });
  const text = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
  // A matching banner is proof enough: some tools exit non-zero after printing
  // their version (dcm2niix -v returns 3), so a bad status only counts when the
  // output does not match either.
  const matched = p.match ? new RegExp(p.match).test(text) : r.status === 0;
  if (r.error || (!matched && r.status !== 0)) {
    const status = r.error ? 'could not start' : r.status;
    fail(`${exe} probe exited with status ${status}. ${p.advice ?? ''}`.trim());
  }
  if (!matched) {
    fail(`${exe} does not look like a usable ${template.command}: output lacks /${p.match}/. ${p.advice ?? ''}`.trim());
  }
  if (p.version) version = new RegExp(p.version).exec(text)?.[0] ?? null;
}

// File and folder inputs must exist before the command runs, so a broken
// reference fails here with the input's name rather than as the tool's own error.
const SCALAR = new Set(['core:string', 'core:integer', 'core:number', 'core:boolean', 'core:object']);
for (const [name, decl] of Object.entries(tool.inputs ?? {})) {
  const v = inputs[name];
  if (v === undefined || v === null || SCALAR.has(decl.type) || typeof decl.type !== 'string') continue;
  for (const p of Array.isArray(v) ? v : [v]) {
    if (typeof p === 'string' && p !== '' && !existsSync(p)) fail(`input ${name} (${decl.type}) does not exist: ${p}`);
  }
}

// Fill the argument template.
const has = (name) => inputs[name] !== undefined && inputs[name] !== null && inputs[name] !== '';
const fill = (value) => value.replace(/\{\{([A-Za-z0-9_-]+)\}\}/g, (_, name) => {
  if (name === 'outputDir') return outputDir;
  if (name === 'workDir') return workDir;
  if (!has(name)) fail(`argument template references input ${name}, which has no value`);
  const v = inputs[name];
  return Array.isArray(v) ? v.join(',') : String(v);
});
const keep = (a) => {
  if (a.whenSet && !has(a.whenSet)) return false;
  if (a.when && !Object.entries(a.when).every(([name, expected]) => inputs[name] === expected)) return false;
  return true;
};
const args = (template.args ?? []).flatMap((a) => {
  if (typeof a === 'string') return [fill(a)];
  if (!keep(a)) return [];
  return (a.args ?? [a.arg]).map(fill);
});

// Run.
mkdirSync(outputDir, { recursive: true });
const cwd = template.cwd === 'outputDir' ? outputDir : workDir;
mkdirSync(cwd, { recursive: true });
console.log(`cli_tool: running ${exe} ${args.join(' ')}`);
const started = Date.now();
const status = await new Promise((resolve) => {
  const child = spawn(exe, args, { cwd, env: childEnv, stdio: ['ignore', 'inherit', 'inherit'] });
  child.on('error', (err) => { console.error(`cli_tool: ${err.message}`); resolve(127); });
  child.on('exit', (c, signal) => resolve(c ?? (signal ? 128 : 1)));
});
if (status !== 0) fail(`${template.command} exited with status ${status}`);

// Map what the command wrote to the declared outputs.
const produced = {};
const written = readdirSync(outputDir).filter((f) => statSync(join(outputDir, f)).isFile());
for (const [name, spec] of Object.entries(template.outputs ?? {})) {
  const decl = tool.outputs?.[name];
  let file = null;
  if (typeof spec === 'string') {
    if (existsSync(join(outputDir, spec))) file = spec;
  } else {
    const re = new RegExp(spec.match);
    const hits = written.filter((f) => re.test(f)).sort();
    if (hits.length === 1 || (hits.length > 1 && spec.pick === 'first')) file = hits[0];
    else if (hits.length > 1 && spec.pick === 'largest') {
      file = hits.map((f) => [f, statSync(join(outputDir, f)).size]).sort((a, b) => b[1] - a[1])[0][0];
    } else if (hits.length > 1) fail(`output ${name}: ${hits.length} files match /${spec.match}/ (${hits.join(', ')}); set pick`);
  }
  if (!file) {
    if (decl?.optional) continue;
    fail(`${template.command} did not write output ${name} (${typeof spec === 'string' ? spec : `/${spec.match}/`}); ` +
      `output dir holds: ${written.join(', ') || 'nothing'}`);
  }
  const target = decl?.delivery?.path ?? file;
  if (target !== file) {
    mkdirSync(dirname(join(outputDir, target)), { recursive: true });
    renameSync(join(outputDir, file), join(outputDir, target));
    console.log(`cli_tool: ${file} -> ${name} (${target})`);
  }
  produced[name] = target;
}

appendFileSync(join(session, 'provenance.jsonl'), JSON.stringify({
  ts: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  step, tool: tool.id, agent: version ? `${template.command} ${version}` : template.command,
  action: 'cli', executable: exe, args, durationMs: Date.now() - started, outputs: produced,
}) + '\n');
console.log(`cli_tool: ${template.command} finished in ${((Date.now() - started) / 1000).toFixed(1)} s`);
