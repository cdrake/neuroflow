# Source Lineage

## NiiVue Desktop Workflow Model

The first NeuroFlow app scaffold is based on:

- `niivue/niivue/packages/niivue-desktop/workflows`
- `niivue/niivue/packages/niivue-desktop/src/common/workflowTypes.ts`
- `niivue/niivue/packages/niivue-desktop/src/common/workflowBlocks.ts`
- `niivue/niivue/packages/niivue-desktop/src/common/workflowValidator.ts`
- `niivue/niivue/packages/niivue-desktop/src/renderer/src/components/WorkflowDiagramView.tsx`
- `niivue/niivue/packages/niivue-desktop/src/renderer/src/components/BlockPalette.tsx`

The source concepts preserved in this scaffold are:

- object-keyed workflow steps
- `ref` and `constant` bindings
- synthetic input and context graph nodes
- per-input and per-output graph handles
- context `outputMappings`
- block palette entries derived from tool definitions
- validation as a first-class editing surface

## BIDS UI Direction

The requested design target is BIDSvue (the `bidsui` project by
neurolabusc, not yet public). BIDSvue is a SvelteKit/Tauri app,
not a reusable React component package, so NeuroFlow mirrors its design system
and shell conventions rather than importing Svelte components directly.

Source files used for alignment:

- `bidsui/src/lib/styles/theme.css`
- `bidsui/src/lib/components/Explorer.svelte`
- `bidsui/src/lib/components/Launch.svelte`
- `bidsui/src/lib/components/StatusBar.svelte`
- `bidsui/ARCHITECTURE.md`

NeuroFlow currently adapts these BIDSvue conventions:

- Cambridge Blue selection/accent variables
- neutral `bg-base` / `bg-sidebar` / `bg-elevated` / `bg-statusbar` surfaces
- hard pane borders instead of decorative shadows
- bottom status-bar summary
- narrow Tauri Rust command boundary
- webview-owned TypeScript orchestration with native execution behind Tauri

Keep these files aligned when the BIDSvue visual language changes:

- `src/styles/bidsui.css`
- `src/styles/app.css`
- `src/components/WorkflowLibrary.tsx`
- `src/components/ToolPalette.tsx`
- `src/components/Inspector.tsx`
- `src/components/RunTimeline.tsx`

Keep `src/components/WorkflowDiagram.tsx` close to the NiiVue Desktop graph
semantics unless the shared UI package provides an equivalent graph primitive.
