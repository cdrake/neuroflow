# Neurodesk Webapps in NeuroFlow

Status: first pass

The [Neurodesk Webapps](https://github.com/neurodesk/webapps) are browser-native
imaging tools (SynthSeg, brain extraction, registration, QSM, and about twenty
more). Their desktop suite has a batch mode that runs any of them without a
window:

```bash
neurodesk-webapps --job job.json --output results/
```

A job is a list of UI steps (upload, select, fill, click, wait) addressed by CSS
selector. The suite runs the same scientific code as the web app and saves every
download into `results/`, plus `job-result.json`
(see `packages/desktop/STANDALONE.md` in that repository).

NeuroFlow uses that mode as the glue between the apps. Each app becomes a typed
NeuroFlow tool, so the apps can be chained in workflows, validated, and run by
agents through `neuroflow-mcp`.

## How it works

`gallery/scripts/neurodesk_job.mjs` is one adapter shared by every Neurodesk
tool. A tool document declares:

- Typed `inputs` and `outputs`, as for any NeuroFlow tool.
- `neuroflow/launch`: `kind: script`, `interpreter: node`, `script:
  ../scripts/neurodesk_job.mjs`.
- `neurodesk/job`: a job template.

```json
"neurodesk/job": {
  "app": "synthseg",
  "expectedDownloads": 2,
  "timeoutMs": 1800000,
  "steps": [
    { "action": "upload", "selector": "#imageInput", "paths": ["{{t1}}"] },
    { "action": "select", "selector": "#mode", "value": "{{mode}}" },
    { "action": "click", "selector": "#processButton" },
    { "action": "wait", "selector": "#statusText", "condition": "text", "value": "Labels ready" },
    { "action": "click", "selector": "#saveBtn" },
    { "action": "click", "selector": "#reportBtn" }
  ],
  "outputs": {
    "labels": { "match": "_synthseg\\.nii\\.gz$" },
    "report": { "match": "_synthseg\\.json$" }
  }
}
```

At run time the adapter:

1. Replaces each `{{input}}` placeholder with that input's resolved value from
   `context.json`. File inputs are absolute paths. A placeholder that is a whole
   string and refers to an array input expands to every element.
2. Keeps a step with `"when": { "method": "bet" }` only when the inputs match.
3. Runs the template's `preflight`, if any, against the input's NIfTI header
   (see "Preflight" below) and fails the step without starting the app when
   the volume cannot fit the app's GPU plan.
4. Writes `job.json` into the session work directory and runs
   `neurodesk-webapps --job ... --output ... --remote-debugging-port=<free port>`.
5. While the job runs, watches the app page through that DevTools port
   (`watchApp` in `gallery/scripts/neurodesk_lib.mjs`): it logs the app's
   status line to the step's stdout, applies the template's `fixups`, and stops
   the job as soon as the `failure` selector matches. The suite's own job
   runner only waits for success, so without this an app that reports an error
   would sit until the job timeout (30 minutes for SynthSeg). If the port cannot
   be reached, the job proceeds on the suite's timeout as before.
6. Matches each download filename against the `outputs` patterns and copies
   the file to the output's declared `delivery.path`. A missing required output
   fails the step and lists what was downloaded.
7. Appends a line to `provenance.jsonl`.

The adapter looks for the executable in `NEURODESK_WEBAPPS`, then in
`/Applications`, `~/Applications`, `~/Downloads` (`neurodesk-webapps.app`), and
then on `PATH`. `NEURODESK_MODELS_DIR` passes through for offline model packs.
`NEURODESK_DEBUG_PORT` pins the DevTools port (default: a free port) so
`neurodesk_cdp_probe.mjs` can attach alongside the adapter;
`NEURODESK_PREFLIGHT=0` skips the preflight check.

### Failure, fixups, and preflight

Three optional template fields make the app path fail fast and work around
release-specific quirks:

```json
"failure": { "selector": "#statusText.error" },
"fixups": [
  { "selector": "#saveBtn", "property": "onclick", "value": null,
    "reason": "suite 0.14.20260923 wires the labels Download button twice" }
],
"preflight": {
  "input": "t1", "resampleMm": 1, "padMultiple": 32,
  "bytesPerVoxel": 288, "maxBytes": 2147483647,
  "label": "SynthSeg",
  "advice": "Use the native synthseg CLI (on PATH or via NEURODESK_SYNTHSEG), or a smaller field of view."
}
```

- `failure` is a CSS selector that matches once the app has reported an error.
  Every Neurodesk app sets class `error` on `#statusText` when a run fails, so
  that is the default; the element's text becomes the step's error message.
- `fixups` set one property on an element once it exists. They are tied to a
  suite release, like the selectors; say why in `reason`.
- `preflight` estimates the largest GPU buffer a U-Net app will allocate: the
  volume resampled to `resampleMm`, each axis padded up to a multiple of
  `padMultiple`, times `bytesPerVoxel` (the widest float32 activation). SynthSeg
  pads to multiples of 32 and its widest activation is 72 channels, so a
  192×256×256 grid needs 3.4 GiB and any padded grid over 7,456,540 voxels is
  refused. The estimate reproduces the app's own number; a volume that slips
  through is still caught by `failure` a few seconds into the run.

## Native engines

Several Neurodesk apps also ship a native command-line version of the same
method (`exes/` in neurodesk/webapps). A template can declare one under
`native`:

```json
"native": {
  "command": "synthseg",
  "paths": ["/usr/local/bin/synthseg"],
  "env": "NEURODESK_SYNTHSEG",
  "args": ["--i", "{{t1}}", "--o", "{{outputDir}}/synthseg.nii.gz", "--force", "--quiet",
           { "arg": "--fast", "when": { "mode": "fast" } }],
  "outputs": { "labels": "synthseg.nii.gz", "report": "synthseg.json" }
}
```

`NEURODESK_ENGINE` selects the engine: `auto` (default) uses the native CLI
when it is installed and the web app otherwise; `native` and `app` force one.
Provenance records which engine ran.

## Known issues

Verified against suite 0.14.20260923 on macOS (Apple silicon) with synthetic
volumes; see the SynthSeg tool's `preflight.source` for where the numbers come
from.

- The SynthSeg web app refuses volumes that need more than its validated
  2 GiB GPU buffer. That is every padded 1 mm grid over about 7.4 million
  voxels, which includes the MNI152 1 mm template at 182×218×182 (2.2 GiB), a
  typical 176×256×256 MPRAGE (3.1 GiB) and anything resampled to 192×256×256
  (3.4 GiB); the app does not crop empty space first, and 2 mm data is
  resampled to 1 mm before the check. The same template cropped to the brain
  bounding box plus a 6 mm margin (155×192×166, 1.6 GiB) segments in the app
  in about 8 s, and the app and native engines produce identical label maps
  for it. The tool's `preflight` refuses an oversized volume before the app
  starts, naming the native `synthseg` CLI as the fix (the tool prefers it
  whenever it is installed).
  A fix that fails jobs as soon as an app reports an error has been proposed
  upstream; until then the adapter's `failure` watch does the same from
  outside.
- In the same release, one click on SynthSeg's labels Download button
  downloads the file twice (the result-list handler and `saveBtn.onclick` both
  fire), and the job runner rejects the duplicate ("Duplicate output"), so no
  SynthSeg job could finish through the app. The tool's `fixups` entry clears
  the extra handler; remove it once a release fixes the button.
- To see why a job is stuck, run the adapter with `NEURODESK_DEBUG_PORT=9223`
  (or the suite with `--remote-debugging-port=9223`) and run
  `node gallery/scripts/neurodesk_cdp_probe.mjs` while the job waits. It
  prints the status text, progress, WebGPU adapter, and console output. The
  adapter already logs the status line, so the step's stdout is the first
  place to look.

The installed suite is inspectable: the job runner is `src/jobs.js` inside
`Contents/Resources/app.asar` (`npx @electron/asar extract`), and each app's
built page and worker are under `Contents/Resources/offline/site/<app>/`.

## Tools and workflows

| Document | App | Inputs | Outputs |
| --- | --- | --- | --- |
| `tools/neurodesk-brain-extraction.tool.json` | brain-extraction | `t1`, `method` (synthstrip, mindgrab, bet), `threshold` (BET) | `brain`, `brain_mask` |
| `tools/neurodesk-synthseg.tool.json` | synthseg | `t1`, `mode` (default, fast) | `labels`, `report` |
| `tools/label-volumes.tool.json` | none (Python) | `labels`, optional `mask` | `volumes` TSV, `table` inline JSON |
| `workflows/brain-volumes.neuroflow.json` | all three | `t1`, `method`, `mode` | brain, mask, labels, volumes |
| `workflows/dicom-t1-mni-volumes.neuroflow.json` | synthseg, plus the native CLI tools | `dicom_dir`, `template`, `mode` | T1, brain, brain in MNI, labels, volumes |

`brain-volumes` runs brain extraction and SynthSeg on the full-head T1 (SynthSeg
expects an unstripped image), then measures every SynthSeg structure in mL and
the brain-mask volume. The inline `table` lets an agent answer questions such as
"what are the hippocampal volumes?" from the tool result alone.
`dicom-t1-mni-volumes` starts one step earlier, from a DICOM series, and uses the
native lightNIIng tools for conversion, stripping and registration (see
[native-cli-tools.md](native-cli-tools.md)).

## Adding another app

1. Read the app's `index.html` and `src/main.js` in neurodesk/webapps, and
   copy the control flow from its Playwright test in `e2e/`. Those tests are
   the best record of the selectors, the ready message to wait for, and the
   download buttons.
2. Write a tool document with typed inputs and outputs, the shared launch
   block, and a `neurodesk/job` template.
3. Set `expectedDownloads` to the number of download clicks. The suite fails
   the job if the count differs or a download is empty.
4. Keep the default `failure` selector unless the app reports errors
   differently. Add a `preflight` for a GPU app whose worker validates buffer
   sizes (search its inference worker for `maxValidatedBufferSize`).
5. Run `node gallery/validate.mjs`, `npm run test:gallery`, then
   `neuroflow-mcp --registry gallery --check`.

Selectors are tied to each app release. The Neurodesk docs recommend keeping
job templates with the release they were tested against. Record the suite
version you tested in the tool's description or changelog.

## Testing without the desktop suite

`crates/neuroflow-mcp/tests/fake_neurodesk_webapps.py` stands in for the
executable through `NEURODESK_WEBAPPS` (set `WEBAPPS_SRC` to a neurodesk/webapps
checkout). It
validates the job's selectors against the app sources and writes downloads
named as the real app names them. It exercises the whole NeuroFlow side
(templating, execution, output mapping, harvesting, provenance), but not the
app itself. Run each template once against the real suite before relying on it.
