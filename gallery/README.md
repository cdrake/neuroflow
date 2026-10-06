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
| `neurovue.tool.json` | `…tools/neurovue` | explore | uiApp | `correction_patch`, `review_state` (result-file) |
| `python-volume-filter.tool.json` | `…tools/python-volume-filter` | explore | script | `filtered_volumes` (result-dir) |
| `niivue-qa-page.tool.json` | `…tools/niivue-qa-page` | publish | script | `qa_html` (result-file `index.html`) |
| `provenance-fold.tool.json` | `…tools/provenance-fold` | publish | script | `run_record` (`prov:run-record`, `run.provenance.json`) |
| `label-volumes.tool.json` | `…tools/label-volumes` | publish | script | `volumes` (TSV), `table` (inline JSON) |
| `neurodesk-brain-extraction.tool.json` | `neurodesk.webapps/brain-extraction` | explore | script → Neurodesk job | `brain`, `brain_mask` |
| `neurodesk-synthseg.tool.json` | `neurodesk.webapps/synthseg` | explore | script → Neurodesk job | `labels`, `report` |
| `dcm2niix.tool.json` | `…tools/dcm2niix` | ingest | script → native CLI | `volume`, `sidecar` |
| `mindgrab.tool.json` | `…tools/mindgrab` | explore | script → native CLI | `brain`, `brain_mask` |
| `niimath-allineate.tool.json` | `…tools/niimath-allineate` | explore | script → native CLI | `registered`, `transform` (`neuro:transform`) |
| `nifti-header-matlab.tool.json` | `…tools/nifti-header-matlab` | explore | script → MATLAB/Octave | `header` (JSON), `summary` (inline JSON) |

The two **uiApp** tools (BIDSvue, NeuroVue) are interactive: a NeuroFlow runtime
launches them with a session context and they block until the user finishes. The
**script** tools are headless. The three **native CLI** tools (dcm2niix, mindgrab
via the brainchop CLI, niimath `-allineate`) are the lightNIIng tool set; they share
one adapter, `scripts/cli_tool.mjs`, and describe their command line under
`extensions["neuroflow/cli"]`. The **MATLAB/Octave** tool (a NIfTI header
reader) runs through `scripts/matlab_tool.mjs` from
`extensions["neuroflow/matlab"]`, which also covers SPM batches; see
`../docs/matlab-tools.md`. Launch details (command, completion, env) live
in each tool's `extensions["neuroflow/launch"]`, and the runtime handoff format
is defined in `../docs/neuroflow-session-contract.md`.

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

`dicom-ingest-review-publish.neuroflow.json` chains all four tools:

```
ingest (BIDSvue, user-driven)  →  review (NeuroVue, user-driven)
      →  filter (Python script)  →  qa (NiiVue saveHTML page)
```

Stages run `ingest → explore → publish`. The workflow input is a `dicom_dir`;
its outputs are the produced `bids_dir` and the published QA `qa_page`.

## Scripts (`scripts/`)

Reference implementations the script-tools point at:

- `filter_volumes.py` — reads the session context, filters NIfTI volumes
  (smooth / threshold / zscore / passthrough), writes to the session output dir,
  appends provenance. Uses `nibabel`/`numpy`/`scipy` when present, else copies.
- `generate_qa.mjs` — builds a standalone QA page via `@niivue/nv-ext-save-html`
  (`generateHTML`/`saveHTML`) when installed, else a self-contained NiiVue CDN
  page. Copies volumes next to `index.html` so the page is portable.
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
- `adapter_lib.mjs` — helpers shared by the two adapters (session context,
  tool-document lookup, executable search with `~` and `*`, input checks,
  output mapping, provenance).
- `fold_provenance.mjs` — folds the run's append-only `provenance.jsonl` trail
  into a single conformant `kind:"provenance"` document (`run.provenance.json`),
  mapping each line to PROV agents/activities/entities. See
  `../docs/neuroflow-session-contract.md`.

## Reference apps

The uiApp tools are served by NeuroFlow-aware branches of the reference apps:

- BIDSvue — a `bidsui` checkout on branch `neuroflow-aware`
- NeuroVue — a `neurovue` checkout on branch `neuroflow-aware`

Both honor the session contract: read `$NEUROFLOW_SESSION/context.json`, write
outputs to `$NEUROFLOW_OUTPUT_DIR`, and append to `provenance.jsonl`.
