# NeuroFlow Tool Gallery

Schema-valid NeuroFlow **tool** and **workflow** documents for the reference
DICOM → BIDS → review → publish pipeline. Every document here validates against
the NeuroFlow specification schemas in `../../neuroflow-spec/schemas/0.1/`.

```bash
node gallery/validate.mjs        # or: npm run validate:gallery
```

## Tools (`tools/`)

| File | Tool id | Stage | Kind | Outputs |
| --- | --- | --- | --- | --- |
| `bidsvue.tool.json` | `…tools/bidsvue` | ingest | uiApp | `bids_dir` (result-dir) |
| `bidsvue-ingest.tool.json` | `…tools/bidsvue-ingest` | ingest | script → app CLI (BIDSvue) | `bids_dir` (result-dir) |
| `heudiconv-reproin.tool.json` | `…tools/heudiconv-reproin` | ingest | script → native CLI | `bids_dir` (result-dir) |
| `bids-tidy-names.tool.json` | `…tools/bids-tidy-names` | ingest | script → Python | `bids_dir` (result-dir), `summary` (JSON) |
| `neurovue.tool.json` | `…tools/neurovue` | explore | uiApp | `correction_patch`, `review_state` (result-file) |
| `python-volume-filter.tool.json` | `…tools/python-volume-filter` | explore | script → Python | `filtered_volumes` (result-dir) |
| `niivue-qa-page.tool.json` | `…tools/niivue-qa-page` | publish | script | `qa_html` (result-file `index.html`) |
| `provenance-fold.tool.json` | `…tools/provenance-fold` | publish | script | `run_record` (`prov:run-record`, `run.provenance.json`) |
| `label-volumes.tool.json` | `…tools/label-volumes` | publish | script → Python | `volumes` (TSV), `table` (inline JSON) |
| `neurodesk-brain-extraction.tool.json` | `neurodesk.webapps/brain-extraction` | explore | script → Neurodesk job | `brain`, `brain_mask` |
| `neurodesk-synthseg.tool.json` | `neurodesk.webapps/synthseg` | explore | script → Neurodesk job | `labels`, `report` |
| `dcm2niix.tool.json` | `…tools/dcm2niix` | ingest | script → native CLI | `volume`, `sidecar` |
| `mindgrab.tool.json` | `…tools/mindgrab` | explore | script → native CLI | `brain`, `brain_mask` |
| `niimath-allineate.tool.json` | `…tools/niimath-allineate` | explore | script → native CLI | `registered`, `transform` (`neuro:transform`) |
| `nifti-header-matlab.tool.json` | `…tools/nifti-header-matlab` | explore | script → MATLAB/Octave | `header` (JSON), `summary` (inline JSON) |
| `dti-fit.tool.json` | `…tools/dti-fit` | explore | script → Python (DIPY) | `fa`, `md` (NIfTI), `summary` (inline JSON) |

The two **uiApp** tools (BIDSvue, NeuroVue) are interactive: a NeuroFlow runtime
launches them with a session context and they block until the user finishes. The
**script** tools are headless. The **native CLI** tools share one adapter,
`scripts/cli_tool.mjs`, and describe their command line under
`extensions["neuroflow/cli"]`: dcm2niix, mindgrab via the brainchop CLI, and
niimath `-allineate` (the lightNIIng tool set), plus HeuDiConv with its reproin
heuristic. The **MATLAB/Octave** tool (a NIfTI header
reader) runs through `scripts/matlab_tool.mjs` from
`extensions["neuroflow/matlab"]`, which also covers SPM batches; see
`../docs/matlab-tools.md`. The four **Python** tools (BIDS name tidy, volume
filter, label volumes, DTI fit) run through `scripts/python_tool.mjs` from
`extensions["neuroflow/python"]`, which checks the declared packages before
launch; see `../docs/python-tools.md`. **bidsvue-ingest** is BIDSvue's import pipeline without the
window: `scripts/app_cli.mjs` runs `bun run neuroflow-ingest` (BIDSvue's package
script, which runs `svelte-kit sync` and then `scripts/neuroflow-ingest.ts`) in the
BIDSvue checkout (found like a uiApp's: `NEUROFLOW_UI_APP_BIDSVUE`, else `bidsui`
beside this checkout) from `extensions["neuroflow/app-cli"]`, after BIDSvue's
`--check` probe confirms dcm2niix, so the same ingest runs over MCP
with its settings taken from the step inputs. Launch details (command, completion, env) live
in each tool's `extensions["neuroflow/launch"]`, and the runtime handoff format
is defined in `../docs/neuroflow-session-contract.md`.

