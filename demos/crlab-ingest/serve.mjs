#!/usr/bin/env node
/**
 * Serves the crlab-ingest deck and lets the "Live demo" slide launch the
 * NeuroFlow desktop builder (`npm run tauri:dev` in this checkout).
 *
 *   node demos/crlab-ingest/serve.mjs --dicom <dicom-folder> [--qa <qa-page-dir>] [--port 4173]
 *
 * Endpoints used by slides.md:
 *   GET  /            the deck (slides.md rendered with marp --html at startup)
 *   GET  /config      { dicomDir, qa }
 *   GET  /status      { state, pid, external, ownsProcess, tail }
 *   POST /launch      start `npm run tauri:dev` unless the desktop app already runs
 *   POST /stop        stop the process this server started
 *   GET  /qa/*        the QA page directory given with --qa
 */
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync, createReadStream, openSync } from 'node:fs';
import { join, resolve, dirname, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const args = parseArgs(process.argv.slice(2));
const port = Number(args.port ?? process.env.PORT ?? 4173);
const dicomDir = args.dicom ?? process.env.NEUROFLOW_DEMO_DICOM ?? '';
const qaDir = args.qa ? resolve(args.qa) : '';
const logPath = join(here, 'launch.log');
const appBinary = join(repoRoot, 'target', 'debug', 'neuroflow-tauri');

if (args.help) {
  console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0].replace(/^\/\*\*?/, ''));
  process.exit(0);
}

buildDeck();

/** @type {{ child: import('node:child_process').ChildProcess | null, startedAt: string, failed: boolean }} */
const launch = { child: null, startedAt: '', failed: false };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      return sendFile(res, join(here, 'slides.html'), 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && url.pathname === '/config') {
      return json(res, { dicomDir, qa: Boolean(qaDir && existsSync(join(qaDir, 'index.html'))), repoRoot });
    }
    if (req.method === 'GET' && url.pathname === '/status') return json(res, status());
    if (req.method === 'POST' && url.pathname === '/launch') return json(res, startApp());
    if (req.method === 'POST' && url.pathname === '/stop') return json(res, stopApp());
    if (req.method === 'GET' && url.pathname.startsWith('/qa/') && qaDir) {
      return sendFile(res, safeJoin(qaDir, url.pathname.slice(4)));
    }
    if (req.method === 'GET' && url.pathname.startsWith('/assets/')) {
      return sendFile(res, safeJoin(join(here, 'assets'), url.pathname.slice(8)));
    }
    res.writeHead(404).end('not found');
  } catch (err) {
    res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: String(err) }));
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`deck:      http://127.0.0.1:${port}/`);
  console.log(`dicom_dir: ${dicomDir || '(none; pass --dicom)'}`);
  console.log(`qa page:   ${qaDir || '(none; pass --qa)'}`);
  console.log(`launches:  npm run tauri:dev in ${repoRoot}`);
});

function buildDeck() {
  const marp = join(repoRoot, 'node_modules', '.bin', 'marp');
  if (!existsSync(marp)) {
    console.warn('marp not found; run npm install in the repo root. Serving an existing slides.html if present.');
    return;
  }
  const out = spawnSync(marp, ['slides.md', '--html', '-o', 'slides.html'], { cwd: here, encoding: 'utf8' });
  if (out.status !== 0) console.warn(`marp failed:\n${out.stderr}`);
  else console.log('built slides.html');
}

function externalPid() {
  const out = spawnSync('pgrep', ['-f', 'target/(debug|release)/neuroflow-tauri$'], { encoding: 'utf8' });
  const pid = out.stdout.trim().split('\n').filter(Boolean)[0];
  return pid ? Number(pid) : null;
}

function status() {
  const own = launch.child && launch.child.exitCode === null ? launch.child : null;
  const appPid = externalPid();
  let state = 'stopped';
  if (appPid) state = 'running';
  else if (own) state = 'starting';
  else if (launch.failed) state = 'failed';
  return {
    state,
    pid: appPid ?? own?.pid ?? null,
    external: Boolean(appPid && !own),
    ownsProcess: Boolean(own),
    startedAt: launch.startedAt || null,
    tail: tail(logPath, 12),
  };
}

function startApp() {
  const current = status();
  if (current.state === 'running' || current.state === 'starting') return current;
  const fd = openSync(logPath, 'w');
  const env = { ...process.env };
  if (dicomDir) env.NEUROFLOW_DEMO_DICOM = dicomDir;
  const child = spawn('npm', ['run', 'tauri:dev'], { cwd: repoRoot, env, detached: true, stdio: ['ignore', fd, fd] });
  launch.child = child;
  launch.startedAt = new Date().toISOString();
  launch.failed = false;
  child.on('exit', (code) => {
    if (code !== 0 && code !== null) launch.failed = true;
  });
  child.unref();
  return status();
}

function stopApp() {
  const child = launch.child;
  if (child && child.exitCode === null && child.pid) {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch { /* gone */ } }
    setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } }, 3000).unref();
  }
  return status();
}

function tail(path, n) {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, 'utf8').replace(/\u001b\[[0-9;]*[A-Za-z]|\u001b\]8;;[^\u0007\u001b]*(\u0007|\u001b\\)/g, '');
  return text.split(/\r?\n/).filter(Boolean).slice(-n);
}

function json(res, body) {
  res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(body));
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.gz': 'application/gzip', '.nii': 'application/octet-stream', '.json': 'application/json', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml' };

function sendFile(res, path, type) {
  if (!path || !existsSync(path) || !statSync(path).isFile()) return res.writeHead(404).end('not found');
  res.writeHead(200, { 'content-type': type ?? TYPES[extname(path)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
  createReadStream(path).pipe(res);
}

function safeJoin(root, rel) {
  const target = normalize(join(root, decodeURIComponent(rel)));
  return target.startsWith(root) ? target : null;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a.startsWith('--')) { out[a.slice(2)] = argv[i + 1]; i += 1; }
  }
  return out;
}
