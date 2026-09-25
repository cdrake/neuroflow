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
3. Writes `job.json` into the session work directory and runs
   `neurodesk-webapps --job ... --output ...`.
4. Matches each download filename against the `outputs` patterns and copies
   the file to the output's declared `delivery.path`. A missing required output
   fails the step and lists what was downloaded.
5. Appends a line to `provenance.jsonl`.

The adapter looks for the executable in `NEURODESK_WEBAPPS`, then in
`/Applications`, `~/Applications`, `~/Downloads` (`neurodesk-webapps.app`), and
then on `PATH`. `NEURODESK_MODELS_DIR` passes through for offline model packs.

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

- SynthSeg in `--job` mode (suite 0.14.20260923) never reports "Labels ready":
  the app waits for its viewer to draw before starting inference, and the job
  window is hidden. Use the native `synthseg` CLI until the fix is released.
  The upstream fix makes SynthSeg start the worker and report completion
  without waiting on the viewer.

## Tools and workflows

| Document | App | Inputs | Outputs |
| --- | --- | --- | --- |
| `tools/neurodesk-brain-extraction.tool.json` | brain-extraction | `t1`, `method` (synthstrip, mindgrab, bet), `threshold` (BET) | `brain`, `brain_mask` |
| `tools/neurodesk-synthseg.tool.json` | synthseg | `t1`, `mode` (default, fast) | `labels`, `report` |
| `tools/label-volumes.tool.json` | none (Python) | `labels`, optional `mask` | `volumes` TSV, `table` inline JSON |
| `workflows/brain-volumes.neuroflow.json` | all three | `t1`, `method`, `mode` | brain, mask, labels, volumes |

`brain-volumes` runs brain extraction and SynthSeg on the full-head T1 (SynthSeg
expects an unstripped image), then measures every SynthSeg structure in mL and
the brain-mask volume. The inline `table` lets an agent answer questions such as
"what are the hippocampal volumes?" from the tool result alone.

## Adding another app

1. Read the app's `index.html` and `src/main.js` in neurodesk/webapps, and
   copy the control flow from its Playwright test in `e2e/`. Those tests are
   the best record of the selectors, the ready message to wait for, and the
   download buttons.
2. Write a tool document with typed inputs and outputs, the shared launch
   block, and a `neurodesk/job` template.
3. Set `expectedDownloads` to the number of download clicks. The suite fails
   the job if the count differs or a download is empty.
4. Run `node gallery/validate.mjs`, then
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
