# AGENTS.md

Working guide for coding-agent sessions in this repo. This file is adapted from
the BIDSvue guidance in that project's `CLAUDE.md` where you have a checkout, but
tailored to NeuroFlow's React/Tauri/Rust/WASM scaffold.

Companion docs:

- [README.md](README.md) for the project overview and development commands.
- [docs/architecture.md](docs/architecture.md) for runtime boundaries and layer
  responsibilities.
- [docs/source-lineage.md](docs/source-lineage.md) for the BIDSvue and NiiVue
  Desktop source models this app follows.

## Status

NeuroFlow is a scaffold for a schema-first neuroimaging workflow workbench. The
UI is intentionally usable today: it loads a DICOM-to-BIDS fixture, renders a
workflow graph, shows inspector details and output mappings, and validates/plans
the document through the Rust/Tauri bridge when available.

The desktop builder runs the gallery workflows end to end through the Tauri
host (`src-tauri/src/host.rs`) on the `neuroflow-mcp` runtime; see the README's
Pipeline builder section. Keep native process execution behind that deliberate
Tauri command boundary.

## Stack

- **App shell:** Tauri 2.
- **Renderer:** React 18 + TypeScript + Vite.
- **Diagramming:** `@xyflow/react`, based on NiiVue Desktop workflow-diagram
  concepts.
- **Rust core:** `crates/neuroflow-core`, framework-neutral workflow validation
  and planning.
- **WASM bridge:** `crates/neuroflow-wasm`, string-in/string-out bindings around
  the Rust core.
- **Tauri host:** `src-tauri`: `validate_workflow`, `plan_workflow`, and the
  run/environment commands in `src-tauri/src/host.rs`.
- **Design language:** BIDSvue (the `bidsui` project, not yet public).
  NeuroFlow mirrors BIDSvue CSS tokens and shell conventions rather than
  importing Svelte components.
- **Package manager:** npm. Use the scripts in `package.json` unless there is a
  strong reason to do otherwise.

## Repository Shape

- `src/`: React/Vite application shell.
- `src/components/WorkflowDiagram.tsx`: graph view ported from NiiVue Desktop
  workflow concepts.
- `src/components/`: workbench panels, tool palette, inspector, run timeline,
  and workflow library.
- `src/domain/`: TypeScript workflow types, graph helpers, validation/planning
  bridge.
- `src/data/sample.ts`: source-derived sample tools and workflows.
- `src/styles/bidsui.css`: BIDSvue-aligned design tokens.
- `src/styles/app.css`: NeuroFlow workbench layout and component styling.
- `crates/neuroflow-core/`: Rust validation/planning core.
- `crates/neuroflow-wasm/`: WASM bindings for browser and embedded usage.
- `crates/neuroflow-mcp/`: MCP server and the run-time library the desktop
  host uses to execute workflows.
- `gallery/`: tool and workflow documents plus their adapter scripts
  (`gallery/scripts/`: native CLI, Python, MATLAB/Octave, Neurodesk job, app
  CLI); see `gallery/README.md`.
- `tests/ui/`: Node tests for `src/domain` (`npm run test:ui`).
- `src-tauri/`: native host, capabilities, and app configuration.
- `fixtures/`: NeuroFlow JSON examples.
- `docs/`: architecture and source-lineage notes.

## Development Commands

```bash
npm install
npm run dev
npm run build
npm run tauri:dev
npm run tauri:build
npm run wasm:build
cargo check --workspace
npm run validate:gallery
npm run test:gallery
npm run test:ui
cargo test --workspace
(cd crates/neuroflow-conformance && cargo test)
```

Use `npm run build` as the default frontend verification gate. Use
`cargo check --workspace` when touching Rust crates or Tauri command shapes.
Run `npm run wasm:build` after changing the public WASM surface. Run
`npm run validate:gallery` and `npm run test:gallery` after touching
`gallery/`. Run the `crates/neuroflow-conformance` tests after changing the
closed field lists in `neuroflow-core/src/fields.rs` (mirrored in
`src/domain/fields.ts`) or the vendored spec files. That crate is outside the
workspace so its `jsonschema` dev-dependency never reaches the shipped WASM.

## Architecture Rules

- Keep the Rust core framework-neutral. It should validate NeuroFlow JSON and
  derive execution plans without depending on React or Tauri.
- Keep the WASM API narrow and portable. The current public functions are
  `validate_workflow_json` and `plan_workflow_json`.
- Keep Tauri commands narrow. The renderer visualizes and edits workflow
  documents; Tauri owns native filesystem/process execution after explicit user
  action.
- Do not add broad process-spawning or filesystem powers to the renderer.
  Follow the BIDSvue pattern: known native operations should be named commands
  with complete argument validation on the Rust side.
- When adding actual execution, prefer structured progress/provenance events
  over untyped stdout parsing in the UI.
