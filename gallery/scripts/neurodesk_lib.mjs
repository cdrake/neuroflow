/**
 * Helpers for the Neurodesk Webapps adapter (neurodesk_job.mjs):
 *
 *   readNiftiHeader     dims and voxel sizes from a NIfTI-1/2 file (.nii or .nii.gz)
 *   estimateGpuBuffer   the largest GPU buffer a Neurodesk U-Net app will ask for
 *   watchApp            follow a running app over the Chrome DevTools Protocol:
 *                       report its status line, apply page fixups, detect failure
 *   freePort            an unused TCP port for --remote-debugging-port
 */
import { closeSync, openSync, readSync } from 'node:fs';
import { createServer } from 'node:net';
import { constants as zlibConstants, gunzipSync } from 'node:zlib';

const GIB = 2 ** 30;
export const formatGiB = (bytes) => `${(bytes / GIB).toFixed(1)} GiB`;

/** Read the first `bytes` of a file, transparently gunzipping a gzip member. */
function readHead(path, bytes) {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const n = readSync(fd, buf, 0, bytes, 0);
    const head = buf.subarray(0, n);
    if (head[0] === 0x1f && head[1] === 0x8b) {
      // A truncated gzip stream still inflates up to the bytes we have.
      return gunzipSync(head, { finishFlush: zlibConstants.Z_SYNC_FLUSH });
    }
    return head;
  } finally {
    closeSync(fd);
  }
}

/**
 * Parse a NIfTI-1 or NIfTI-2 header. Returns { version, dims: [x, y, z], pixdims: [dx, dy, dz],
 * ndim } with dims and pixdims of the first three axes.
 */
export function readNiftiHeader(path) {
  const head = readHead(path, 64 * 1024);
  if (head.length < 348) throw new Error(`${path}: too short to be a NIfTI file`);
  const parse = (little) => {
    const sizeof = little ? head.readInt32LE(0) : head.readInt32BE(0);
    if (sizeof === 348) {
      const i16 = (o) => (little ? head.readInt16LE(o) : head.readInt16BE(o));
      const f32 = (o) => (little ? head.readFloatLE(o) : head.readFloatBE(o));
      const ndim = i16(40);
      return { version: 1, ndim, dims: [i16(42), i16(44), i16(46)], pixdims: [f32(80), f32(84), f32(88)] };
    }
    if (sizeof === 540) {
      if (head.length < 540) throw new Error(`${path}: truncated NIfTI-2 header`);
      const i64 = (o) => Number(little ? head.readBigInt64LE(o) : head.readBigInt64BE(o));
      const f64 = (o) => (little ? head.readDoubleLE(o) : head.readDoubleBE(o));
      const ndim = i64(16);
      return { version: 2, ndim, dims: [i64(24), i64(32), i64(40)], pixdims: [f64(112), f64(120), f64(128)] };
    }
    return null;
  };
  const hdr = parse(true) ?? parse(false);
  if (!hdr) throw new Error(`${path}: not a NIfTI-1 or NIfTI-2 header`);
  if (hdr.ndim < 1 || hdr.ndim > 7 || hdr.dims.some((d) => !Number.isSafeInteger(d) || d < 0)) {
    throw new Error(`${path}: unreadable NIfTI dimensions`);
  }
  hdr.dims = hdr.dims.map((d) => Math.max(1, d));
  hdr.pixdims = hdr.pixdims.map((p) => (Number.isFinite(p) && p > 0 ? p : 1));
  return hdr;
}

/**
 * Estimate the largest GPU buffer a Neurodesk U-Net app allocates for a volume.
 *
 * The app resamples the volume to `resampleMm` (SynthSeg: 1 mm), pads each axis up to a
 * multiple of `padMultiple` (32 for a five-level U-Net) and allocates float32 activations;
 * `bytesPerVoxel` is the widest activation (SynthSeg: 72 channels at full resolution = 288
 * bytes). The app refuses a plan whose largest buffer exceeds `maxBytes`.
 *
 * Returns { grid, voxels, bytes, ok, maxVoxels }.
 */
