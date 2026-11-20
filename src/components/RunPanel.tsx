import type React from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  CirclePlay,
  Clock3,
  FolderOpen,
  Loader2,
  ScrollText,
  TerminalSquare,
  XCircle
} from 'lucide-react'
import type { ParameterDef, ValidationReport, WorkflowDocument } from '../domain/neuroflow'
import { idTail, shortType } from '../domain/neuroflow'
import type { RunFinishedEvent, RunStepRecord } from '../domain/runTypes'
import { isArtifactDescriptor } from '../domain/runTypes'
import { buildPayload, isLocked, missingInputs, seedValues } from '../domain/runInputs'

export type HostRunStatus = 'starting' | 'running' | 'completed' | 'failed' | 'cancelled' | 'rejected'

export interface HostRunState {
  ticket: string | null
  workflowId: string
  status: HostRunStatus
  progress: number
  total: number
  message: string
  currentStep: string | null
  finished: RunFinishedEvent | null
  stderrTail: string | null
  error: string | null
  /** Epoch ms the run started. Optional: without it the panel times the run from when it first sees it. */
  startedAt?: number
  /** Epoch ms `currentStep` started; same fallback. */
  stepStartedAt?: number
  /** Epoch ms the run ended; same fallback. */
  endedAt?: number
}

export interface RunPanelProps {
  workflow: WorkflowDocument
  available: boolean
  report: ValidationReport
  /** Reason the workflow cannot run on this host; null when runnable; undefined when unknown. */
  runnable: string | null | undefined
  environmentChecked: boolean
  run: HostRunState | null
  /** Seeds the form when the workflow changes; wins over stored values. */
  initialInputs?: Record<string, unknown>
  /** Input name to a label shown instead of the field; the host fills these. */
  lockedInputs?: Record<string, string>
  /** `rerun` asks the engine to run anew instead of reusing an identical earlier run (neuroflow-mcp `rerun`). */
  onStart: (inputs: Record<string, unknown>, options?: { rerun?: boolean }) => void
  onCancel: () => void
  /** Whether onCancel can act on the current run; defaults to true while a run is in progress. */
  canCancel?: boolean
  onOpen: (path: string) => void
  /** Names the action for an output path (default "Open"), e.g. "Load" or "Reveal". */
  openLabel?: (path: string) => string
}

const RUN_INPUTS_STORAGE_KEY = 'neuroflow.runInputs.v1'

