// Registries the builder loads at run time, beside the bundled gallery.
//
// A registry is a set of NeuroFlow tool and workflow documents. The builder can
// take one from four places, and the same page works in a browser and inside the
// desktop app:
//
//   gallery  bundled at build time (src/data/gallery.ts)
//   url      a static site that publishes `neuroflow-registry.json` beside the
//            documents it lists (gallery/scripts/registry_index.mjs writes it)
//   folder   a registry folder the user picks in the browser
//   host     the desktop app's registry folders (the ones it can run)
//
// A Neurodesk bundle made by `scripts/generate-neuroflow.mjs` in neurodesk/webapps
// is such a folder; publish it with an index and it loads by URL.
import type { ToolDefinition, WorkflowDocument, WorkflowLibraryItem } from '../domain/neuroflow'
import { libraryItemFromWorkflow, toolFromDocument } from './documents'

export const REGISTRY_INDEX_FILE = 'neuroflow-registry.json'
export const REGISTRY_INDEX_KIND = 'neuroflow/registry-index'

/** `neuroflow-registry.json`: the documents a published registry contains, relative to the index. */
export interface RegistryIndex {
  neuroflow: string
  kind: typeof REGISTRY_INDEX_KIND
  title?: string
  description?: string
  tools: string[]
  workflows?: string[]
}

export type RegistryOrigin = 'gallery' | 'url' | 'folder' | 'host'

export interface RegistrySource {
  /** Stable key: origin plus location. */
  key: string
  origin: RegistryOrigin
  label: string
  /** URL, folder name, or a description of the host's folders. */
  location: string
  tools: ToolDefinition[]
  workflows: WorkflowLibraryItem[]
  warnings: string[]
}

export interface RawDocument {
  /** Where the document came from, for messages. */
  path: string
  value: unknown
}

export interface MergedRegistry {
  tools: ToolDefinition[]
  library: WorkflowLibraryItem[]
  /** Which source each tool and workflow id came from. */
  sourceOf: Map<string, string>
  warnings: string[]
}

/** NeuroFlow spec versions this builder reads (0.1 and its patch releases). */
export function isSupportedSpecVersion(version: unknown): boolean {
  return typeof version === 'string' && /^0\.1(\.\d+)?$/.test(version)
}

/** Build a source from parsed documents. Anything that is not a 0.1 tool or workflow is skipped. */
export function sourceFromDocuments(
  meta: { origin: RegistryOrigin; label: string; location: string },
  docs: RawDocument[],
  warnings: string[] = []
): RegistrySource {
  const tools: ToolDefinition[] = []
  const workflows: WorkflowLibraryItem[] = []
  const seen = new Set<string>()
  const notes = [...warnings]

  for (const { path, value } of docs) {
    if (!isObject(value)) {
      notes.push(`${path}: not a JSON object`)
      continue
    }
    const kind = value.kind
    if (kind !== 'tool' && kind !== 'workflow') continue
    if (!isSupportedSpecVersion(value.neuroflow)) {
      notes.push(`${path}: NeuroFlow ${String(value.neuroflow)} is not supported by this builder (0.1)`)
      continue
    }
    if (typeof value.id !== 'string' || value.id.trim() === '') {
      notes.push(`${path}: ${kind} has no id`)
      continue
    }
    if (seen.has(value.id)) {
      notes.push(`${path}: duplicate id ${value.id}`)
      continue
    }
    seen.add(value.id)
    if (kind === 'tool') tools.push(toolFromDocument(value))
    else workflows.push(libraryItemFromWorkflow(value as unknown as WorkflowDocument))
  }

  tools.sort((a, b) => a.id.localeCompare(b.id))
  workflows.sort((a, b) => a.label.localeCompare(b.label))
  return { key: `${meta.origin}:${meta.location}`, ...meta, tools, workflows, warnings: notes }
}

export type FetchJson = (url: string) => Promise<unknown>

const defaultFetchJson: FetchJson = async (url) => {
  const response = await fetch(url, { headers: { accept: 'application/json' } })
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`.trim())
  return response.json()
}

/**
 * Resolve what the user typed to the index URL: a URL ending in `/` (a published
 * folder) gets `neuroflow-registry.json` appended. Only http(s) is accepted.
 */
export function registryIndexUrl(input: string, base?: string): string {
  const trimmed = input.trim()
  if (!trimmed) throw new Error('enter the URL of a registry folder or its neuroflow-registry.json')
  let url: URL
  try {
    url = new URL(trimmed, base)
  } catch {
    throw new Error(`not a URL: ${trimmed}`)
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`registries load over http(s), not ${url.protocol}`)
  }
  if (url.pathname.endsWith('/')) url.pathname += REGISTRY_INDEX_FILE
  return url.toString()
}

/** Fetch a published registry: its index, then every document it lists. */
export async function loadRegistryFromUrl(input: string, fetchJson: FetchJson = defaultFetchJson, base?: string): Promise<RegistrySource> {
  const indexUrl = registryIndexUrl(input, base)
  let index: unknown
  try {
    index = await fetchJson(indexUrl)
  } catch (error) {
    throw new Error(`cannot read ${indexUrl}: ${message(error)}`)
  }
  const parsed = parseRegistryIndex(index, indexUrl)
  const origin = new URL(indexUrl).origin
  const warnings: string[] = []
  const paths = [...parsed.tools, ...(parsed.workflows ?? [])]

  const docs = await Promise.all(
    paths.map(async (path): Promise<RawDocument | null> => {
      const docUrl = new URL(path, indexUrl)
      if (docUrl.origin !== origin) {
        warnings.push(`${path}: outside the registry's site; skipped`)
        return null
      }
      try {
        return { path, value: await fetchJson(docUrl.toString()) }
      } catch (error) {
        warnings.push(`${path}: ${message(error)}`)
        return null
      }
    })
  )

  return sourceFromDocuments(
    { origin: 'url', label: parsed.title?.trim() || new URL(indexUrl).host, location: indexUrl },
    docs.filter((doc): doc is RawDocument => doc !== null),
    warnings
  )
}

