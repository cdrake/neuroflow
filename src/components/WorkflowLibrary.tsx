import { Database, Plus, Workflow } from 'lucide-react'
import type { WorkflowLibraryItem } from '../domain/neuroflow'

interface WorkflowLibraryProps {
  items: WorkflowLibraryItem[]
  activeId: string
  onSelect: (id: string) => void
  onCreate: () => void
}

export function WorkflowLibrary({
  items,
  activeId,
  onSelect,
  onCreate
}: WorkflowLibraryProps): JSX.Element {
  return (
    <section className="nf-panel">
      <header className="nf-panel-header">
        <div>
          <p className="nf-eyebrow">Library</p>
          <h2>Workflows</h2>
        </div>
        <div className="nf-panel-actions">
          <button className="nf-mini-action" onClick={onCreate} title="New workflow" type="button">
            <Plus size={14} />
            New
          </button>
          <Database size={16} />
        </div>
      </header>
      <div className="nf-list">
        {items.map((item) => (
          <button
            key={item.id}
            className={item.id === activeId ? 'nf-list-item is-active' : 'nf-list-item'}
            onClick={() => onSelect(item.id)}
          >
            <Workflow size={16} />
            <span>
              <strong>{item.label}</strong>
              <small>{item.description}</small>
            </span>
          </button>
        ))}
      </div>
    </section>
  )
}
