// npm run test:gallery   (node --test "gallery/scripts/*.test.mjs")
// The dti-fit tool through python_tool.mjs and its real tool document. Runs only
// when python3 can import dipy and nibabel; the DWI is synthesised from a single
// known tensor with the Stejskal-Tanner equation, so FA and MD are known exactly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const adapter = join(here, 'python_tool.mjs');
const toolDoc = join(here, '..', 'tools', 'dti-fit.tool.json');
const root = mkdtempSync(join(tmpdir(), 'dti-fit-'));

const python3 = spawnSync('which', ['python3'], { encoding: 'utf8' }).stdout.trim() || null;
const hasDipy = python3 && spawnSync(python3, ['-c', 'import dipy, nibabel, numpy'], { encoding: 'utf8' }).status === 0;
const skip = !hasDipy && 'python3 cannot import dipy (pip install dipy to run this tier)';

// Eigenvalues 1.7, 0.3, 0.3 (x1e-3 mm^2/s): FA = 0.7990, MD = 0.7667e-3.
const EXPECTED_FA = 0.7990;
const EXPECTED_MD = 0.76667e-3;

// Synthesise the dataset with numpy/nibabel: 6x6x6 voxels, 1 b0 + 20 directions at b=1000,
// tensor diag(1.7, 0.3, 0.3)e-3 rotated 30 degrees about z, S0 = 1000, no noise. Also a mask
// of the 4x4x4 interior, an FSL bval/bvec pair, and the same table as MRtrix .b.
function synthesise() {
  const gen = `
import json, numpy as np, nibabel as nib, sys
out = sys.argv[1]
rng = np.random.RandomState(0)
dirs = rng.normal(size=(20, 3)); dirs /= np.linalg.norm(dirs, axis=1)[:, None]
bvecs = np.vstack([[0, 0, 0], dirs]); bvals = np.array([0] + [1000] * 20, dtype=float)
th = np.deg2rad(30); R = np.array([[np.cos(th), -np.sin(th), 0], [np.sin(th), np.cos(th), 0], [0, 0, 1]])
D = R @ np.diag([1.7e-3, 0.3e-3, 0.3e-3]) @ R.T
S0 = 1000.0
sig = np.array([S0 * np.exp(-b * g @ D @ g) for b, g in zip(bvals, bvecs)], dtype=np.float32)
data = np.zeros((6, 6, 6, 21), dtype=np.float32); data[...] = sig
mask = np.zeros((6, 6, 6), dtype=np.uint8); mask[1:5, 1:5, 1:5] = 1
aff = np.diag([2.0, 2.0, 2.0, 1.0])
nib.save(nib.Nifti1Image(data, aff), f"{out}/dwi.nii.gz")
nib.save(nib.Nifti1Image(mask, aff), f"{out}/mask.nii.gz")
nib.save(nib.Nifti1Image(data[..., 0], aff), f"{out}/b0_only.nii.gz")
np.savetxt(f"{out}/dwi.bval", bvals[None, :], fmt="%g")
np.savetxt(f"{out}/dwi.bvec", bvecs.T, fmt="%.6f")
np.savetxt(f"{out}/grad.b", np.hstack([bvecs, bvals[:, None]]), fmt="%.6f")
np.savetxt(f"{out}/short.bval", bvals[None, :5], fmt="%g"); np.savetxt(f"{out}/short.bvec", bvecs[:5].T, fmt="%.6f")
`;
  const r = spawnSync(python3, ['-c', gen, root], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
}

let n = 0;
function run(inputs) {
  const session = join(root, `s${++n}`);
  const outputDir = join(session, 'outputs', 'dti');
  const workDir = join(session, 'work');
  mkdirSync(outputDir, { recursive: true });
  mkdirSync(workDir, { recursive: true });
  writeFileSync(join(session, 'context.json'), JSON.stringify({ runId: 'run-dti', tool: 'neuroflow.gallery.tools/dti-fit', step: 'dti', inputs, outputDir, workDir }));
  const env = {
    ...process.env, NEUROFLOW_SESSION: session, NEUROFLOW_OUTPUT_DIR: outputDir, NEUROFLOW_STEP: 'dti',
    NEUROFLOW_OUTPUT_FILE: join(session, 'result.json'), NEUROFLOW_TOOL_DOC: toolDoc, NEUROFLOW_PYTHON: python3,
  };
  const r = spawnSync(process.execPath, [adapter], { encoding: 'utf8', env });
  const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null);
  const prov = read(join(session, 'provenance.jsonl'));
  return { ...r, session, outputDir, prov: prov ? prov.trim().split('\n').map((l) => JSON.parse(l)) : null, result: read(join(session, 'result.json')) };
}
// Read a map back: mean/min/max inside the interior mask and max outside it.
function stats(file) {
  const r = spawnSync(python3, ['-c', `
import json, numpy as np, nibabel as nib
d = nib.load(${JSON.stringify(file)}).get_fdata(); m = np.zeros(d.shape, bool); m[1:5, 1:5, 1:5] = True
print(json.dumps({"mean": float(d[m].mean()), "min": float(d[m].min()), "max": float(d[m].max()), "outside": float(np.abs(d[~m]).max()), "dtype": str(nib.load(${JSON.stringify(file)}).get_data_dtype())}))`], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test('dti-fit recovers the synthetic tensor: FA and MD maps plus an inline summary', { skip }, () => {
  synthesise();
  const r = run({ dwi: join(root, 'dwi.nii.gz'), gradients: join(root, 'dwi.bval'), mask: join(root, 'mask.nii.gz') });
  assert.equal(r.status, 0, r.stderr);
  const fa = stats(join(r.outputDir, 'fa.nii.gz'));
  const md = stats(join(r.outputDir, 'md.nii.gz'));
  assert.ok(Math.abs(fa.mean - EXPECTED_FA) < 2e-3, `FA ${fa.mean}`);
  assert.ok(fa.max - fa.min < 1e-3, 'uniform FA');
  assert.equal(fa.outside, 0, 'zero outside the mask');
  assert.ok(Math.abs(md.mean - EXPECTED_MD) < 2e-6, `MD ${md.mean}`);
  assert.equal(md.outside, 0);
  assert.equal(fa.dtype, 'float32');
  const { summary } = JSON.parse(r.result);
  assert.equal(summary.fit_method, 'WLS');
  assert.equal(summary.voxels, 64);
  assert.equal(summary.directions, 20);
  assert.equal(summary.b0_volumes, 1);
  assert.deepEqual(summary.shells, [1000]);
  assert.ok(Math.abs(summary.fa.mean - EXPECTED_FA) < 2e-3);
  assert.ok(Math.abs(summary.md.median - EXPECTED_MD) < 2e-6);
  const p = r.prov.at(-1);
  assert.equal(p.action, 'python');
  assert.match(p.agent, /^Python 3\.\d+\.\d+ \+ nibabel [\d.]+ \+ numpy [\d.]+ \+ dipy [\d.]+$/);
  assert.deepEqual(p.outputs, { fa: 'fa.nii.gz', md: 'md.nii.gz' });
  assert.deepEqual(p.entry, { kind: 'function', module: 'nf_dti_fit', name: 'run' });
  assert.match(r.stderr, /dti-fit: fitting WLS tensor in 64 voxels, 20 directions, 1 b0/);
});

test('dti-fit accepts a .bvec path, an MRtrix .b table, OLS, and no mask', { skip }, () => {
  const viaBvec = run({ dwi: join(root, 'dwi.nii.gz'), gradients: join(root, 'dwi.bvec'), mask: join(root, 'mask.nii.gz'), fit_method: 'OLS' });
  assert.equal(viaBvec.status, 0, viaBvec.stderr);
  assert.equal(JSON.parse(viaBvec.result).summary.fit_method, 'OLS');
  assert.ok(Math.abs(JSON.parse(viaBvec.result).summary.fa.mean - EXPECTED_FA) < 2e-3);
  const mrtrix = run({ dwi: join(root, 'dwi.nii.gz'), gradients: join(root, 'grad.b') });
  assert.equal(mrtrix.status, 0, mrtrix.stderr);
  const s = JSON.parse(mrtrix.result).summary;
  assert.equal(s.voxels, 216, 'no mask: every voxel has signal');
  assert.ok(Math.abs(s.fa.mean - EXPECTED_FA) < 2e-3, `FA ${s.fa.mean}`);
});

test('dti-fit reports data problems as errors, not maps', { skip }, () => {
  const short = run({ dwi: join(root, 'dwi.nii.gz'), gradients: join(root, 'short.bval') });
  assert.equal(short.status, 1);
  assert.match(short.stderr, /ValueError: gradient table has 5 entries but dwi has 21 volumes/);
  assert.ok(!existsSync(join(short.outputDir, 'fa.nii.gz')));
  const threeD = run({ dwi: join(root, 'b0_only.nii.gz'), gradients: join(root, 'dwi.bval') });
  assert.match(threeD.stderr, /ValueError: dwi must be a 4-D series, got 3-D/);
  const method = run({ dwi: join(root, 'dwi.nii.gz'), gradients: join(root, 'dwi.bval'), fit_method: 'magic' });
  assert.match(method.stderr, /ValueError: unknown fit_method 'MAGIC'/);
  const noB0 = run({ dwi: join(root, 'dwi.nii.gz'), gradients: join(root, 'dwi.bval'), b0_threshold: -1 });
  assert.match(noB0.stderr, /ValueError: no b0 volume/);
  const lone = join(root, 'lone.bval');
  writeFileSync(lone, '0 1000\n');
  const noSibling = run({ dwi: join(root, 'dwi.nii.gz'), gradients: lone });
  assert.match(noSibling.stderr, /FileNotFoundError: gradient table lone\.bval needs both lone\.bval and lone\.bvec/);
});
