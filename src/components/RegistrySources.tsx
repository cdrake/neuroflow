import { useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { AlertTriangle, ChevronDown, ChevronRight, FolderOpen, Library, Link2, Loader2, Plus, X } from 'lucide-react'
import type { RegistrySource } from '../data/registrySources'

export interface RegistryLoadError {
  location: string
  message: string
}

interface RegistrySourcesProps {
  sources: RegistrySource[]
  errors: RegistryLoadError[]
  /** Conflicts between sources (same id, different document). */
  conflicts: string[]
  loading: string[]
  /** Whether the desktop's registry folders are loaded (they are edited in Environment settings). */
  hostAvailable: boolean
  onAddUrl: (url: string) => Promise<void>
  onAddFolder: (files: FileList) => Promise<void>
  onRemove: (key: string) => void
  onDismissError: (location: string) => void
}

const ORIGIN_LABEL: Record<RegistrySource['origin'], string> = {
  gallery: 'built in',
  host: 'desktop folders',
  url: 'published',
  folder: 'local folder'
}

/**
 * Where the palette and workflow library come from. Beside the bundled gallery,
 * a registry can be a published folder with `neuroflow-registry.json` (a
 * Neurodesk bundle, say), a folder picked from disk, or, in the desktop app, the
 * registry folders it runs from.
 */
export function RegistrySources({
  sources,
  errors,
  conflicts,
  loading,
  hostAvailable,
  onAddUrl,
  onAddFolder,
  onRemove,
  onDismissError
}: RegistrySourcesProps): JSX.Element {
  const [expanded, setExpanded] = useState(true)
  const [adding, setAdding] = useState(false)
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const folderInput = useRef<HTMLInputElement>(null)

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault()
    setBusy(true)
    setFormError(null)
    try {
      await onAddUrl(url)
      setUrl('')
      setAdding(false)
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  async function pickFolder(files: FileList | null): Promise<void> {
    if (!files || files.length === 0) return
    setBusy(true)
    setFormError(null)
    try {
      await onAddFolder(files)
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
      if (folderInput.current) folderInput.current.value = ''
    }
  }

  const toolCount = sources.reduce((sum, source) => sum + source.tools.length, 0)

  return (
    <section className="nf-panel nf-registries">
      <header className="nf-panel-header">
        <button aria-expanded={expanded} className="nf-panel-toggle" onClick={() => setExpanded((value) => !value)} type="button">
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <div>
            <p className="nf-eyebrow">Sources</p>
            <h2>Registries</h2>
          </div>
        </button>
        <div className="nf-panel-actions">
          <button
            className="nf-mini-action"
            disabled={busy}
            onClick={() => {
              setExpanded(true)
              setAdding((value) => !value)
              setFormError(null)
            }}
            title="Load a published registry by URL"
            type="button"
          >
            <Link2 size={13} />
            URL
          </button>
          <button
            className="nf-mini-action"
            disabled={busy}
            onClick={() => folderInput.current?.click()}
            title="Load a registry folder from disk (for authoring; this session only)"
            type="button"
          >
            <FolderOpen size={13} />
            Folder
          </button>
          <input
            hidden
            multiple
            onChange={(event) => void pickFolder(event.target.files)}
            ref={folderInput}
            type="file"
            {...{ webkitdirectory: '' }}
          />
          <Library size={16} />
        </div>
      </header>

      {adding && (
        <form className="nf-registry-add" onSubmit={(event) => void submit(event)}>
          <input
            aria-label="Registry URL"
            autoFocus
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://…/neuroflow-registry.json"
            spellCheck={false}
            type="url"
            value={url}
          />
          <button className="nf-mini-action" disabled={busy || url.trim() === ''} type="submit">
            {busy ? <Loader2 className="nf-spin" size={13} /> : <Plus size={13} />}
            Load
          </button>
        </form>
      )}

      {formError && (
        <p className="nf-issue">
          <AlertTriangle size={13} />
          <span>{formError}</span>
        </p>
      )}

      {expanded && (
        <ul className="nf-env-list">
          {sources.map((source) => (
            <li className="nf-env-item nf-registry-item" key={source.key} title={source.location}>
              <Library size={13} />
              <span>
                <strong>{source.label}</strong>
                <small>
                  {ORIGIN_LABEL[source.origin]} · {source.tools.length} tools · {source.workflows.length} workflows
                </small>
                {source.warnings.length > 0 && (
                  <details className="nf-registry-warnings">
                    <summary>{source.warnings.length} skipped</summary>
                    {source.warnings.map((warning) => (
                      <small key={warning}>{warning}</small>
                    ))}
                  </details>
                )}
              </span>
              {(source.origin === 'url' || source.origin === 'folder') && (
                <button aria-label={`Remove ${source.label}`} className="nf-icon-button" onClick={() => onRemove(source.key)} type="button">
                  <X size={13} />
                </button>
              )}
            </li>
          ))}
          {loading.map((location) => (
            <li className="nf-env-item nf-registry-item" key={`loading:${location}`} title={location}>
              <Loader2 className="nf-spin" size={13} />
              <span>
                <strong>Loading</strong>
                <small>{location}</small>
              </span>
            </li>
          ))}
          {errors.map((error) => (
            <li className="nf-env-item is-missing nf-registry-item" key={`error:${error.location}`}>
              <AlertTriangle size={13} />
              <span>
                <strong>Could not load</strong>
                <small>{error.message}</small>
              </span>
              <button aria-label="Dismiss" className="nf-icon-button" onClick={() => onDismissError(error.location)} type="button">
                <X size={13} />
              </button>
            </li>
          ))}
        </ul>
      )}

      {expanded && conflicts.length > 0 && (
        <details className="nf-registry-warnings nf-env-note">
          <summary>{conflicts.length} duplicate ids kept from the earlier source</summary>
          {conflicts.map((conflict) => (
            <small key={conflict}>{conflict}</small>
          ))}
        </details>
      )}

      {expanded && (
        <p className="nf-env-note">
          {toolCount} tools in the palette.{' '}
          {hostAvailable
            ? 'Run what is in the desktop folders; add folders in Environment settings.'
            : 'Author and export here; run in the desktop app with the registry folder added to its settings.'}
        </p>
      )}
    </section>
  )
}
