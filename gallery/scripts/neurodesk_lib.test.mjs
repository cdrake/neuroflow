// npm run test:gallery   (node --test "gallery/scripts/*.test.mjs")
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { estimateGpuBuffer, formatGiB, readNiftiHeader } from './neurodesk_lib.mjs';

const SYNTHSEG = { resampleMm: 1, padMultiple: 32, bytesPerVoxel: 288, maxBytes: 2 ** 31 - 1 };
const dir = mkdtempSync(join(tmpdir(), 'neurodesk-lib-'));

/** Minimal NIfTI-1 header (348 bytes, little-endian) with the given dims and voxel sizes. */
function nifti1(dims, pixdims, { little = true } = {}) {
  const b = Buffer.alloc(352);
  const w32 = (o, v) => (little ? b.writeInt32LE(v, o) : b.writeInt32BE(v, o));
  const w16 = (o, v) => (little ? b.writeInt16LE(v, o) : b.writeInt16BE(v, o));
  const wf = (o, v) => (little ? b.writeFloatLE(v, o) : b.writeFloatBE(v, o));
  w32(0, 348);
  w16(40, dims.length);
  dims.forEach((d, i) => w16(42 + 2 * i, d));
  wf(76, 1);
  pixdims.forEach((p, i) => wf(80 + 4 * i, p));
  w16(70, 4); // float32
  w16(72, 32);
  w32(108, 352);
  b.write('n+1\0', 344, 'latin1');
  return b;
}

/** Minimal NIfTI-2 header (540 bytes, little-endian). */
function nifti2(dims, pixdims) {
  const b = Buffer.alloc(544);
  b.writeInt32LE(540, 0);
  b.write('n+2\0\r\n\x1a\n', 4, 'latin1');
  b.writeBigInt64LE(BigInt(dims.length), 16);
  dims.forEach((d, i) => b.writeBigInt64LE(BigInt(d), 24 + 8 * i));
  pixdims.forEach((p, i) => b.writeDoubleLE(p, 112 + 8 * i));
  return b;
}

test('reads a NIfTI-1 header, plain and gzipped', () => {
  const raw = join(dir, 'a.nii');
  writeFileSync(raw, nifti1([192, 256, 256], [1, 1, 1]));
  assert.deepEqual(readNiftiHeader(raw), { version: 1, ndim: 3, dims: [192, 256, 256], pixdims: [1, 1, 1] });
  const gz = join(dir, 'a.nii.gz');
  // Pad with voxel bytes so the gzip member is longer than what the reader inflates.
  writeFileSync(gz, gzipSync(Buffer.concat([nifti1([96, 128, 128], [2, 2, 2]), Buffer.alloc(200 * 1024)])));
  assert.deepEqual(readNiftiHeader(gz).dims, [96, 128, 128]);
  assert.deepEqual(readNiftiHeader(gz).pixdims, [2, 2, 2]);
});

test('reads big-endian NIfTI-1 and NIfTI-2 headers', () => {
  const be = join(dir, 'be.nii');
  writeFileSync(be, nifti1([10, 20, 30], [0.5, 0.5, 2], { little: false }));
  assert.deepEqual(readNiftiHeader(be).dims, [10, 20, 30]);
  assert.deepEqual(readNiftiHeader(be).pixdims, [0.5, 0.5, 2]);
  const n2 = join(dir, 'n2.nii');
  writeFileSync(n2, nifti2([64, 64, 40, 100], [0.7, 0.7, 1.4, 2]));
  assert.deepEqual(readNiftiHeader(n2), { version: 2, ndim: 4, dims: [64, 64, 40], pixdims: [0.7, 0.7, 1.4] });
});

test('rejects files that are not NIfTI', () => {
  const bad = join(dir, 'bad.nii');
  writeFileSync(bad, Buffer.alloc(400, 7));
  assert.throws(() => readNiftiHeader(bad), /not a NIfTI/);
  const short = join(dir, 'short.nii');
  writeFileSync(short, Buffer.alloc(10));
  assert.throws(() => readNiftiHeader(short), /too short/);
});

test('SynthSeg estimate matches what the web app reports', () => {
  // The suite reported "needs a 3.4 GiB GPU buffer" for these three (see docs/neurodesk-webapps.md).
  for (const [dims, pix] of [[[192, 256, 256], [1, 1, 1]], [[96, 128, 128], [2, 2, 2]]]) {
    const est = estimateGpuBuffer({ dims, pixdims: pix }, SYNTHSEG);
    assert.deepEqual(est.grid, [192, 256, 256]);
    assert.equal(formatGiB(est.bytes), '3.4 GiB');
    assert.equal(est.ok, false);
  }
  const small = estimateGpuBuffer({ dims: [128, 160, 160], pixdims: [1, 1, 1] }, SYNTHSEG);
  assert.equal(small.ok, true);
  assert.equal(formatGiB(small.bytes), '0.9 GiB');
  assert.equal(small.maxVoxels, 7456540);
});

test('estimate resamples to the target grid and pads to the multiple', () => {
  const est = estimateGpuBuffer({ dims: [100, 100, 100], pixdims: [1, 1, 1] }, SYNTHSEG);
  assert.deepEqual(est.grid, [128, 128, 128]);
  // 0.8 mm voxels: 200 * 0.8 = 160 at 1 mm, already a multiple of 32.
  assert.deepEqual(estimateGpuBuffer({ dims: [200, 200, 200], pixdims: [0.8, 0.8, 0.8] }, SYNTHSEG).grid, [160, 160, 160]);
  // A typical 1 mm MPRAGE does not fit the web app.
  assert.equal(estimateGpuBuffer({ dims: [176, 256, 256], pixdims: [1, 1, 1] }, SYNTHSEG).ok, false);
  assert.throws(() => estimateGpuBuffer({ dims: [1, 1, 1], pixdims: [1, 1, 1] }, {}), /bytesPerVoxel/);
});
