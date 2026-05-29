import {
  AlertTriangle,
  CheckCircle2,
  CircleSlash,
  Clock3,
  Loader2,
  TerminalSquare
} from 'lucide-react'
import type { RunStepResult, WorkflowRunResult } from '../domain/execution'
import type { WorkflowPlan } from '../domain/neuroflow'

interface RunTimelineProps {
  plan: WorkflowPlan | null
  run: WorkflowRunResult | null
  planning: boolean
  executing: boolean
}

export function RunTimeline({ plan, run, planning, executing }: RunTimelineProps): JSX.Element {
  const state = getTimelineState(run, planning, executing)
  const runSteps = run?.steps ?? []
  const showRun = runSteps.length > 0

  return (
    <section className="nf-panel nf-timeline">
      <header className="nf-panel-header">
        <div>
          <p className="nf-eyebrow">Execution</p>
          <h2>{showRun ? 'Run Monitor' : 'Run Plan'}</h2>
        </div>
        <TerminalSquare size={16} />
      </header>

      <div className={`nf-run-state ${state.className}`}>
        {state.icon}
        <span>{state.label}</span>
      </div>

      {showRun ? (
        <ol className="nf-plan-list nf-run-list">
          {runSteps.map((step) => (
            <RunTimelineStep key={step.id} step={step} />
          ))}
        </ol>
      ) : (
        <ol className="nf-plan-list">
          {(plan?.steps ?? []).map((step) => (
            <li key={step.id}>
              <strong>{step.id}</strong>
              <span>{step.tool}</span>
              {step.writes.length > 0 && <code>{step.writes.join(', ')}</code>}
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}

function RunTimelineStep({ step }: { step: RunStepResult }): JSX.Element {
  const outputNames = Object.keys(step.outputs ?? {})
  const streamSummary = summarizeStreams(step.streams)
  const sessionSummary = summarizeSession(step.session)

  return (
    <li className={`nf-run-step is-${step.status}`}>
      <span className="nf-run-step-icon">{iconForStatus(step.status)}</span>
      <div className="nf-run-step-main">
        <strong>{step.id}</strong>
        <span>{step.tool}</span>
        <small>{step.message}</small>
        {sessionSummary && <small className="nf-run-session">{sessionSummary}</small>}
        {streamSummary && <small className="nf-run-streams">{streamSummary}</small>}
        {outputNames.length > 0 && <code>{outputNames.join(', ')}</code>}
      </div>
      <em>{adapterLabel(step.adapter)}</em>
    </li>
  )
}

function getTimelineState(
  run: WorkflowRunResult | null,
  planning: boolean,
  executing: boolean
): { label: string; className: string; icon: JSX.Element } {
  if (executing) {
    return {
      label: 'Executing workflow',
      className: 'is-active',
      icon: <Loader2 className="nf-spin" size={16} />
    }
  }
  if (run?.status === 'failed') {
    return {
      label: 'Run failed',
      className: 'is-failed',
      icon: <AlertTriangle size={16} />
    }
  }
  if (run?.status === 'blocked') {
    return {
      label: 'Run blocked',
      className: 'is-blocked',
      icon: <CircleSlash size={16} />
    }
  }
  if (run?.status === 'succeeded') {
    return {
      label: 'Run succeeded',
      className: 'is-complete',
      icon: <CheckCircle2 size={16} />
    }
  }
  if (planning) {
    return {
      label: 'Planning run graph',
      className: 'is-active',
      icon: <Clock3 size={16} />
    }
  }
  return {
    label: 'Preview ready',
    className: 'is-complete',
    icon: <CheckCircle2 size={16} />
  }
}

function iconForStatus(status: RunStepResult['status']): JSX.Element {
  switch (status) {
    case 'running':
      return <Loader2 className="nf-spin" size={14} />
    case 'succeeded':
      return <CheckCircle2 size={14} />
    case 'blocked':
      return <CircleSlash size={14} />
    case 'failed':
      return <AlertTriangle size={14} />
    case 'pending':
      return <Clock3 size={14} />
  }
}

function adapterLabel(adapter: RunStepResult['adapter']): string {
  switch (adapter) {
    case 'console':
      return 'cli'
    case 'webService':
      return 'service'
    case 'uiApp':
      return 'app'
    case 'internal':
      return 'internal'
    case 'none':
      return 'none'
  }
}

function summarizeSession(session: RunStepResult['session']): string | null {
  if (!session) return null
  const watches = session.watches.filter((watch) => watch.observed).length
  return `${session.appId} ${session.state} · ${watches}/${session.watches.length} observed`
}

function summarizeStreams(streams: RunStepResult['streams']): string | null {
  if (!streams) return null

  const parts = (['stdout', 'stderr'] as const)
    .map((name) => {
      const text = streams[name]?.text ?? ''
      return text.length > 0 ? `${name} ${text.length}b` : null
    })
    .filter((part): part is string => part !== null)

  return parts.length > 0 ? parts.join(' · ') : null
}
