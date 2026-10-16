// npm run test:gallery   (node --test "gallery/scripts/*.test.mjs")
// generate_qa.mjs: the QA page is written offline by @niivue/nv-ext-save-html — one scene
// for one volume, a scene per volume plus an index listing them for several — with no CDN import.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, 'generate_qa.mjs');
const root = mkdtempSync(join(tmpdir(), 'generate-qa-'));

/** A 4x4x4 uint8 NIfTI-1 volume with a gradient, small enough to write inline. */
function nifti(name) {
  const hdr = Buffer.alloc(352);
  hdr.writeInt32LE(348, 0);
  [3, 4, 4, 4, 1, 1, 1, 1].forEach((v, i) => hdr.writeInt16LE(v, 40 + 2 * i));
  hdr.writeInt16LE(2, 70); // datatype: uint8
  hdr.writeInt16LE(8, 72); // bitpix
  [1, 1, 1, 1].forEach((v, i) => hdr.writeFloatLE(v, 76 + 4 * i)); // pixdim
  hdr.writeFloatLE(352, 108); // vox_offset
  hdr.writeFloatLE(1, 112); // scl_slope
  hdr.write('n+1\0', 344, 'latin1');
  const path = join(root, name);
  writeFileSync(path, Buffer.concat([hdr, Buffer.from(Array.from({ length: 64 }, (_, i) => i * 4))]));
  return path;
}

function run(name, inputs) {
  const session = join(root, name);
  mkdirSync(session);
  writeFileSync(join(session, 'context.json'), JSON.stringify({ inputs }));
  const out = join(session, 'out');
  const r = spawnSync(process.execPath, [script], {
    encoding: 'utf8',
    env: { ...process.env, NEUROFLOW_SESSION: session, NEUROFLOW_OUTPUT_DIR: out },
  });
  const prov = existsSync(join(session, 'provenance.jsonl'))
    ? readFileSync(join(session, 'provenance.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    : [];
  return { r, out, prov };
}

const offlineScene = (html) => {
  assert.match(html, /id="__niivue_bundle__"/);
  assert.match(html, /id="__nvd_data__"/);
  assert.doesNotMatch(html, /esm\.sh/);
};

test('one volume: index.html is the self-contained scene', () => {
  const { r, out, prov } = run('one', { volumes: [nifti('a.nii')], title: 'QA <one>' });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /extension unavailable/);
  const html = readFileSync(join(out, 'index.html'), 'utf8');
  offlineScene(html);
  assert.match(html, /<title>QA &lt;one&gt;<\/title>/);
  assert.ok(!existsSync(join(out, 'a.nii')), 'volumes are embedded, not copied');
  assert.equal(prov.at(-1).mode, 'nv-ext-save-html');
  assert.deepEqual(prov.at(-1).scenes, ['index.html']);
});

test('several volumes: a scene per volume and an index that shows one at a time', () => {
  const a = nifti('b.nii');
  const { r, out, prov } = run('two', { volumes: [a, a], title: 'QA two' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(prov.at(-1).scenes, ['b.html', 'b-2.html']);
  for (const page of ['b.html', 'b-2.html']) offlineScene(readFileSync(join(out, page), 'utf8'));
  const index = readFileSync(join(out, 'index.html'), 'utf8');
  assert.match(index, /<a href="b\.html" target="scene">b\.nii<\/a>/);
  assert.match(index, /<a href="b-2\.html" target="scene">b\.nii<\/a>/);
  assert.equal(index.match(/<iframe/g).length, 1, 'one viewer, so one WebGL context');
  assert.doesNotMatch(index, /https?:\/\//);
});

test('a missing volume fails the step', () => {
  const { r } = run('missing', { volumes: [join(root, 'nope.nii')] });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /generate_qa failed:.*volume\(s\) not found/);
});
