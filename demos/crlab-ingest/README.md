# crlab ingest demo

A short deck about running NeuroFlow on one real Siemens XA session
(the presenter's own scan): the `dcm2niix` JPEG Lossless pitfall, two headless
runs through the MCP server with their provenance, an honest QA look at the
result, and a **Live demo** slide that launches the NeuroFlow desktop builder
so the `dicom-ingest-review-publish` workflow (BIDSvue → NeuroVue → filter →
QA page) can be run in front of the audience.

## Files

| File | What it is |
| --- | --- |
| `slides.md` | The deck, Marp markdown. The demo and QA slides contain small scripts that talk to `serve.mjs`. |
| `serve.mjs` | Renders `slides.md` to `slides.html` with `marp --html`, serves it on `127.0.0.1:4173`, and exposes `/launch`, `/stop`, `/status` for the demo slide. `/launch` runs `npm run tauri:dev` in this checkout; it never starts a second copy if the desktop app is already running. |
| `assets/qa-montage.png` | Slice montage of the MNI-registered T1w with SynthSeg labels from the recorded run. |
| `out/` | Records of run `run-20261007T132051Z-0321` (`dicom-t1-mni-volumes`): `run.json`, `provenance.jsonl`, `run.provenance.json`, `workflow.json`, `volumes.tsv`. Home paths are replaced with `<home>`, the DICOM session folder with `<dicom>/crlab-session`, and scanner-site fields are dropped, as in `demos/prompt-to-workflow`. |

`slides.html` and `launch.log` are generated and gitignored.

## Running it

```bash
npm install                      # once; brings in @marp-team/marp-cli
node demos/crlab-ingest/serve.mjs \
  --dicom /path/to/the/dicom/folder \
  --qa ~/.neuroflow/runs/<qa-run-id>/outputs/niivue-qa-page   # optional
```

Open <http://127.0.0.1:4173/>. On the **Live demo** slide, **Launch NeuroFlow
desktop** starts the Tauri host (the first launch compiles it, so start it a
minute early or pass the deck a host that is already running: the slide
detects that too). Then in the desktop window: **Library** →
`dicom-ingest-review-publish`, paste `dicom_dir` (the slide has a copy
button), **Run**.

Prerequisites for the interactive steps are the ones the desktop
**Environment** panel checks: `bun` on PATH, `../bidsui` and `../neurovue`
checkouts beside this repo (or `NEUROFLOW_UI_APP_BIDSVUE` /
`NEUROFLOW_UI_APP_NEUROVUE`), `dcm2niix` ≥ v1.0.20260520 for Siemens XA
enhanced multi-frame JPEG Lossless DICOM (Homebrew's is fine), and BIDSvue's
dev sidecars staged under `bidsui/src-tauri/binaries/`. The BIDSvue checkout
is [niivue/BIDSvue](https://github.com/niivue/BIDSvue) on its
`neuroflow-aware` branch, cloned as `bidsui`; upstream commits the mindgrab
weights, so no separate download is needed.

To export without the live parts: `npx marp demos/crlab-ingest/slides.md --html --pdf --allow-local-files`.