export function estimateGpuBuffer(hdr, { resampleMm = 1, padMultiple = 32, bytesPerVoxel, maxBytes }) {
  if (!(bytesPerVoxel > 0) || !(maxBytes > 0)) throw new Error('estimateGpuBuffer needs bytesPerVoxel and maxBytes');
  const grid = hdr.dims.map((d, i) => {
    const at1 = Math.max(1, Math.round((d * hdr.pixdims[i]) / resampleMm));
    return Math.ceil(at1 / padMultiple) * padMultiple;
  });
  const voxels = grid[0] * grid[1] * grid[2];
  const bytes = voxels * bytesPerVoxel;
  return { grid, voxels, bytes, ok: bytes <= maxBytes, maxVoxels: Math.floor(maxBytes / bytesPerVoxel) };
}

/** Pick an unused localhost TCP port. */
export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Follow a Neurodesk app running in the desktop suite through its DevTools port.
 *
 * Every `intervalMs` the page is asked for: the text of `statusSelector` (reported through
 * `onStatus` when it changes), whether `failure.selector` matches (the apps mark their status
 * line with class "error" when a run fails), and any `fixups` whose element now exists
 * (each sets one property on that element once, e.g. removing a duplicate click handler).
 *
 * Resolves with { attached, failure, fixups } when a failure is seen or `signal` aborts.
 * `failure` is the failing element's text, or null. Connection problems never throw: the
 * result just reports attached: false and the job proceeds on the suite's own timeout.
 */
export async function watchApp({
  port, app, signal, onStatus = () => {}, onLog = () => {},
  statusSelector = '#statusText', failure = { selector: '#statusText.error' }, fixups = [],
  intervalMs = 500, connectTimeoutMs = 60000,
}) {
  const result = { attached: false, failure: null, fixups: [] };
  if (typeof WebSocket === 'undefined') {
    onLog('this Node has no WebSocket (need Node 22+); not watching the app for errors');
    return result;
  }
  const probe = `(() => {
    const out = { status: null, failure: null, fixups: [] };
    const fixups = ${JSON.stringify(fixups)};
    for (let i = 0; i < fixups.length; i++) {
      const el = document.querySelector(fixups[i].selector);
      if (el && !el.dataset['neuroflowFixup' + i]) {
        el[fixups[i].property] = fixups[i].value ?? null;
        el.dataset['neuroflowFixup' + i] = '1';
        out.fixups.push(i);
      }
    }
    const status = document.querySelector(${JSON.stringify(statusSelector)});
    if (status) out.status = (status.textContent || '').trim();
    const bad = document.querySelector(${JSON.stringify(failure.selector)});
    if (bad) out.failure = (bad.textContent || '').trim() || 'error';
    return JSON.stringify(out);
  })()`;

  // Find the app's page target.
  const deadline = Date.now() + connectTimeoutMs;
  let page = null;
  while (!page && !signal.aborted && Date.now() < deadline) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const pages = targets.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      page = pages.find((t) => app && new URL(t.url).pathname.startsWith(`/${app}/`)) ?? pages[0] ?? null;
    } catch { /* the suite is still starting */ }
    if (!page) await sleep(intervalMs);
  }
  if (!page) {
    if (!signal.aborted) onLog(`could not reach the suite's DevTools port ${port}; not watching the app for errors`);
    return result;
  }

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  try {
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('websocket error')); });
  } catch (e) {
    onLog(`could not attach to the app page (${e.message}); not watching the app for errors`);
    return result;
  }
  result.attached = true;
  let nextId = 0;
  const pending = new Map();
  ws.onmessage = ({ data }) => {
    const m = JSON.parse(data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  let closed = false;
  ws.onclose = () => { closed = true; for (const r of pending.values()) r(null); pending.clear(); };
  const evaluate = () => new Promise((resolve) => {
    if (closed) return resolve(null);
    const id = ++nextId;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: probe, returnByValue: true } }));
  });

  let lastStatus = null;
  try {
    while (!signal.aborted && !closed) {
      const reply = await evaluate();
      const value = reply?.result?.result?.value;
      if (typeof value === 'string') {
        const out = JSON.parse(value);
        for (const i of out.fixups) {
          result.fixups.push(fixups[i]);
          onLog(`applied page fixup: ${fixups[i].selector}.${fixups[i].property} (${fixups[i].reason ?? 'no reason given'})`);
        }
        if (out.status !== null && out.status !== lastStatus) { lastStatus = out.status; onStatus(out.status); }
        if (out.failure !== null) { result.failure = out.failure; break; }
      }
      await sleep(intervalMs);
    }
  } finally {
    try { ws.close(); } catch { /* already closed */ }
  }
  return result;
}
