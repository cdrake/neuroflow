#!/usr/bin/env node
/**
 * NeuroFlow gallery tool: niivue-qa-page.
 *
 * Reads the NeuroFlow session context and builds a QA web page for a set of
 * NIfTI volumes. The default is an offline page from NiiVue's save-html extension
 * (`@niivue/nv-ext-save-html`): each volume is loaded into a headless NiiVue
 * instance and written as one self-contained HTML scene holding the volume and a
 * standalone NiiVue bundle, so it opens with no server and no network. One
 * volume makes index.html that scene; several make one scene file per volume and
 * an index.html that lists them beside a viewer showing one at a time. If the extension can't be used,
 * the page falls back to loading NiiVue from esm.sh beside copies of the volumes.
 * See docs/neuroflow-session-contract.md.
 *
 * Env:
 *   NEUROFLOW_SESSION     session dir with context.json (+ provenance.jsonl)
 *   NEUROFLOW_OUTPUT_DIR  where to write index.html (delivery: index.html)
 *
 * Run standalone for testing:
 *   NEUROFLOW_SESSION=/tmp/sess NEUROFLOW_OUTPUT_DIR=/tmp/sess/outputs/qa \
 *     node generate_qa.mjs
 */
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, copyFileSync, readdirSync, renameSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const TOOL_ID = 'neuroflow.gallery.tools/niivue-qa-page'
const STEP = process.env.NEUROFLOW_STEP ?? 'qa'

const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')

function loadContext() {
  const session = process.env.NEUROFLOW_SESSION
  if (!session) return {}
  const p = join(session, 'context.json')
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {}
}

function outputDir(ctx) {
  const out = process.env.NEUROFLOW_OUTPUT_DIR || ctx.outputDir ||
    join(process.env.NEUROFLOW_SESSION ?? '.', 'outputs', STEP)
  mkdirSync(out, { recursive: true })
  return out
}

function appendProvenance(entry) {
  const session = process.env.NEUROFLOW_SESSION
  if (!session) return
  const line = JSON.stringify({ ts: nowIso(), step: STEP, tool: TOOL_ID, agent: 'niivue-qa-page', ...entry })
  appendFileSync(join(session, 'provenance.jsonl'), line + '\n')
}

/** Resolve the list of volume file paths from context, or discover filtered/*. */
function resolveVolumes(ctx) {
  const inputs = ctx.inputs ?? {}
  let vols = inputs.volumes
  if (Array.isArray(vols) && vols.length) return vols
  // Fall back: discover NIfTI files under the resolved volumes dir or filtered output.
  const dir = inputs.volumesDir || inputs.bids_dir
  if (dir && existsSync(dir)) {
    return readdirSync(dir).filter((f) => f.endsWith('.nii') || f.endsWith('.nii.gz')).map((f) => join(dir, f))
  }
  return []
}

const escapeHtml = (text) =>
  String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/**
 * Source of a NiiVue ESM bundle with every dependency inlined, which the
 * extension embeds in each page. @niivue/niivue doesn't publish one, so it is
 * built with esbuild on first use and cached under node_modules/.cache, keyed by
 * the NiiVue version.
 */
async function niivueBundleSource() {
  const entry = fileURLToPath(import.meta.resolve('@niivue/niivue'))
  const pkgDir = dirname(dirname(entry))
  const { version } = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))
  const cacheDir = join(dirname(dirname(pkgDir)), '.cache', 'neuroflow')
  const cached = join(cacheDir, `niivue-standalone-${version}.js`)
  if (!existsSync(cached)) {
    const { build } = await import('esbuild')
    mkdirSync(cacheDir, { recursive: true })
    const tmp = `${cached}.${process.pid}.tmp`
    await build({
      entryPoints: [entry], bundle: true, format: 'esm', platform: 'browser',
      minify: true, outfile: tmp, logLevel: 'warning',
    })
    renameSync(tmp, cached)
  }
  return { source: readFileSync(cached, 'utf8'), version }
}

