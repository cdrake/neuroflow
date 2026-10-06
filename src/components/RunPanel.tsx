import { useEffect, useMemo, useState } from 'react'
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
import { shortType } from '../domain/neuroflow'
import type { RunFinishedEvent, RunStepRecord } from '../domain/host'
import { isArtifactDescriptor } from '../domain/host'
import { idTail } from '../data/gallery'

export type HostRunStatus = 'starting' | 'running' | 'completed' | 'failed' | 'rejected'

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
}

interface RunPanelProps {
  workflow: WorkflowDocument
  available: boolean
  report: ValidationReport
  /** Reason the workflow cannot run on this host; null when runnable; undefined when unknown. */
  runnable: string | null | undefined
  environmentChecked: boolean
  run: HostRunState | null
  onStart: (inputs: Record<string, unknown>) => void
  onOpen: (path: string) => void
}

const RUN_INPUTS_STORAGE_KEY = 'neuroflow.runInputs.v1'

/** Run monitor (design: RunMonitor artboard): inputs form, progress, steps, outputs. */
export function RunPanel({ workflow, available, report, runnable, environmentChecked, run, onStart, onOpen }: RunPanelProps): JSX.Element {
  const [values, setValues] = useState<Record<string, string>>(() => loadInputs(workflow))

  useEffect(() => {
    setValues(loadInputs(workflow))
  }, [workflow.id])

  useEffect(() => {
    storeInputs(workflow.id, values)
  }, [values, workflow.id])

  const inputs = useMemo(() => Object.entries(workflow.inputs), [workflow.inputs])
  const missing = inputs
    .filter(([name, def]) => def.optional !== true && def.default === undefined && !values[name]?.trim())
    .map(([name]) => name)
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
    const payload: Record<string, unknown> = {}
    for (const [name, def] of inputs) {
      const raw = values[name]
      if (raw === undefined || raw.trim() === '') continue
      payload[name] = coerce(raw, def)
    }
    onStart(payload)
  }

  const steps = run ? stepRows(workflow, run) : []
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
          {inputs.map(([name, def]) => (
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
        <button className="nf-action" disabled title="Cancel is not supported yet" type="button">
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
                  <OutputRow key={name} name={name} value={value} onOpen={onOpen} />
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

function OutputRow({ name, value, onOpen }: { name: string; value: unknown; onOpen: (path: string) => void }): JSX.Element {
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
              <button className="nf-mini-action" onClick={() => onOpen(item.path)} title={`Reveal ${item.path}`} type="button">
                <FolderOpen size={12} />
                Open
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

function stepRows(workflow: WorkflowDocument, run: HostRunState): StepRow[] {
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
      return { id, status: run.status === 'failed' ? 'failed' : 'running', detail: idTail(workflow.steps[id]?.tool ?? '') }
    }
    return { id, status: 'pending', detail: idTail(workflow.steps[id]?.tool ?? '') }
  })
}

function stateClass(status: HostRunStatus): string {
  if (status === 'starting' || status === 'running') return 'is-active'
  if (status === 'failed') return 'is-failed'
  if (status === 'rejected') return 'is-blocked'
  return ''
}

function stateIcon(status: HostRunStatus): JSX.Element {
  if (status === 'starting' || status === 'running') return <Loader2 className="nf-spin" size={14} />
  if (status === 'completed') return <CheckCircle2 size={14} />
  if (status === 'rejected') return <Ban size={14} />
  return <XCircle size={14} />
}

function stateLabel(run: HostRunState): string {
  switch (run.status) {
    case 'starting':
      return 'Starting…'
    case 'running':
      return run.message || `Step ${run.progress} of ${run.total}`
    case 'completed':
      return `Completed · ${run.total} step${run.total === 1 ? '' : 's'}`
    case 'failed':
      return run.currentStep ? `Failed at ${run.currentStep}` : 'Failed'
    case 'rejected':
      return 'Rejected before any step started'
  }
}

function stepIcon(status: StepRow['status']): JSX.Element {
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

function coerce(raw: string, def: ParameterDef): unknown {
  const value = raw.trim()
  if (def.type === 'core:number' || def.type === 'core:integer') {
    const n = Number(value)
    return Number.isFinite(n) ? n : value
  }
  if (def.type === 'core:boolean') return value === 'true' || value === '1' || value === 'yes'
  if (def.type === 'core:json' || def.type === 'core:object') {
    try {
      return JSON.parse(value)
    } catch {
      return value
    }
  }
  return value
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
  return `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`
}
