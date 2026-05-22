import { CheckCircle2, Clock3, TerminalSquare } from 'lucide-react'
import type { WorkflowPlan } from '../domain/neuroflow'

interface RunTimelineProps {
  plan: WorkflowPlan | null
  active: boolean
}

export function RunTimeline({ plan, active }: RunTimelineProps): JSX.Element {
  return (
    <section className="nf-panel nf-timeline">
      <header className="nf-panel-header">
        <div>
          <p className="nf-eyebrow">Execution</p>
          <h2>Run Plan</h2>
        </div>
        <TerminalSquare size={16} />
      </header>

      <div className={active ? 'nf-run-state is-active' : 'nf-run-state'}>
        {active ? <Clock3 size={16} /> : <CheckCircle2 size={16} />}
        <span>{active ? 'Planning run graph' : 'Preview ready'}</span>
      </div>

      <ol className="nf-plan-list">
        {(plan?.steps ?? []).map((step) => (
          <li key={step.id}>
            <strong>{step.id}</strong>
            <span>{step.tool}</span>
            {step.writes.length > 0 && <code>{step.writes.join(', ')}</code>}
          </li>
        ))}
      </ol>
    </section>
  )
}
