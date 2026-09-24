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
- UI direction: follow the BIDSvue app in `/Users/chrisdrake/Dev/bidsui`
  (`https://github.com/neurolabusc/bidsui.git`) as the shared BIDS application
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

## Current Status

This is a scaffold for the next repo. The UI is intentionally already usable:
it loads a DICOM-to-BIDS workflow fixture, renders a graph, shows context and
output mappings, and calls the validation bridge. Actual tool execution is
stubbed behind the Rust/Tauri command boundary so native process execution can
be added deliberately.
