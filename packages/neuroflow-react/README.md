# @medview/neuroflow-react

Read-only NeuroFlow pipeline view for React hosts: workflow library, diagram, and run panel.
It knows nothing about datasets, Tauri or MCP; the host supplies documents and run state.

## Install

```sh
npm install @medview/neuroflow-react @xyflow/react react react-dom
```

Peers: `react` and `react-dom` `^18.3 || ^19`, `@xyflow/react` `^12`.

## CSS

Import both files once, and put `nf-root` on an ancestor of the view (styles are scoped to it):

```ts
import '@xyflow/react/dist/style.css'
import '@medview/neuroflow-react/style.css'
```

## Example

```tsx
import { PipelineView, toolFromDocument, wrapToolAsWorkflow } from '@medview/neuroflow-react'

const toolDoc = { kind: 'tool', id: 'example/tools/echo', inputs: { text: { type: 'string' } }, outputs: { out: { type: 'string' } } }
const workflow = wrapToolAsWorkflow(toolDoc)
const tool = toolFromDocument(toolDoc)

<div className="nf-root">
  <PipelineView
    items={[{ id: workflow.id, label: 'Echo', description: '', workflow }]}
    activeId={workflow.id}
    onSelect={setActiveId}
    workflow={workflow}
    tools={new Map([[tool.id, tool]])}
    run={run}                          // HostRunState | null
    lockedInputs={{ text: 'Chosen by the host' }}
    onStart={(inputs) => start(inputs)}
    onCancel={cancel}
    canCancel={true}                   // optional; false holds Cancel back while a run is in progress
    onOpen={(path) => reveal(path)}
    targets={<MyTargetPicker />}       // host slot above the run panel
  />
</div>
```

## Filling `HostRunState` from `neuroflow-mcp`

The host owns the process and keeps one `HostRunState` per run:

- `starting`: when you send `tools/call` for the workflow's MCP tool name. Set `workflowId`. `ticket` is
  the host's own run handle; the panel doesn't read it. Cancel is enabled while the run is `starting` or `running`;
  pass `canCancel={false}` until `onCancel` can act (the desktop app does this until its ticket arrives).
- `running`: on each MCP progress notification set `progress`, `total`, `message`, and `currentStep`.
- `completed`: on the result, set `finished` from `structuredContent`; add `sessionDir` and the `run.json` record
  (`record.steps` gives per-step status). Set `stderrTail` from `structured.logs?.stderr ?? null`.
- Reused runs: `neuroflow-mcp` answers a repeat call with identical, unchanged inputs by returning the earlier
  completed run with `structuredContent.reused: true`, and nothing executes. Keep that flag in `finished.structured`:
  the panel then says the run was reused and offers "Run anew", which calls `onStart(inputs, { rerun: true })`. Send
  `rerun: true` alongside the inputs in that `tools/call` to force a fresh run.
- `failed` / `rejected` / `cancelled`: set `error` (for a JSON-RPC error or a process exit, include the stderr tail).

`neuroflow-mcp` exposes no `run.json` resource, so the host reads `<sessions>/<runId>/run.json` itself.
Types (`RunFinishedEvent`, `RunRecord`, ...) are exported from the package.

`npm run lib:check` needs network access (it installs the packed tarball and its peers from npm).
