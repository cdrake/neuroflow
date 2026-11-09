import { createRoot } from 'react-dom/client'
import '@xyflow/react/dist/style.css'
import '@cdrake/neuroflow-react/style.css'
import { PipelineView, toolFromDocument, wrapToolAsWorkflow } from '@cdrake/neuroflow-react'

const toolDoc = {
  kind: 'tool',
  id: 'example/tools/echo',
  inputs: { text: { type: 'string' } },
  outputs: { out: { type: 'string' } }
}
const workflow = wrapToolAsWorkflow(toolDoc)
const tool = toolFromDocument(toolDoc)

createRoot(document.getElementById('root')!).render(
  <div className="nf-root">
    <PipelineView
      items={[{ id: workflow.id, label: 'Echo', description: '', workflow }]}
      activeId={workflow.id}
      onSelect={() => {}}
      workflow={workflow}
      tools={new Map([[tool.id, tool]])}
      run={null}
      lockedInputs={{ text: 'Chosen by the host' }}
      onStart={() => {}}
      onCancel={() => {}}
      onOpen={() => {}}
      targets={<div>targets</div>}
    />
  </div>
)