- Preserve browser fallback behavior where practical. The TypeScript validation
  path in `src/domain/validation.ts` lets the app run outside Tauri.

## Workflow Model Rules

- Workflow documents are object-keyed: `inputs`, `context.fields`, `steps`, and
  `outputs`.
- Step inputs use exactly one of `{ ref }` or `{ constant }`.
- Valid refs follow the existing forms:
  - `inputs.<name>`
  - `context`
  - `context.<field>`
  - `steps.<step>.outputs.<output>`
- Graph node ids use `inputs`, `context`, and `step:<stepId>`.
- UI node positions live under the `neuroflow/ui` extension key. Keep document
  data and UI layout metadata distinct.
- Keep `src/domain/neuroflow.ts`, `src/domain/validation.ts`, and
  `crates/neuroflow-core/src/lib.rs` in sync when changing the schema surface.

## UI And Design Rules

- Follow BIDSvue's workbench language: dense panes, hard borders, bottom status
  bar, restrained surfaces, and Cambridge Blue selection/accent tokens.
- Do not import BIDSvue Svelte components into this React scaffold. Mirror
  stable tokens and interaction conventions locally.
- Keep `src/styles/bidsui.css` aligned with
  BIDSvue's `src/lib/styles/theme.css` when the shared visual
  language changes.
- Use lucide-react icons for toolbar and action affordances.
- Prefer full-height workbench surfaces over landing-page or marketing layouts.
- Keep graph interactions predictable: dragging updates stored UI positions,
  selection drives the inspector, and reference wiring should remain visible and
  readable.

## Working Norms

- Stay lean. NeuroFlow is an orchestrator; heavy lifting belongs in tools such
  as dcm2niix, BIDS validators, NiiVue, and future adapter binaries.
- Add Rust for boundaries, portability, or measured core logic, not for UI
  convenience.
- Update [docs/architecture.md](docs/architecture.md) or
  [docs/source-lineage.md](docs/source-lineage.md) when a change alters a
  long-lived decision.
- Keep fixture changes intentional. `fixtures/dicom-to-bids.neuroflow.json` and
  `src/data/sample.ts` should continue to tell the same coherent demo story
  unless the demo itself is being changed.
- Do not rename BIDSvue, BIDSui, NiiVue Desktop, or NeuroFlow concepts casually;
  the source-lineage doc is the naming map.
- No emoji in source, scripts, docs, or generated reports.
- An app CLI tool (`extensions["neuroflow/app-cli"]`, e.g. `bidsvue-ingest`)
  is checked by `resolveAppCli` in `gallery/scripts/adapter_lib.mjs`, shared by
  `app_cli.mjs` (before the run) and `check_tool.mjs` (Environment panel): the
  app checkout, its `entry` file, the runner (`bun`), then the app's own
  readiness `probe` run in the checkout. The app owns its dependency checks
  (BIDSvue: `neuroflow-ingest --check` prints `{ ready, problems[] }` and
  checks dcm2niix); NeuroFlow does not copy them. Keep the checkout lookup in
  step with the Rust runtime (`crates/neuroflow-mcp/src/registry.rs`
  `default_checkout`): an override that is not a directory falls through to the
  sibling, and the walk tries the registry root and two ancestors. The JS side
  also requires `entry` in a sibling, so BIDSvue's `$TMPDIR/bidsui` WebKit
  cache is never taken for the checkout.
- `bidsvue-ingest` declares branch `neuroflow/window-ingest` (BIDSvue's CLI plus
  the window mode). Merge order: niivue/BIDSvue#16 (CI fix), then rebase #17
  and #18 onto it, merge #18 (headless CLI with `--check`), then NeuroFlow
  #12, #13, #14. After #18 merges, switch `bidsvue-ingest`'s `branch` and
  requirements text to `main`; the `bidsvue` window tool stays on
  `neuroflow/window-ingest` until that branch gets its own PR.
- Deferred from the 2026-10 audit (see `audit_response.md`): a table-driven
  adapter dispatch in `check_tool.mjs` and `src/data/registry.ts` (with
  `providerLabel`), classifying script tools by `launch.script` instead of
  extension presence, checking that a result-dir output is a directory, and
  bounding the checkout walk at the NeuroFlow root.

## Source Lineage To Respect

NiiVue Desktop workflow concepts currently preserved:

- object-keyed workflow steps
- `ref` and `constant` bindings
- synthetic input and context graph nodes
- per-input and per-output graph handles
- context `outputMappings`
- block palette entries derived from tool definitions
- validation as a first-class editing surface

BIDSvue conventions currently mirrored:

- neutral workbench surfaces
- Cambridge Blue selection/accent variables
- pane borders rather than decorative shadows
- bottom status bar summary
- narrow Tauri command boundary
- webview-owned TypeScript orchestration with native execution behind Tauri