Every tool also carries `extensions["neuroflow/usage"]` (RFC 0011 in
neuroflow-spec): when to pick it, when to pick a named sibling `instead`, its
preconditions and effects, example inputs, and its known failure messages with a
remedy and whether a retry helps. Durations are given only where gallery runs
measured them, and `basis` says what on. `validate.mjs` checks these blocks
against the spec's `neuroflow-usage` schema. It also checks that example inputs
are declared and fit their types and enums, and that every `instead` names a
gallery document. When the spec checkout has no such schema yet, it says it
skipped them.

## Workflows (`workflows/`)

`brain-volumes.neuroflow.json` runs Neurodesk brain extraction and SynthSeg on
one T1 and reports per-structure volumes in mL. It needs the Neurodesk
Webapps desktop suite; see `../docs/neurodesk-webapps.md`.

`dicom-t1-mni-volumes.neuroflow.json` goes from a T1 DICOM series to structure
volumes and an MNI-space brain with the lightNIIng tools (dcm2niix → mindgrab →
niimath `-allineate` → SynthSeg → label volumes). It is the reference answer for
`../demos/prompt-to-workflow`, where an agent composes the same pipeline from a
prompt.

`filter-qa.neuroflow.json` is fully headless (filter, then QA page), so the
MCP server (`crates/neuroflow-mcp`) can run it end to end.

`dicom-reproin-filter-qa.neuroflow.json` is the headless path from a ReproIn
DICOM session: HeuDiConv → BIDS name tidy → filter → QA page. The tidy step
replaces heudiconv's `__dup-NN` names with BIDS entities (`part-mag`/`part-phase`
from ImageType, `sbref` for single-band references, `run-NN` in SeriesNumber
order, non-anat entities such as `dir` folded into `acq`) and updates sidecars,
`scans.tsv` and `IntendedFor`. How much data goes downstream is the caller's
choice: `match` picks which volumes the filter takes, and `max_embed_mb` caps
each embedded QA scene (larger volumes become block-averaged previews). An agent
building the run should ask the user for both on a large session.

`dicom-ingest-review-publish.neuroflow.json` chains all four tools:

```
ingest (BIDSvue, user-driven)  →  review (NeuroVue, user-driven)
      →  filter (Python script)  →  qa (NiiVue saveHTML page)
```

Stages run `ingest → explore → publish`. The workflow input is a `dicom_dir`;
its outputs are the produced `bids_dir` and the published QA `qa_page`.

## Scripts (`scripts/`)

Reference implementations the script-tools point at:

- `python_tool.mjs` — shared adapter for Python tools: finds the interpreter
  (`NEUROFLOW_PYTHON`, per-tool `.venv`, PATH), probes every declared package
  before running anything and fails with the fix when one is missing, generates
  `nf_driver.py` for function entries, maps outputs, appends provenance with the
  Python and package versions. `python/neuroflow.py` is the stdlib helper that
  gives tool code the session as an object; `python/nf_filter_volumes.py`,
  `python/nf_label_volumes.py`, `python/nf_dti_fit.py` (DIPY tensor fit) and
  `python/nf_bids_tidy.py` (stdlib only) are the gallery's tools on it. `python_tool.test.mjs` covers the adapter and the
  first two; `dti_fit.test.mjs` covers the DIPY tool when dipy is importable
  (`npm run test:gallery`). See `../docs/python-tools.md`.
