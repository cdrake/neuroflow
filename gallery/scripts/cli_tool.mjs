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
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  appendProvenance, checkInputsExist, failer, findExecutable, findToolDoc, hasValue, mapOutputs, readSession,
} from './adapter_lib.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fail = failer('cli_tool');

const { session, ctx, inputs, step, outputDir, workDir } = readSession(fail);

// Locate the tool document for this step.
const tool = findToolDoc(ctx.tool, here)?.doc;
if (!tool) fail(`tool document ${ctx.tool} not found next to ${here}`);
const template = tool.extensions?.['neuroflow/cli'];
if (!template) fail(`${ctx.tool} has no extensions["neuroflow/cli"] template`);

// Find the executable: override variable, candidate paths, then PATH.
const exe = findExecutable(template, fail);
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
checkInputsExist(tool, inputs, fail);

// Fill the argument template.
const has = (name) => hasValue(inputs, name);
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
const produced = mapOutputs(tool, template.outputs, outputDir, fail, { label: template.command });

appendProvenance(session, {
  step, tool: tool.id, agent: version ? `${template.command} ${version}` : template.command,
  action: 'cli', executable: exe, args, durationMs: Date.now() - started, outputs: produced,
});
console.log(`cli_tool: ${template.command} finished in ${((Date.now() - started) / 1000).toFixed(1)} s`);