/** Run monitor (design: RunMonitor artboard): inputs form, progress, steps, outputs. */
export function RunPanel({ workflow, available, report, runnable, environmentChecked, run, initialInputs, lockedInputs, onStart, onCancel, canCancel = true, onOpen, openLabel }: RunPanelProps): React.JSX.Element {
  const [values, setValues] = useState<Record<string, string>>(() => seedValues(loadInputs(workflow), initialInputs))

  useEffect(() => {
    setValues(seedValues(loadInputs(workflow), initialInputs))
  }, [workflow.id, JSON.stringify(initialInputs ?? null)]) // by value: hosts may pass a fresh object each render

  useEffect(() => {
    storeInputs(workflow.id, values)
  }, [values, workflow.id])

  const inputs = useMemo(() => Object.entries(workflow.inputs), [workflow.inputs])
  const missing = missingInputs(workflow, values, lockedInputs)
  const isRunning = run?.status === 'starting' || run?.status === 'running'

  const blocker = !available
    ? 'Runs need the desktop app (npm run tauri:dev).'
    : Object.keys(workflow.steps).length === 0
      ? 'Add a step first.'
      : !report.ok
        ? `Fix ${report.issues.length} validation issue${report.issues.length === 1 ? '' : 's'} first.`
        : !environmentChecked
          ? 'Waiting for the environment check.'
          : runnable
            ? runnable
            : missing.length > 0
              ? `Set ${missing.join(', ')}.`
              : isRunning
                ? 'A run is in progress.'
                : null

  function start(): void {
    onStart(buildPayload(workflow, values, lockedInputs))
  }

  function rerun(): void {
    onStart(buildPayload(workflow, values, lockedInputs), { rerun: true })
  }

  const clock = useRunClock(run)
  const steps = run ? stepRows(workflow, run, clock) : []
  const finished = run?.finished && run.finished.ok !== false && 'record' in run.finished ? run.finished : null
  const outputs = finished ? Object.entries(finished.structured.outputs ?? {}) : []

  return (
    <section className="nf-panel nf-run-panel">
      <header className="nf-panel-header">
        <div>
          <p className="nf-eyebrow">Execution</p>
          <h2>Run</h2>
        </div>
        <TerminalSquare size={16} />
      </header>

      {inputs.length > 0 && (
        <div className="nf-run-inputs">
          {inputs.map(([name, def]) => isLocked(lockedInputs, name) ? (
            <div className="nf-field" key={name}>
              <span>
                {name}
                <code>{shortType(def.type)}</code>
              </span>
              <em className="nf-run-locked">{lockedInputs?.[name]}</em>
            </div>
          ) : (
            <label className="nf-field" key={name}>
              <span>
                {name}
                <code>{shortType(def.type)}</code>
                {def.optional !== true && def.default === undefined && <b title="required">*</b>}
              </span>
              {def.enum ? (
                <select disabled={isRunning} value={values[name] ?? ''} onChange={(e) => setValues({ ...values, [name]: e.target.value })}>
                  <option value="">{def.default !== undefined ? `default (${String(def.default)})` : 'choose…'}</option>
                  {def.enum.map((option) => (
                    <option key={String(option)} value={String(option)}>
                      {String(option)}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  disabled={isRunning}
                  placeholder={placeholderFor(def)}
                  spellCheck={false}
                  type={def.type === 'core:number' || def.type === 'core:integer' ? 'number' : 'text'}
                  value={values[name] ?? ''}
                  onChange={(e) => setValues({ ...values, [name]: e.target.value })}
                />
              )}
              {def.description && <small>{def.description}</small>}
            </label>
          ))}
        </div>
      )}

      <div className="nf-run-actions">
        <button
          className="nf-action nf-action-primary"
          disabled={Boolean(blocker)}
          onClick={start}
          title={blocker ?? 'Run on this machine'}
          type="button"
        >
          {isRunning ? <Loader2 className="nf-spin" size={15} /> : <CirclePlay size={15} />}
          {isRunning ? 'Running' : 'Run'}
        </button>
        <button className="nf-action" disabled={!isRunning || !canCancel} onClick={onCancel} title="Stop the current run" type="button">
          <Ban size={15} />
          Cancel
        </button>
        {blocker && !isRunning && <small className="nf-run-blocker">{blocker}</small>}
      </div>

      {run && (
        <>
          <div className={`nf-run-state ${stateClass(run.status)}`}>
            {stateIcon(run.status)}
            <span>{stateLabel(run)}</span>
            {clock.run !== null && !isReused(run) && (
              <span className="nf-run-elapsed" title={isRunning ? 'Elapsed' : 'Duration'}>
                <Clock3 size={13} />
                {formatElapsed(clock.run)}
              </span>
            )}
            {run.status === 'completed' && isReused(run) && (
              <button className="nf-action" disabled={Boolean(blocker)} onClick={rerun} title="Run again even though the inputs are unchanged" type="button">
                <CirclePlay size={15} />
                Run anew
              </button>
            )}
          </div>
          {run.total > 0 && (
            <div className="nf-progress" aria-label="run progress">
              <i style={{ width: `${Math.min(100, (run.progress / run.total) * 100)}%` }} />
            </div>
          )}

          {steps.length > 0 && (
            <ol className="nf-plan-list nf-run-list">
              {steps.map((step) => (
                <li className={`nf-run-step is-${step.status}`} key={step.id}>
                  <span className="nf-run-step-icon">{stepIcon(step.status)}</span>
                  <div className="nf-run-step-main">
                    <strong>{step.id}</strong>
                    <small>{step.detail}</small>
                  </div>
                </li>
              ))}
            </ol>
          )}

          {run.error && (
            <p className="nf-issue nf-run-error">
              <AlertTriangle size={13} />
              <span>{run.error}</span>
            </p>
          )}

          {run.stderrTail && (
            <details className="nf-run-log" open>
              <summary>
                <ScrollText size={13} /> stderr (tail)
              </summary>
              <pre>{run.stderrTail}</pre>
            </details>
          )}

          {finished && outputs.length > 0 && (
            <>
              <p className="nf-eyebrow nf-env-heading">Outputs</p>
              <ul className="nf-env-list nf-run-outputs">
                {outputs.map(([name, value]) => (
                  <OutputRow key={name} name={name} value={value} onOpen={onOpen} openLabel={openLabel} />
                ))}
              </ul>
            </>
          )}

          {finished && (
            <div className="nf-run-footer">
              <button className="nf-mini-action" onClick={() => onOpen(finished.sessionDir)} title={finished.sessionDir} type="button">
                <FolderOpen size={13} />
                Run folder
              </button>
              <button className="nf-mini-action" onClick={() => onOpen(`${finished.sessionDir}/run.provenance.json`)} type="button">
                <ScrollText size={13} />
                Provenance
              </button>
              <small title={finished.summary}>{finished.runId}</small>
            </div>
          )}
        </>
      )}
    </section>
  )
}

function OutputRow({ name, value, onOpen, openLabel }: { name: string; value: unknown; onOpen: (path: string) => void; openLabel?: (path: string) => string }): React.JSX.Element {
  const items = Array.isArray(value) ? value : [value]
  return (
    <li className="nf-env-item">
      <CheckCircle2 size={13} />
      <span>
        <strong>{name}</strong>
        {items.map((item, index) =>
          isArtifactDescriptor(item) ? (
            <small className="nf-run-output" key={index}>
              <code title={item.path}>{item.path.split('/').pop()}</code>
              <em>{shortType(item.type)}{item.bytes !== undefined ? ` · ${formatBytes(item.bytes)}` : ''}</em>
              <button className="nf-mini-action" onClick={() => onOpen(item.path)} title={`${openLabel?.(item.path) ?? 'Reveal'} ${item.path}`} type="button">
                <FolderOpen size={12} />
                {openLabel?.(item.path) ?? 'Open'}
              </button>
            </small>
          ) : (
            <small key={index}>
              <code>{typeof item === 'string' ? item : JSON.stringify(item)}</code>
            </small>
          )
        )}
      </span>
    </li>
  )
}

interface StepRow {
  id: string
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped'
  detail: string
}

function stepRows(workflow: WorkflowDocument, run: HostRunState, clock: RunClock): StepRow[] {
  const record = run.finished && run.finished.ok !== false && 'record' in run.finished ? run.finished.record : null
  const stepIds = record?.steps ? Object.keys(record.steps) : Object.keys(workflow.steps)
  const currentIndex = run.currentStep ? stepIds.indexOf(run.currentStep) : -1

  return stepIds.map((id, index) => {
    const rec: RunStepRecord | undefined = record?.steps?.[id]
    if (rec) {
      const status = rec.status === 'completed' || rec.status === 'succeeded'
        ? 'succeeded'
        : rec.status === 'failed'
          ? 'failed'
          : rec.status === 'skipped'
            ? 'skipped'
            : 'pending'
      const duration = rec.startedAt && rec.endedAt ? formatDuration(rec.startedAt, rec.endedAt) : ''
      const detail = rec.error ? rec.error : [idTail(rec.tool), duration].filter(Boolean).join(' · ')
      return { id, status, detail }
    }
    if (run.status === 'rejected') return { id, status: 'skipped', detail: idTail(workflow.steps[id]?.tool ?? '') }
    if (currentIndex >= 0 && index < currentIndex) return { id, status: 'succeeded', detail: idTail(workflow.steps[id]?.tool ?? '') }
    if (index === currentIndex) {
      const detail = [idTail(workflow.steps[id]?.tool ?? ''), clock.step !== null ? formatElapsed(clock.step) : ''].filter(Boolean).join(' · ')
      return { id, status: run.status === 'failed' ? 'failed' : 'running', detail }
    }
    return { id, status: 'pending', detail: idTail(workflow.steps[id]?.tool ?? '') }
  })
}

function stateClass(status: HostRunStatus): string {
  if (status === 'starting' || status === 'running') return 'is-active'
  if (status === 'failed') return 'is-failed'
  if (status === 'rejected') return 'is-blocked'
  if (status === 'cancelled') return 'is-blocked'
  return ''
}

function stateIcon(status: HostRunStatus): React.JSX.Element {
  if (status === 'starting' || status === 'running') return <Loader2 className="nf-spin" size={14} />
  if (status === 'completed') return <CheckCircle2 size={14} />
  if (status === 'rejected') return <Ban size={14} />
  if (status === 'cancelled') return <Ban size={14} />
  return <XCircle size={14} />
}

function isReused(run: HostRunState): boolean {
  return Boolean(run.finished && 'structured' in run.finished && run.finished.structured?.reused)
}

// Progress may never report a total (a fast or single-step run); run.json still lists the steps.
function completedLabel(run: HostRunState): string {
  const record = run.finished && 'record' in run.finished ? run.finished.record : null
  const total = run.total || Object.keys(record?.steps ?? {}).length
  return `Completed · ${total} step${total === 1 ? '' : 's'}`
}

function stateLabel(run: HostRunState): string {
  switch (run.status) {
    case 'starting':
      return 'Starting…'
    case 'running':
      return run.message || `Step ${run.progress} of ${run.total}`
    case 'completed':
      if (isReused(run)) {
        const runId = run.finished && 'runId' in run.finished ? run.finished.runId : ''
        return `Reused ${runId || 'an earlier run'} · inputs unchanged, nothing ran`
      }
      return completedLabel(run)
    case 'failed':
      return run.currentStep ? `Failed at ${run.currentStep}` : 'Failed'
    case 'cancelled':
      return 'Cancelled'
    case 'rejected':
      return 'Rejected before any step started'
  }
}

function stepIcon(status: StepRow['status']): React.JSX.Element {
  switch (status) {
    case 'running':
      return <Loader2 className="nf-spin" size={14} />
    case 'succeeded':
      return <CheckCircle2 size={14} />
    case 'failed':
      return <XCircle size={14} />
    case 'skipped':
      return <Ban size={14} />
    default:
      return <Clock3 size={14} />
  }
}

function loadInputs(workflow: WorkflowDocument): Record<string, string> {
  const defaults: Record<string, string> = {}
  for (const [name, def] of Object.entries(workflow.inputs)) {
    if (def.default !== undefined && def.default !== null) defaults[name] = String(def.default)
  }
  try {
    if (typeof localStorage === 'undefined') return defaults
    const raw = window.localStorage.getItem(RUN_INPUTS_STORAGE_KEY)
    const all = raw ? (JSON.parse(raw) as Record<string, Record<string, string>>) : {}
    return { ...defaults, ...(all[workflow.id] ?? {}) }
  } catch {
    return defaults
  }
}

function storeInputs(workflowId: string, values: Record<string, string>): void {
  try {
    const raw = window.localStorage.getItem(RUN_INPUTS_STORAGE_KEY)
    const all = raw ? (JSON.parse(raw) as Record<string, Record<string, string>>) : {}
    all[workflowId] = values
    window.localStorage.setItem(RUN_INPUTS_STORAGE_KEY, JSON.stringify(all))
  } catch {
    // storage is a convenience only
  }
}

function placeholderFor(def: ParameterDef): string {
  if (def.default !== undefined) return `default: ${String(def.default)}`
  if (def.type.startsWith('core:')) return shortType(def.type)
  return '/absolute/path inside a data root'
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function formatDuration(start: string, end: string): string {
  const ms = Date.parse(end) - Date.parse(start)
  if (!Number.isFinite(ms) || ms < 0) return ''
  if (ms < 1000) return `${ms} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`
  return formatElapsed(ms)
}

/** Whole seconds, minutes, or hours: "42 s", "12 min 03 s", "1 h 11 min". */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const sec = total % 60
  if (h > 0) return `${h} h ${String(m).padStart(2, '0')} min`
  if (m > 0) return `${m} min ${String(sec).padStart(2, '0')} s`
  return `${sec} s`
}

interface RunClock {
  /** ms the run has taken so far, or took; null when there is no run to time. */
  run: number | null
  /** ms the current step has been running; null when no step is running. */
  step: number | null
}

/**
 * Times the run and its current step, ticking each second while it is active.
 * Host timestamps win; otherwise it uses when the panel first saw the run, the
 * step change, and the end. A finished run with run.json times uses those.
 */
function useRunClock(run: HostRunState | null): RunClock {
  const active = run?.status === 'starting' || run?.status === 'running'
  const [now, setNow] = useState(() => Date.now())
  const seen = useRef<{ run: HostRunState | null; start: number | null; sawActive: boolean; step: string | null; stepStart: number | null; end: number | null }>(
    { run: null, start: null, sawActive: false, step: null, stepStart: null, end: null }
  )

  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active])

  const s = seen.current
  if (!run) {
    seen.current = { run: null, start: null, sawActive: false, step: null, stepStart: null, end: null }
    return { run: null, step: null }
  }
  const t = Date.now()
  // A new run: none before, or the last one had ended and this one is active.
  if (s.start === null || (active && s.end !== null) || (run.status === 'starting' && s.run?.status !== 'starting')) {
    s.start = t; s.sawActive = active; s.end = null; s.step = null; s.stepStart = null
  }
  if (run.currentStep !== s.step) { s.step = run.currentStep; s.stepStart = t }
  if (!active && s.end === null) s.end = t
  s.run = run

  const record = run.finished && 'record' in run.finished ? run.finished.record : null
  const recordMs = record?.startedAt && record.endedAt ? Date.parse(record.endedAt) - Date.parse(record.startedAt) : NaN
  const start = run.startedAt ?? s.start
  const end = active ? Math.max(now, t) : run.endedAt ?? s.end ?? t
  // A run first seen already over, with no times from the host or run.json, has no duration to show.
  const runMs = !active && Number.isFinite(recordMs) && recordMs >= 0
    ? recordMs
    : run.startedAt !== undefined || s.sawActive ? end - start : null
  const stepStart = run.stepStartedAt ?? s.stepStart
  return {
    run: run.status === 'rejected' ? null : runMs,
    step: active && run.currentStep && stepStart !== null ? Math.max(now, t) - stepStart : null
  }
}
