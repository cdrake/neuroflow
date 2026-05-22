# NeuroFlow Architecture

Status: scaffold

## Intent

NeuroFlow is split into three cooperating layers:

- Rust core: validates NeuroFlow JSON and derives execution plans.
- WASM package: exposes the Rust core to browser-only and embedded web targets.
- Tauri host: owns native filesystem access, process execution, and packaged
  runtime adapters.

The frontend is a React/Vite shell for now because the diagramming code being
reused from NiiVue Desktop is React and `@xyflow/react` based. The Rust core is
framework-neutral so a future Vue/BIDS UI shell can call the same planner.

## Runtime Boundary

The app should keep execution unsafe operations out of the web UI:

1. The frontend edits and visualizes NeuroFlow documents.
2. The Rust/WASM core validates documents and computes run plans.
3. Tauri commands execute native adapters after explicit user action.
4. Tool adapters report structured progress and provenance back to the UI.

## Initial Commands

The Tauri host exposes:

- `validate_workflow`
- `plan_workflow`

Future commands should stay narrow:

- `load_workflow_bundle`
- `resolve_tool_registry`
- `start_run`
- `cancel_run`
- `open_artifact`
- `write_provenance`

## WASM Core

The WASM crate wraps `neuroflow-core` with string-in/string-out functions:

- `validate_workflow_json`
- `plan_workflow_json`

That avoids binding the core to one JavaScript framework and keeps browser,
Tauri, and test usage aligned.

## UI Composition

The UI follows the BIDSvue workbench shape:

- workflow library
- block palette
- graph canvas
- step inspector
- run plan and validation panel
- bottom status bar

Local visual tokens in `src/styles/bidsui.css` mirror
`/Users/chrisdrake/Dev/bidsui/src/lib/styles/theme.css`. BIDSvue is SvelteKit,
so this React scaffold consumes the design language through CSS variables and
layout conventions rather than direct component imports.
