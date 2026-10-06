import { useState } from 'react'
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, Loader2, MonitorCog, RefreshCw, Settings2 } from 'lucide-react'
import type { EnvironmentReport, HostSettings, ToolStatus } from '../domain/host'
import { idTail } from '../data/gallery'

interface EnvironmentPanelProps {
  available: boolean
  settings: HostSettings | null
  report: EnvironmentReport | null
  checking: boolean
  error: string | null
  onCheck: () => void
  onChangeSettings: (settings: HostSettings) => void
}

/**
 * Up-front environment check (design: Environment artboard). Every tool that
 * needs the user to install or point at something is listed here with the fix,
 * before any run is attempted; nothing surfaces as a traceback later.
 */
export function EnvironmentPanel({
  available,
  settings,
  report,
  checking,
  error,
  onCheck,
  onChangeSettings
}: EnvironmentPanelProps): JSX.Element {
  const [expanded, setExpanded] = useState(true)
  const [showSettings, setShowSettings] = useState(false)

  const counts = summarize(report)
  const needsSetup = (report?.tools ?? []).filter((tool) => tool.status === 'needsSetup')
  const interactive = (report?.tools ?? []).filter((tool) => tool.status === 'interactive')

  return (
    <section className="nf-panel nf-environment">
      <header className="nf-panel-header">
        <button
          aria-expanded={expanded}
          className="nf-panel-toggle"
          onClick={() => setExpanded((value) => !value)}
          type="button"
        >
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <div>
            <p className="nf-eyebrow">Host</p>
            <h2>Environment</h2>
          </div>
        </button>
        <div className="nf-panel-actions">
          {available && (
            <button className="nf-mini-action" disabled={checking} onClick={onCheck} title="Re-run the environment check" type="button">
              {checking ? <Loader2 className="nf-spin" size={13} /> : <RefreshCw size={13} />}
              {checking ? 'Checking' : 'Check'}
            </button>
          )}
          <MonitorCog size={16} />
        </div>
      </header>

      {!available && (
        <p className="nf-empty-panel">
          Browser preview: tools are listed from the gallery, but nothing can be probed or run here.
          Open the desktop app (<code>npm run tauri:dev</code>) to check and run.
        </p>
      )}

      {available && report && (
        <div className="nf-env-summary" title={`checked ${report.checkedAt}`}>
          <span className="nf-badge nf-badge-ready">{counts.ready} ready</span>
          <span className={counts.setup ? 'nf-badge nf-badge-setup' : 'nf-badge nf-badge-muted'}>{counts.setup} setup</span>
          <span className="nf-badge nf-badge-interactive">{counts.interactive} interactive</span>
          {counts.unsupported > 0 && <span className="nf-badge nf-badge-muted">{counts.unsupported} no runner</span>}
        </div>
      )}

      {available && !report && !checking && !error && (
        <p className="nf-empty-panel">Not checked yet.</p>
      )}

      {error && (
        <p className="nf-issue">
          <AlertTriangle size={13} />
          <span>{error}</span>
        </p>
      )}

      {expanded && available && report && (
        <>
          {report.warnings.map((warning) => (
            <p className="nf-issue" key={warning}>
              <AlertTriangle size={13} />
              <span>{warning}</span>
            </p>
          ))}

          <p className="nf-eyebrow nf-env-heading">Interpreters</p>
          <ul className="nf-env-list">
            {report.interpreters.map((interp) => (
              <li className={interp.path ? 'nf-env-item' : 'nf-env-item is-missing'} key={interp.name}>
                {interp.path ? <CheckCircle2 size={13} /> : <AlertTriangle size={13} />}
                <span>
                  <strong>{interp.name}</strong>
                  <small>
                    {interp.path ? `${interp.version ?? 'version unknown'} · ${interp.path}` : 'not found on PATH'}
                    {interp.requiredBy.length > 0 && ` · used by ${interp.requiredBy.map(idTail).join(', ')}`}
                  </small>
                </span>
              </li>
            ))}
          </ul>

          {needsSetup.length > 0 && (
            <>
              <p className="nf-eyebrow nf-env-heading">Needs setup</p>
              <ul className="nf-env-list">
                {needsSetup.map((tool) => (
                  <SetupItem key={tool.id} tool={tool} />
                ))}
              </ul>
            </>
          )}

          {interactive.length > 0 && (
            <p className="nf-env-note">
              {interactive.map((tool) => idTail(tool.id)).join(' and ')} {interactive.length === 1 ? 'is' : 'are'} interactive:
              the host window for these apps is not wired into the builder yet, so workflows containing them stay editable but
              cannot be run from here.
            </p>
          )}
        </>
      )}

      {available && settings && (
        <>
          <button
            aria-expanded={showSettings}
            className="nf-mini-action nf-env-settings-toggle"
            onClick={() => setShowSettings((value) => !value)}
            type="button"
          >
            <Settings2 size={13} />
            {showSettings ? 'Hide settings' : 'Settings'}
          </button>
          {showSettings && <SettingsForm settings={settings} onChange={onChangeSettings} />}
        </>
      )}
    </section>
  )
}

