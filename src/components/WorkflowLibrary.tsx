import { Database, Workflow } from 'lucide-react'
import type { WorkflowLibraryItem } from '../domain/neuroflow'

interface WorkflowLibraryProps {
  items: WorkflowLibraryItem[]
  activeId: string
  onSelect: (id: string) => void
}

export function WorkflowLibrary({ items, activeId, onSelect }: WorkflowLibraryProps): JSX.Element {
  return (
    <section className="nf-panel">
      <header className="nf-panel-header">
        <div>
          <p className="nf-eyebrow">Library</p>
          <h2>Workflows</h2>
        </div>
        <Database size={16} />
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