export function parseRegistryIndex(value: unknown, where = REGISTRY_INDEX_FILE): RegistryIndex {
  if (!isObject(value) || value.kind !== REGISTRY_INDEX_KIND) {
    throw new Error(`${where} is not a NeuroFlow registry index (kind "${REGISTRY_INDEX_KIND}")`)
  }
  const list = (key: 'tools' | 'workflows'): string[] => {
    const entries = value[key]
    if (entries === undefined && key === 'workflows') return []
    if (!Array.isArray(entries) || !entries.every((entry) => typeof entry === 'string')) {
      throw new Error(`${where}: "${key}" must be a list of relative paths`)
    }
    for (const entry of entries) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(entry) || entry.startsWith('/')) {
        throw new Error(`${where}: "${entry}" must be a path relative to the index`)
      }
    }
    return entries
  }
  return {
    neuroflow: String(value.neuroflow ?? ''),
    kind: REGISTRY_INDEX_KIND,
    title: typeof value.title === 'string' ? value.title : undefined,
    description: typeof value.description === 'string' ? value.description : undefined,
    tools: list('tools'),
    workflows: list('workflows')
  }
}

/** The part of a browser `File` this module needs; `webkitRelativePath` keeps the folder layout. */
export interface PickedFile {
  name: string
  webkitRelativePath?: string
  text(): Promise<string>
}

/** Read a registry folder the user picked (an `<input webkitdirectory>` selection). */
export async function loadRegistryFromFiles(files: ArrayLike<PickedFile>): Promise<RegistrySource> {
  const picked = Array.from(files).filter((file) => file.name.endsWith('.json') && file.name !== REGISTRY_INDEX_FILE)
  if (picked.length === 0) throw new Error('the folder has no .json documents')
  const warnings: string[] = []
  const docs: RawDocument[] = []
  for (const file of picked) {
    const path = file.webkitRelativePath || file.name
    try {
      docs.push({ path, value: JSON.parse(await file.text()) })
    } catch (error) {
      warnings.push(`${path}: ${message(error)}`)
    }
  }
  const folder = (picked[0].webkitRelativePath || '').split('/')[0] || 'local folder'
  const source = sourceFromDocuments({ origin: 'folder', label: folder, location: folder }, docs, warnings)
  if (source.tools.length === 0 && source.workflows.length === 0) {
    throw new Error(`${folder} has no NeuroFlow 0.1 tool or workflow documents`)
  }
  return source
}

/**
 * Combine sources in order. The first source to define an id keeps it. A later
 * copy that is byte-for-byte the same (the desktop's gallery folder repeats the
 * bundled gallery) is dropped silently; a different one is reported.
 */
export function mergeSources(sources: RegistrySource[]): MergedRegistry {
  const tools: ToolDefinition[] = []
  const library: WorkflowLibraryItem[] = []
  const sourceOf = new Map<string, string>()
  const fingerprint = new Map<string, string>()
  const warnings: string[] = []

  const take = <T>(id: string, value: unknown, item: T, source: RegistrySource, into: T[]): void => {
    const print = JSON.stringify(value)
    const owner = sourceOf.get(id)
    if (owner !== undefined) {
      if (fingerprint.get(id) !== print) warnings.push(`${source.label}: ${id} differs from the copy in ${owner}; keeping ${owner}'s`)
      return
    }
    sourceOf.set(id, source.label)
    fingerprint.set(id, print)
    into.push(item)
  }

  for (const source of sources) {
    for (const tool of source.tools) take(tool.id, tool, tool, source, tools)
    for (const item of source.workflows) take(item.id, item.workflow, item, source, library)
  }
  return { tools, library, sourceOf, warnings }
}

/**
 * Registry URLs to load at start: build-time `VITE_NEUROFLOW_REGISTRIES`
 * (comma or whitespace separated), then each `?registry=` in the page URL.
 */
export function startupRegistryUrls(search: string, configured?: string): string[] {
  const fromEnv = (configured ?? '').split(/[\s,]+/).filter(Boolean)
  const fromQuery = new URLSearchParams(search).getAll('registry').filter(Boolean)
  return [...new Set([...fromEnv, ...fromQuery])]
}

/** Parse a workflow file the user opened. */
export function parseWorkflowFile(text: string, name: string): WorkflowDocument {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw new Error(`${name}: ${message(error)}`)
  }
  if (!isObject(value) || value.kind !== 'workflow') throw new Error(`${name} is not a NeuroFlow workflow (kind "workflow")`)
  if (!isSupportedSpecVersion(value.neuroflow)) throw new Error(`${name}: NeuroFlow ${String(value.neuroflow)} is not supported (0.1)`)
  if (typeof value.id !== 'string' || !isObject(value.steps)) throw new Error(`${name}: a workflow needs an id and steps`)
  return value as unknown as WorkflowDocument
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