function SetupItem({ tool }: { tool: ToolStatus }): JSX.Element {
  return (
    <li className="nf-env-item is-setup">
      <AlertTriangle size={13} />
      <span>
        <strong>{idTail(tool.id)}</strong>
        <small>{tool.detail}</small>
        {tool.fix && <small className="nf-env-fix">Fix: {tool.fix}</small>}
      </span>
    </li>
  )
}

function SettingsForm({ settings, onChange }: { settings: HostSettings; onChange: (settings: HostSettings) => void }): JSX.Element {
  const [draft, setDraft] = useState({
    registryDirs: settings.registryDirs.join('\n'),
    dataRoots: settings.dataRoots.join('\n'),
    sessionsRoot: settings.sessionsRoot,
    interpreters: Object.entries(settings.interpreters)
      .map(([name, path]) => `${name}=${path}`)
      .join('\n')
  })

  function apply(): void {
    const interpreters: Record<string, string> = {}
    for (const line of lines(draft.interpreters)) {
      const eq = line.indexOf('=')
      if (eq > 0) interpreters[line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
    }
    onChange({
      registryDirs: lines(draft.registryDirs),
      dataRoots: lines(draft.dataRoots),
      sessionsRoot: draft.sessionsRoot.trim(),
      interpreters
    })
  }

  return (
    <div className="nf-env-settings">
      <label className="nf-field">
        <span>Registry directories (one per line)</span>
        <textarea rows={2} value={draft.registryDirs} onChange={(e) => setDraft({ ...draft, registryDirs: e.target.value })} />
      </label>
      <label className="nf-field">
        <span>Data roots (one per line)</span>
        <textarea rows={2} value={draft.dataRoots} onChange={(e) => setDraft({ ...draft, dataRoots: e.target.value })} />
      </label>
      <label className="nf-field">
        <span>Sessions root</span>
        <input value={draft.sessionsRoot} onChange={(e) => setDraft({ ...draft, sessionsRoot: e.target.value })} />
      </label>
      <label className="nf-field">
        <span>Interpreters (name=path per line, e.g. python3=~/.venvs/neuroflow/bin/python)</span>
        <textarea rows={2} value={draft.interpreters} onChange={(e) => setDraft({ ...draft, interpreters: e.target.value })} />
      </label>
      <button className="nf-action nf-action-compact" onClick={apply} type="button">
        Apply and re-check
      </button>
    </div>
  )
}

function lines(value: string): string[] {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

function summarize(report: EnvironmentReport | null): { ready: number; setup: number; interactive: number; unsupported: number } {
  const counts = { ready: 0, setup: 0, interactive: 0, unsupported: 0 }
  for (const tool of report?.tools ?? []) {
    if (tool.status === 'ready') counts.ready += 1
    else if (tool.status === 'needsSetup') counts.setup += 1
    else if (tool.status === 'interactive') counts.interactive += 1
    else counts.unsupported += 1
  }
  return counts
}
