# NeuroFlow Session Contract (uiApp / script handoff)

Status: first pass

This is the file-based contract a NeuroFlow runtime uses to launch an external
tool (an interactive `uiApp` such as BIDSvue or NeuroVue, or a headless
`script`), hand it resolved inputs, wait for it, and harvest its outputs. It is
the concrete realization of `docs/bidsvue-neurovue-integration.md` and aligns
with the spec's output-delivery env vars (`$NEUROFLOW_OUTPUT_DIR`,
`$NEUROFLOW_WORK_DIR`; neuroflow-spec §15, §19).

## Environment variables

A launched tool receives:

| Variable | Meaning |
| --- | --- |
| `NEUROFLOW_SESSION` | Absolute path to the session directory (below). |
| `NEUROFLOW_OUTPUT_DIR` | Absolute path where this step writes its declared outputs. Conventionally `<session>/outputs/<step>`. |
| `NEUROFLOW_WORK_DIR` | Absolute path for scratch/intermediate files. |
| `NEUROFLOW_STEP` | The workflow step id being executed. |
| `NEUROFLOW_INTERPRETER_<NAME>` | Optional. Absolute path of an interpreter the runtime knows (`PYTHON3`, `PYTHON`, `NODE`, `RSCRIPT`): one per configured interpreter, plus the one this step launched with. An adapter that starts a second interpreter reads these before searching `PATH`. |

A tool that sees `NEUROFLOW_SESSION` set is running under NeuroFlow and SHOULD
switch from interactive "pick a folder" defaults to honoring the launch context.

## Session directory

```text
<session>/
  context.json            # launch intent for the current step (written by the runtime)
  provenance.jsonl        # append-only audit trail (appended by every tool)
  outputs/
    <step>/               # == $NEUROFLOW_OUTPUT_DIR for that step
  work/                   # == $NEUROFLOW_WORK_DIR
```

### context.json

```json
{
  "neuroflow": "0.1.0",
  "kind": "neuroflow/session-context",
  "step": "review",
  "tool": "neuroflow.gallery.tools/neurovue",
  "stage": "explore",
  "inputs": {
    "bids_dir": "/abs/path/to/bids",
    "volumes": ["/abs/path/sub-01_T1w.nii.gz"]
  },
  "outputDir": "/abs/session/outputs/review",
  "workDir": "/abs/session/work"
}
```

`inputs` holds already-resolved absolute paths (the runtime resolves bindings
before launch). A tool reads only the keys it understands.

### Output harvesting

Each tool writes its declared outputs into `$NEUROFLOW_OUTPUT_DIR` using the
delivery mode declared in its tool document:

- `core:result-dir` — a directory output (e.g. BIDSvue's `bids_dir`).
- `core:result-file` — a single file at `$NEUROFLOW_OUTPUT_DIR/<path>` (e.g.
  NeuroVue's `correction.patch.json`, the QA `index.html`).

The runtime harvests after the process exits (for `uiApp` tools, after the user
closes the app / required outputs appear).

### provenance.jsonl

One JSON object per line, appended by each tool when it finishes a unit of work:

```json
{"ts":"2026-06-02T18:30:00Z","step":"ingest","tool":"...bidsvue","action":"import","outputs":{"bids_dir":"outputs/ingest/bids"},"agent":"bidsvue@neuroflow-aware"}
```

Timestamps are ISO-8601 UTC. Tools MUST append, never rewrite.

`provenance.jsonl` is the lightweight, in-flight trail — not the durable record.

### Folding into a provenance document

When a run finishes, the runtime folds `provenance.jsonl` into a single
conformant **provenance document** (`kind: "provenance"`,
`neuroflow-spec/schemas/0.1/provenance.schema.json`) — the durable, W3C
PROV-aligned artifact that embeds in BIDS-Derivatives `GeneratedBy[]` and
RO-Crate. Each line maps to PROV:

| `provenance.jsonl` line | provenance document |
| --- | --- |
| `agent` | an Agent (`type: "software"`) |
| the line itself (`step`, `tool`, `ts`) | an Activity (one step execution) |
| each `outputs` path | an Entity (`role: "step-output"`), linked via `generated` |

The run's `startedAt`/`endedAt` come from the first/last line timestamps. The
reference implementation is `gallery/scripts/fold_provenance.mjs` (exposed as the
`neuroflow.gallery.tools/provenance-fold` tool), which writes
`run.provenance.json` to `$NEUROFLOW_OUTPUT_DIR`. Lineage folded from the
lightweight trail is shallow (no `derivedFrom`); a tool that needs rich lineage
SHOULD emit a `prov:run-record` output directly.

## Tool responsibilities (neuroflow-awareness)

A NeuroFlow-aware tool:

1. On startup, if `NEUROFLOW_SESSION` is set, read `<session>/context.json` and
   open/operate on `inputs` instead of prompting.
2. Write declared outputs into `$NEUROFLOW_OUTPUT_DIR`.
3. Append one or more lines to `<session>/provenance.jsonl`.
4. For `uiApp` tools, exit (or signal) when the user has finished so the runtime
   can continue.

See the gallery tool documents in `gallery/tools/` for the concrete per-tool
input/output contracts, and `gallery/workflows/` for an end-to-end workflow.
