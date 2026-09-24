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
- `execute_console_tool`

`execute_console_tool` is intentionally an allowlisted adapter boundary. The UI
passes a registry command id, tool id, and structured inputs; Rust validates the
request and dispatches to a fixed host-side command without invoking a shell.
The initial `neuroflow.echo` adapter is a dry execution stand-in for NiiVue and
BIDSvue command adapters while the real tool registry is shaped.

Tool contracts can describe output availability and input consumption with
`availableFrom` and `consumesAs`; see `docs/tool-io-schema.md`. Safe pipes should
be derived from that schema and passed as argv, stdin, files, or request bodies,
never by composing shell strings.

Tool contracts can also describe platform-specific install and packaging policy
with the `neuroflow/packaging` extension; see `docs/tool-packaging.md`.
Workflows should remain universal and reference logical tools, while install
builds resolve `tool-id@version` contracts to a target platform, existing local
software, user-provided locations, sidecar binaries, containers, or service
endpoints. The resolved choices belong in a bundle lock and run provenance, not
as hard-coded paths inside workflow JSON.

Standalone UI tools use the same output contract. A `uiApp` executor launches an
allowlisted app session, watches declared UI/session/filesystem outputs, and
continues after the app closes once required outputs are resolved.

NeuroVue is the first preview-oriented UI app modeled by that contract, but it
should live outside this repo as its own application. NeuroFlow launches it as
an allowlisted external session, passes resolved artifacts and launch context,
then watches declared outputs such as correction patches or review state.
Workflow execution, packaging, and app-session policy stay in NeuroFlow; the
viewer/correction experience stays in NeuroVue. See `docs/neurovue.md`.

Tools and steps can carry an optional `stage` tag (`ingest`/`explore`/`publish`)
for discovery and flow grouping; it is informal and non-load-bearing. See
`docs/stages.md`.

The broader BIDSvue/NeuroVue handoff plan, including NVDocument working-state
boundaries, `niimath` task exposure, and provenance expectations, lives in
`docs/bidsvue-neurovue-integration.md`.

Future commands should stay narrow:

- `load_workflow_bundle`
- `resolve_tool_registry`
- `start_run`
- `cancel_run`
- `open_artifact`
- `write_provenance`

## MCP Server

`crates/neuroflow-mcp` is a fourth host for the Rust core. It speaks the Model
Context Protocol over stdio so AI agents can discover, validate, compose, and
run NeuroFlow tools and workflows. It follows the same runtime boundary as the
Tauri host: agents submit documents and values, never commands. Only tools in
the registry run, through their declared `neuroflow/launch` contract, with
file inputs confined to configured data roots. Artifacts come back as
`neuroflow://` URIs whose summaries (NIfTI geometry, label volumes, dataset
layout) are sized for a model's context, and every run writes a provenance
document. The binding is specified in neuroflow-spec RFC 0009.

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
