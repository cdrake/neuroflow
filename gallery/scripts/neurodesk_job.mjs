#!/usr/bin/env node
/**
 * NeuroFlow adapter for Neurodesk Webapps batch jobs.
 *
 * Runs any Neurodesk web app headless through the desktop suite's job mode
 * (`neurodesk-webapps --job job.json --output DIR`, see neurodesk/webapps
 * packages/desktop/STANDALONE.md). The tool document supplies a job template
 * under `extensions["neurodesk/job"]`; this script fills it from the session
 * inputs, runs the app, and maps the downloaded files to the tool's declared
 * outputs.
 *
 * Template fields:
 *   app, expectedDownloads, timeoutMs   as in the Neurodesk job contract
 *   steps[]                             Neurodesk job steps; strings may contain
 *                                       {{input}} placeholders; a step with
 *                                       "when": { input: value } is kept only
 *                                       when every listed input equals value
 *   outputs{ name: { match } }          regex applied to downloaded filenames
 *   native (optional)                   a native CLI that runs the same method:
 *     command, paths[], env             executable name, install paths, and an
 *                                       env var that overrides its location
 *     args[]                            strings with {{input}} / {{outputDir}},
 *                                       or { "arg": "--fast", "when": {...} }
 *     outputs{ name: file }             files the CLI writes in the output dir
 *
 * Engine choice: NEURODESK_ENGINE=native|app|auto (default auto: the native
 * CLI when it is installed, otherwise the web app through the desktop suite).
 *
 * Env:
 *   NEUROFLOW_SESSION / _OUTPUT_DIR / _WORK_DIR / _STEP   session contract
 *   NEURODESK_WEBAPPS   path to the neurodesk-webapps executable (optional;
 *                       common install locations are searched otherwise)
 *   NEURODESK_MODELS_DIR  passed through to the app for offline model packs
 */
import { spawn } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const fail = (message) => {
  console.error(`neurodesk_job: ${message}`);
  process.exit(1);
};

const session = process.env.NEUROFLOW_SESSION;
if (!session) fail('NEUROFLOW_SESSION is not set; run this through a NeuroFlow runtime');
const ctx = JSON.parse(readFileSync(join(session, 'context.json'), 'utf8'));
const inputs = ctx.inputs ?? {};
const step = process.env.NEUROFLOW_STEP || ctx.step || 'neurodesk';
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
const template = tool.extensions?.['neurodesk/job'];
if (!template) fail(`${ctx.tool} has no extensions["neurodesk/job"] template`);

// Fill the template.
const fill = (value) => {
  if (typeof value === 'string') {
    return value.replace(/\{\{([A-Za-z0-9_-]+)\}\}/g, (_, name) => {
      if (!(name in inputs)) fail(`template references input ${name}, which has no value`);
      const v = inputs[name];
      return Array.isArray(v) ? v.join(',') : String(v);
    });
  }
  if (Array.isArray(value)) return value.flatMap((item) => {
    // A whole-string placeholder for an array input expands to every element.
    const m = typeof item === 'string' && /^\{\{([A-Za-z0-9_-]+)\}\}$/.exec(item);
    if (m && Array.isArray(inputs[m[1]])) return inputs[m[1]].map(String);
    return [fill(item)];
  });
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v)]));
  return value;
};
const keep = (s) => !s.when || Object.entries(s.when).every(([name, expected]) => inputs[name] === expected);
const steps = template.steps.filter(keep).map(({ when, ...s }) => fill(s));
for (const s of steps) {
  if (s.action === 'upload') {
    for (const p of s.paths) {
      if (!isAbsolute(p) || !existsSync(p) || !statSync(p).isFile()) fail(`upload input is not a file: ${p}`);
    }
  }
}
const job = {
  schemaVersion: 1,
  app: template.app,
  expectedDownloads: template.expectedDownloads,
  ...(template.timeoutMs ? { timeoutMs: template.timeoutMs } : {}),
  steps,
};