/** Page name for each volume's scene: its file stem, made unique. */
function sceneNames(volumePaths) {
  const used = new Set(['index'])
  return volumePaths.map((p) => {
    const stem = basename(p).replace(/\.nii(\.gz)?$/i, '').replace(/[^\w.-]+/g, '_') || 'volume'
    let name = stem
    for (let i = 2; used.has(name); i++) name = `${stem}-${i}`
    used.add(name)
    return `${name}.html`
  })
}

/**
 * The index for several scenes: a list of volumes beside one viewer. Only the
 * selected scene is loaded, so the page holds one WebGL context however many
 * volumes there are (browsers drop contexts past about 16). The URL hash keeps
 * the selection, so a link can point at one volume.
 */
function indexHtml(title, scenes) {
  const items = scenes.map(({ page, label }) =>
    `  <li><a href="${escapeHtml(page)}" target="scene">${escapeHtml(label)}</a></li>`).join('\n')
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>
  html, body { height: 100%; margin: 0; }
  body { display: flex; flex-direction: column; font-family: system-ui, sans-serif; background: #0b0e14; color: #e6e6e6; }
  header { padding: 12px 16px; border-bottom: 1px solid #222; }
  h1 { font-size: 16px; margin: 0; }
  small { color: #8a94a6; }
  .main { flex: 1; display: flex; min-height: 0; }
  ol { margin: 0; padding: 8px 8px 8px 32px; width: 280px; overflow-y: auto; border-right: 1px solid #222; font-size: 13px; }
  li { padding: 3px 0; overflow-wrap: anywhere; }
  a { color: #b8c0cf; text-decoration: none; }
  a:hover { color: #fff; }
  a.current { color: #7aa2f7; font-weight: 600; }
  iframe { flex: 1; border: 0; background: #000; }
  @media (max-width: 640px) {
    .main { flex-direction: column; }
    ol { width: auto; max-height: 30vh; border-right: 0; border-bottom: 1px solid #222; }
  }
</style>
</head>
<body>
<header>
  <h1>${escapeHtml(title)}</h1>
  <small>Generated by NeuroFlow niivue-qa-page · ${nowIso()} · ${scenes.length} volumes · each opens on its own from its link</small>
</header>
<div class="main">
<ol>
${items}
</ol>
<iframe name="scene" title="Selected volume" src="${escapeHtml(scenes[0].page)}"></iframe>
</div>
<script>
  const links = [...document.querySelectorAll('ol a')]
  const frame = document.querySelector('iframe')
  function show(page) {
    const link = links.find((a) => a.getAttribute('href') === page) ?? links[0]
    links.forEach((a) => a.classList.toggle('current', a === link))
    if (frame.getAttribute('src') !== link.getAttribute('href')) frame.src = link.getAttribute('href')
  }
  links.forEach((a) => a.addEventListener('click', (e) => {
    e.preventDefault()
    history.replaceState(null, '', '#' + encodeURIComponent(a.getAttribute('href')))
    show(a.getAttribute('href'))
  }))
  show(decodeURIComponent(location.hash.slice(1)))
</script>
</body>
</html>
`
}

/**
 * Write the offline page with @niivue/nv-ext-save-html. Returns the scene files
 * written, or throws when the extension, NiiVue or esbuild can't be used.
 */
async function writeExtensionPages(volumePaths, title, out) {
  const [{ default: NiiVue }, { generateHTML }] = await Promise.all([
    import('@niivue/niivue'),
    import('@niivue/nv-ext-save-html'),
  ])
  const bundle = await niivueBundleSource()
  const pages = volumePaths.length === 1 ? ['index.html'] : sceneNames(volumePaths)
  const scenes = []
  for (const [i, p] of volumePaths.entries()) {
    const label = basename(p)
    const nv = new NiiVue({})
    await nv.loadVolumes([{ url: new File([readFileSync(p)], label), name: label }])
    const html = await generateHTML(nv, {
      niivueBundleSource: bundle.source,
      title: volumePaths.length === 1 ? title : `${title} · ${label}`,
    })
    writeFileSync(join(out, pages[i]), html)
    scenes.push({ page: pages[i], label })
  }
  if (volumePaths.length !== 1) writeFileSync(join(out, 'index.html'), indexHtml(title, scenes))
  return { scenes, niivue: bundle.version }
}

function fallbackHtml(volumeNames, title) {
  const list = JSON.stringify(volumeNames.map((name) => ({ url: name, name })))
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(title)}</title>
<style>
  body { margin: 0; font-family: system-ui, sans-serif; background: #0b0e14; color: #e6e6e6; }
  header { padding: 12px 16px; border-bottom: 1px solid #222; }
  h1 { font-size: 16px; margin: 0; }
  small { color: #8a94a6; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(360px, 1fr)); gap: 8px; padding: 8px; }
  .tile { background: #12161f; border: 1px solid #1d2330; border-radius: 8px; overflow: hidden; }
  .tile figcaption { padding: 6px 10px; font-size: 12px; color: #b8c0cf; border-top: 1px solid #1d2330; }
  canvas { width: 100%; height: 320px; display: block; }
</style>
</head>
<body>
<header>
  <h1>${escapeHtml(title)}</h1>
  <small>Generated by NeuroFlow niivue-qa-page · ${nowIso()}</small>
</header>
<div class="grid" id="grid"></div>
<script type="module">
  import { Niivue } from 'https://esm.sh/@niivue/niivue@0.45.0'
  const volumes = ${list}
  const grid = document.getElementById('grid')
  for (const v of volumes) {
    const fig = document.createElement('figure'); fig.className = 'tile'
    const canvas = document.createElement('canvas')
    const cap = document.createElement('figcaption'); cap.textContent = v.name
    fig.append(canvas, cap); grid.append(fig)
    try {
      const nv = new Niivue({ backColor: [0.04, 0.05, 0.08, 1], show3Dcrosshair: true })
      await nv.attachToCanvas(canvas)
      await nv.loadVolumes([{ url: v.url, name: v.name }])
    } catch (err) {
      cap.textContent = v.name + ' — failed to load (' + err + ')'
    }
  }
</script>
</body>
</html>
`
}

/** The CDN page: NiiVue from esm.sh, with the volumes copied beside index.html. */
function writeFallbackPage(volumePaths, title, out) {
  const names = []
  for (const p of volumePaths) {
    const name = basename(p)
    try { copyFileSync(p, join(out, name)); names.push(name) } catch { names.push(p) }
  }
  writeFileSync(join(out, 'index.html'), fallbackHtml(names, title))
  return names
}

async function main() {
  const ctx = loadContext()
  const title = ctx.inputs?.title ?? 'NeuroFlow QA'
  const out = outputDir(ctx)
  const volumePaths = resolveVolumes(ctx)
  const missing = volumePaths.filter((p) => !existsSync(p))
  if (missing.length) throw new Error(`volume(s) not found: ${missing.join(', ')}`)
  if (!volumePaths.length) throw new Error('no volumes: set inputs.volumes (or inputs.volumesDir)')

  let entry
  try {
    const { scenes, niivue } = await writeExtensionPages(volumePaths, title, out)
    entry = { mode: 'nv-ext-save-html', niivue, scenes: scenes.map((s) => s.page) }
  } catch (err) {
    console.error(`generate_qa: save-html extension unavailable (${err.message ?? err}); writing the esm.sh page`)
    writeFallbackPage(volumePaths, title, out)
    entry = { mode: 'cdn-fallback' }
  }

  const indexPath = join(out, 'index.html')
  appendProvenance({ action: 'qa-page', ...entry, inputCount: volumePaths.length, outputs: { qa_html: 'index.html' } })
  console.log(`generate_qa: wrote ${indexPath} [${entry.mode}] with ${volumePaths.length} volume(s)`)
}

main().catch((err) => { console.error('generate_qa failed:', err); process.exit(1) })
