#!/usr/bin/env node
/**
 * NeuroFlow adapter for an app's headless entry point (BIDSvue's
 * `scripts/neuroflow-ingest.ts`, ...).
 *
 * Some apps that NeuroFlow launches as interactive `uiApp` tools can also do
 * the same work without a window. The tool document describes that entry point
 * under `extensions["neuroflow/app-cli"]`; this script finds the app's checkout,
 * runs the app's readiness probe, runs the command there with the session
 * contract, and checks that the declared outputs appeared. The app itself
 * writes the handoff and its provenance line, exactly as its window flow does.
 *
 * Template fields:
 *   app                  app name; NEUROFLOW_UI_APP_<APP> overrides the checkout
 *   repo                 checkout directory name, looked for beside the NeuroFlow
 *                        checkout (the runtime's uiApp rule)
 *   branch (optional)    the branch that has the entry point, for messages
 *   entry                file that must exist in the checkout (the headless script);
 *                        a sibling directory without it is not the checkout
 *   command              executable name (searched on PATH last)
 *   paths[]              candidate install locations, tried in order (~ expands)
 *   env                  environment variable that overrides the executable
 *   args[]               strings with {{session}}, {{outputDir}} and {{workDir}}
 *   probe (optional)     { args, match, version, advice }, run in the checkout before
 *                        the job and by check_tool.mjs; the app's own readiness check
 *
 * Env: NEUROFLOW_SESSION / _OUTPUT_DIR / _WORK_DIR / _STEP (session contract).
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkInputsExist, failer, findToolDoc, readSession, resolveAppCli } from './adapter_lib.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fail = failer('app_cli');

const { session, ctx, inputs, outputDir, workDir } = readSession(fail);
const found = findToolDoc(ctx.tool, here);
if (!found) fail(`tool document ${ctx.tool} not found next to ${here}`);
const tool = found.doc;
const template = tool.extensions?.['neuroflow/app-cli'];
if (!template) fail(`${ctx.tool} has no extensions["neuroflow/app-cli"] template`);

// The same checks check_tool.mjs reports in the Environment panel.
const app = resolveAppCli(template, dirname(found.path));
if (app.problem) fail(app.fix ? `${app.problem}; ${app.fix}` : app.problem);
checkInputsExist(tool, inputs, fail);

const fill = (s) => String(s)
  .replaceAll('{{session}}', session)
  .replaceAll('{{outputDir}}', outputDir)
  .replaceAll('{{workDir}}', workDir);
const args = (template.args ?? []).map(fill);

if (app.version) console.log(`app_cli: ${template.app} ready (${app.version})`);
console.log(`app_cli: ${app.exe} ${args.join(' ')} (in ${app.checkout})`);
const child = spawn(app.exe, args, { cwd: app.checkout, stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('error', (e) => fail(`could not start ${app.exe}: ${e.message}`));
child.on('exit', (code, signal) => {
  if (signal) fail(`${template.app} was stopped by ${signal}`);
  if (code !== 0) fail(`${template.app} exited with code ${code}`);
  const missing = Object.entries(tool.outputs ?? {})
    .filter(([, o]) => !o.optional && o.delivery?.path && !existsSync(join(outputDir, o.delivery.path)))
    .map(([name, o]) => `${name} (${o.delivery.path})`);
  if (missing.length) fail(`${template.app} finished without writing ${missing.join(', ')}`);
});
