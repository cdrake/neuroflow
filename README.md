# NeuroFlow

NeuroFlow is a Tauri application and Rust/WASM orchestration core for
schema-first neuroimaging pipelines. It consumes NeuroFlow workflow, tool, and
heuristic documents extracted from the NiiVue Desktop workflow model and turns
them into an operator workspace for validating, diagramming, and eventually
running pipelines.

## Source Lineage

- Specification source: `../neuroflow-spec`
- Workflow source model: `niivue/niivue/packages/niivue-desktop/workflows`
- Diagramming model: NiiVue Desktop `WorkflowDiagramView`, `BlockPalette`, and
  workflow draft utilities
- UI direction: follow the BIDSvue app (the `bidsui` project, not yet
  public) as the shared BIDS application
  language. Since BIDSvue is SvelteKit, NeuroFlow mirrors its theme tokens and
  shell conventions in React rather than importing components directly.

## Repository Shape

- `src/`: React/Vite app shell hosted by Tauri.
- `src/components/WorkflowDiagram.tsx`: graph view ported from the NiiVue Desktop
  diagramming concepts.
- `src/domain/`: TypeScript workflow types, graph helpers, and validation bridge.
- `crates/neuroflow-core/`: Rust workflow validation and planning core.
- `crates/neuroflow-wasm/`: WASM bindings around the Rust core.
- `crates/neuroflow-mcp/`: MCP server that exposes the registry to AI agents
  and runs script tools (RFC 0009); see its README.
- `src-tauri/`: Tauri native host and commands.
- `fixtures/`: source-derived NeuroFlow examples.
- `gallery/`: schema-valid tool and workflow documents plus the launcher scripts
  they run (Neurodesk web apps, native CLIs such as dcm2niix and niimath); see
  its README.
- `demos/prompt-to-workflow/`: a headless agent composes, validates and runs a
  workflow from a user prompt through the MCP server, with the recorded run.
- `docs/`: architecture and source-lineage notes.

## Development

```bash
npm install
npm run dev
```

Run the Tauri shell:

```bash
npm run tauri:dev
```

Build the Rust/WASM package:

```bash
npm run wasm:build
```

Run Rust checks:

```bash
cargo check --workspace
```

## Pipeline builder

`npm run tauri:dev` opens the desktop builder. It is the NiiVue Desktop
workflow canvas (block palette, React Flow diagram, step inspector) pointed at
this repository's gallery and runtime:

- **Library** lists `gallery/workflows/*.neuroflow.json`; **Tools** lists every
  `gallery/tools/*.tool.json`, grouped by its `niivue/ui` block category
  (Import, Ingest, Processing, Quality, Inspect, Output) with the design's
  category colors. A **fit** badge marks tools whose required inputs can be fed
  from the selected (or last) step's outputs; drag or click to add a step.
- **Environment** runs an up-front check on launch and on demand: it resolves
  every interpreter the tools declare, probes each tool through
  `gallery/scripts/check_tool.mjs` (the same executable, version and package
  rules the adapters apply at launch) and lists anything that needs the user
  to act, with the fix, before any run. Those tools carry a **setup** badge in
  the palette and on the canvas; interactive apps (BIDSvue, NeuroVue) carry
  **interactive** and cannot be run from the builder yet. Registry and data
  roots, the sessions root and interpreter overrides are editable there.
- **Run** takes the workflow's declared inputs (persisted per workflow),
  explains why a run is blocked (validation issue, missing input, tool needing
  setup), then executes the document in-process on the `neuroflow-mcp`
  runtime. Progress, per-step status, outputs with **Open** (reveals the file),
  the run folder, the provenance record and, on failure, the step's stderr
  tail are shown as they arrive. Cancel is not supported yet.

In a plain browser (`npm run dev`) the same UI works as an editor with a
simulated run; nothing is probed or executed.

Runs land under `~/.neuroflow/runs/<run-id>/` (`run.json`, `run.provenance.json`,
`outputs/<step>/`, `logs/<step>/`), the same layout the MCP server writes.

## Current Status

The desktop builder edits and runs the gallery workflows end to end on this
machine through the Rust/Tauri boundary (`src-tauri/src/host.rs`, backed by the
`neuroflow-mcp` library crate). Interactive `uiApp` steps launch their declared
command in a configured checkout (`NEUROFLOW_UI_APP_<APP>`, or by default the
tool's `repo` directory next to the NeuroFlow checkout, e.g. `../neurovue`) and
wait for the app to finish its session contract. The Run
panel can cancel an active local run; the runtime terminates the current step's
whole process tree (each step runs in its own process group) and writes a
cancelled session record. Remote hosts are not wired yet.

## License

Licensed under either of the [Apache License, Version 2.0](LICENSE-APACHE) or the
[MIT license](LICENSE-MIT), at your option. Contributions are accepted under the
same terms.
