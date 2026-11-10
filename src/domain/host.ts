// Bridge to the Tauri host (src-tauri/src/host.rs). In a plain browser every
// call resolves to "not available" so the builder still works as an editor.
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type { WorkflowDocument } from './neuroflow'
import type { RunFinishedEvent, ToolStatus } from './runTypes'

export type * from './runTypes'
export { isArtifactDescriptor } from './runTypes'

export interface HostSettings {
  registryDirs: string[]
  dataRoots: string[]
  sessionsRoot: string
  interpreters: Record<string, string>
}

export interface InterpreterStatus {
  name: string
  path?: string | null
  version?: string | null
  requiredBy: string[]
}

export interface WorkflowStatus {
  id: string
  /** undefined/null when every step can run here; otherwise the first reason. */
  runnable?: string | null
}

export interface EnvironmentReport {
  checkedAt: string
  registryDirs: string[]
  sessionsRoot: string
  dataRoots: string[]
  interpreters: InterpreterStatus[]
  tools: ToolStatus[]
  workflows: WorkflowStatus[]
  warnings: string[]
}

export interface RunProgressEvent {
  ticket: string
  progress: number
  total: number
  message: string
}

const SETTINGS_STORAGE_KEY = 'neuroflow.hostSettings.v1'

export function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

export async function defaultSettings(): Promise<HostSettings> {
  return invoke<HostSettings>('default_settings')
}

export function loadStoredSettings(): HostSettings | null {
  try {
    const raw = window.localStorage.getItem(SETTINGS_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<HostSettings>
    if (!Array.isArray(parsed.registryDirs) || typeof parsed.sessionsRoot !== 'string') return null
    return {
      registryDirs: parsed.registryDirs,
      dataRoots: Array.isArray(parsed.dataRoots) ? parsed.dataRoots : [],
      sessionsRoot: parsed.sessionsRoot,
      interpreters: parsed.interpreters ?? {}
    }
  } catch {
    return null
  }
}

export function storeSettings(settings: HostSettings): void {
  try {
    window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings))
  } catch {
    // storage is a convenience only
  }
}

export async function checkEnvironment(settings: HostSettings): Promise<EnvironmentReport> {
  return invoke<EnvironmentReport>('check_environment', { settings })
}

export interface RegistryDocuments {
  documents: unknown[]
  warnings: string[]
}

/** The raw documents in the host's registry folders (the ones it can run). */
export async function registryDocuments(settings: HostSettings): Promise<RegistryDocuments> {
  return invoke<RegistryDocuments>('registry_documents', { settings })
}

export async function workflowRunnable(
  settings: HostSettings,
  workflow: WorkflowDocument
): Promise<string | null> {
  return invoke<string | null>('workflow_runnable', { settings, workflow })
}

export async function startRun(
  settings: HostSettings,
  workflow: WorkflowDocument,
  inputs: Record<string, unknown>
): Promise<string> {
  return invoke<string>('start_run', { settings, workflow, inputs })
}

export async function cancelRun(ticket: string): Promise<void> {
  await invoke('cancel_run', { ticket })
}

export async function openPath(settings: HostSettings, path: string): Promise<void> {
  await invoke('open_path', { settings, path })
}

export async function readSessionTail(
  settings: HostSettings,
  path: string,
  maxBytes?: number
): Promise<string> {
  return invoke<string>('read_session_tail', { settings, path, maxBytes })
}

export function onRunProgress(handler: (event: RunProgressEvent) => void): Promise<UnlistenFn> {
  return listen<RunProgressEvent>('neuroflow:run-progress', (event) => handler(event.payload))
}

export function onRunFinished(handler: (event: RunFinishedEvent) => void): Promise<UnlistenFn> {
  return listen<RunFinishedEvent>('neuroflow:run-finished', (event) => handler(event.payload))
}

/** Progress messages are "step i/n: <stepId> (<toolId>)" or "done". */
export function parseProgressMessage(message: string): { index: number; total: number; stepId: string } | null {
  const match = /^step (\d+)\/(\d+): (\S+)/.exec(message)
  if (!match) return null
  return { index: Number(match[1]), total: Number(match[2]), stepId: match[3] }
}

export function toolStatusMap(report: EnvironmentReport | null): Map<string, ToolStatus> {
  const map = new Map<string, ToolStatus>()
  for (const status of report?.tools ?? []) map.set(status.id, status)
  return map
}