// Native CLI path (preferred when installed).
function findNative(native) {
  if (!native) return null;
  if (native.env && process.env[native.env]) {
    const p = process.env[native.env];
    if (!existsSync(p)) fail(`${native.env}=${p} does not exist`);
    return p;
  }
  for (const p of native.paths ?? []) if (existsSync(p)) return p;
  for (const dir of (process.env.PATH || '').split(':')) {
    if (dir && existsSync(join(dir, native.command))) return join(dir, native.command);
  }
  return null;
}
const engine = (process.env.NEURODESK_ENGINE || 'auto').toLowerCase();
const nativeExe = engine === 'app' ? null : findNative(template.native);
if (engine === 'native' && !nativeExe) fail(`NEURODESK_ENGINE=native but ${template.native?.command ?? 'no native command'} was not found`);
if (nativeExe) {
  const native = template.native;
  mkdirSync(outputDir, { recursive: true });
  const args = native.args.filter((a) => typeof a === 'string' || keep(a)).map((a) => {
    const raw = typeof a === 'string' ? a : a.arg;
    return fill(raw.replaceAll('{{outputDir}}', outputDir));
  });
  console.log(`neurodesk_job: running native ${nativeExe} ${args.join(' ')}`);
  const status = await new Promise((resolve) => {
    const child = spawn(nativeExe, args, { stdio: ['ignore', 'inherit', 'inherit'] });
    child.on('error', (err) => { console.error(`neurodesk_job: ${err.message}`); resolve(127); });
    child.on('exit', (c, signal) => resolve(c ?? (signal ? 128 : 1)));
  });
  if (status !== 0) fail(`${native.command} exited with status ${status}`);
  const produced = {};
  for (const [name, file] of Object.entries(native.outputs ?? {})) {
    if (!existsSync(join(outputDir, file))) {
      if (tool.outputs?.[name]?.optional) continue;
      fail(`${native.command} did not write ${file} for output ${name}`);
    }
    produced[name] = file;
  }
  appendFileSync(join(session, 'provenance.jsonl'), JSON.stringify({
    ts: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    step, tool: tool.id, agent: `${native.command} (native)`,
    action: 'neurodesk-native', executable: nativeExe, args, outputs: produced,
  }) + '\n');
  process.exit(0);
}

// Locate the desktop executable.
function findExecutable() {
  const env = process.env.NEURODESK_WEBAPPS;
  if (env) {
    if (!existsSync(env)) fail(`NEURODESK_WEBAPPS=${env} does not exist`);
    return env;
  }
  const bundles = ['neurodesk-webapps.app', 'Neurodesk Webapps.app'];
  const roots = ['/Applications', join(homedir(), 'Applications'), join(homedir(), 'Downloads')];
  for (const root of roots) {
    for (const bundle of bundles) {
      const exe = join(root, bundle, 'Contents', 'MacOS', 'neurodesk-webapps');
      if (existsSync(exe)) return exe;
    }
  }
  for (const dir of (process.env.PATH || '').split(':')) {
    for (const name of ['neurodesk-webapps', 'neurodesk-webapps.exe']) {
      if (dir && existsSync(join(dir, name))) return join(dir, name);
    }
  }
  const container = existsSync('/Applications/NeurodeskApp.app')
    ? ' NeurodeskApp.app is installed, but that is the container-based Neurodesk desktop; this tool needs the separate Neurodesk Webapps suite.'
    : '';
  fail('neurodesk-webapps was not found.' + container + ' Download the Neurodesk Webapps suite from the webapps-v* releases at https://github.com/neurodesk/webapps/releases, move neurodesk-webapps.app to /Applications, or set NEURODESK_WEBAPPS to its executable, e.g. /Applications/neurodesk-webapps.app/Contents/MacOS/neurodesk-webapps');
}
const executable = findExecutable();

const jobDir = join(workDir, `neurodesk-${step}-${Date.now()}`);
mkdirSync(jobDir, { recursive: true });
const jobPath = join(jobDir, 'job.json');
const resultsDir = join(jobDir, 'results');
writeFileSync(jobPath, JSON.stringify(job, null, 2) + '\n');
console.log(`neurodesk_job: running ${template.app} via ${executable}`);

const code = await new Promise((resolve) => {
  const child = spawn(executable, ['--job', jobPath, '--output', resultsDir], { stdio: ['ignore', 'inherit', 'inherit'] });
  child.on('error', (err) => { console.error(`neurodesk_job: ${err.message}`); resolve(127); });
  child.on('exit', (c, signal) => resolve(c ?? (signal ? 128 : 1)));
});
if (code !== 0) fail(`${template.app} job exited with status ${code}; see the log above (job: ${jobPath})`);

// Map downloads to declared outputs.
const resultFile = join(resultsDir, 'job-result.json');
const downloads = existsSync(resultFile) ? JSON.parse(readFileSync(resultFile, 'utf8')).downloads.map((d) => d.filename) : [];
mkdirSync(outputDir, { recursive: true });
const produced = {};
for (const [name, rule] of Object.entries(template.outputs ?? {})) {
  const decl = tool.outputs?.[name];
  if (!decl) fail(`template maps undeclared output ${name}`);
  const re = new RegExp(rule.match);
  const hit = downloads.find((f) => re.test(f));
  if (!hit) {
    if (decl.optional) continue;
    fail(`no download matched ${rule.match} for output ${name}; downloads: ${downloads.join(', ') || 'none'}`);
  }
  const target = decl.delivery?.path || hit;
  copyFileSync(join(resultsDir, hit), join(outputDir, target));
  produced[name] = target;
  console.log(`neurodesk_job: ${hit} -> ${name} (${target})`);
}

appendFileSync(join(session, 'provenance.jsonl'), JSON.stringify({
  ts: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  step, tool: tool.id, agent: `neurodesk-webapps:${template.app}`,
  action: 'neurodesk-job', executable: basename(executable), job: jobPath, outputs: produced,
}) + '\n');
