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

The two **uiApp** tools (BIDSvue, NeuroVue) are interactive: a NeuroFlow runtime
launches them with a session context and they block until the user finishes. The
two **script** tools are headless. Launch details (command, completion, env) live
in each tool's `extensions["neuroflow/launch"]`, and the runtime handoff format
is defined in `../docs/neuroflow-session-contract.md`.

## Workflows (`workflows/`)

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

## Reference apps

The uiApp tools are served by NeuroFlow-aware branches of the reference apps:

- BIDSvue — `/Users/chrisdrake/Dev/bidsui` branch `neuroflow-aware`
- NeuroVue — `/Users/chrisdrake/Dev/neurovue` branch `neuroflow-aware`

Both honor the session contract: read `$NEUROFLOW_SESSION/context.json`, write
outputs to `$NEUROFLOW_OUTPUT_DIR`, and append to `provenance.jsonl`.