- `generate_qa.mjs` — builds an offline QA page with `@niivue/nv-ext-save-html`:
  each volume is loaded into a headless NiiVue and written by `generateHTML` as
  a self-contained scene (volume plus a standalone NiiVue bundle, about 4.5 MB),
  so it opens from disk with no network. One volume makes `index.html` that
  scene; several make `<stem>.html` per volume and an `index.html` that lists
  them beside one viewer, so the page holds one WebGL context at a time.
  The bundle is built with esbuild on first use and cached in
  `node_modules/.cache/neuroflow`. If the extension can't be used, it warns and
  writes a page that loads NiiVue from esm.sh beside copies of the volumes.
  Tested by `generate_qa.test.mjs`.
- `cli_tool.mjs` — shared adapter for native command-line tools: finds the
  executable (override variable, install paths, PATH), probes the release,
  fills an argument template from the session inputs, maps the files written
  to the declared outputs, appends provenance. `cli_tool.test.mjs` covers it
  (`npm run test:gallery`).
- `matlab_tool.mjs` — shared adapter for MATLAB, GNU Octave and standalone SPM
  tools: picks an engine, resolves toolboxes, generates `nf_wrapper.m` (an `nf`
  struct from the session context, addpath, entry call in try/catch, exit
  status), runs it headlessly, maps outputs, appends provenance with engine and
  SPM versions. `matlab/nf_nifti_header.m` is the reference entry;
  `matlab_tool.test.mjs` covers the adapter (fake engine, Octave, MATLAB opt-in).
- `app_cli.mjs` — adapter for an app's headless entry point: finds the app
  checkout the way the runtime finds a uiApp's (a same-named directory without
  the entry file does not count), runs the app's optional `probe` there (a
  readiness check the app defines; its JSON `problems` are reported), runs the
  command in it with the session, and fails the step if a declared output is
  missing. The app writes its own handoff and provenance.
  `app_cli.test.mjs` covers it.
- `adapter_lib.mjs` — helpers shared by the adapters and `check_tool.mjs`
  (session context, tool-document lookup, executable search with `~` and `*`,
  probes, app-checkout resolution, input checks, output mapping, provenance).
- `check_tool.mjs` — the up-front environment check the desktop builder (and
  anyone else) runs before a workflow: for each tool document it applies the
  same executable, version, Python-package, MATLAB-engine, Neurodesk, app
  checkout and Node package rules the adapters apply at launch (for an app CLI
  tool: the checkout, its entry file, the runner and the app's own `probe`,
  e.g. BIDSvue's `--check`, which covers its dcm2niix), and prints one JSON row per tool
  with `status` (`ready`, `needsSetup`, `interactive`, `unsupported`), the
  reason and the fix. `node gallery/scripts/check_tool.mjs --tools-dir
  gallery/tools`; `check_tool.test.mjs` covers it (`npm run test:gallery`).
- `fold_provenance.mjs` — folds the run's append-only `provenance.jsonl` trail
  into a single conformant `kind:"provenance"` document (`run.provenance.json`),
  mapping each line to PROV agents/activities/entities. See
  `../docs/neuroflow-session-contract.md`.

## Reference apps

The uiApp tools are served by NeuroFlow-aware builds of the reference apps:

- BIDSvue — a `bidsui` checkout of [niivue/BIDSvue](https://github.com/niivue/BIDSvue).
  `bidsvue-ingest` runs `scripts/neuroflow-ingest.ts`, which is on `main` once
  [BIDSvue#18](https://github.com/niivue/BIDSvue/pull/18) merges; until then check
  out `neuroflow/headless-ingest` (#18's branch) or `neuroflow/window-ingest`. The
  `bidsvue` window needs `neuroflow/window-ingest`, which has both the window mode
  and the CLI.
- NeuroVue — a `neurovue` checkout of [cdrake/neurovue](https://github.com/cdrake/neurovue)
  on `main` (the NeuroFlow session support is merged there). It has no headless
  mode yet, so it only runs as the interactive uiApp; see
  [neurovue#13](https://github.com/cdrake/neurovue/issues/13).

Both honor the session contract: read `$NEUROFLOW_SESSION/context.json`, write
outputs to `$NEUROFLOW_OUTPUT_DIR`, and append to `provenance.jsonl`.
