// Run/tool types shared by the UI components. Kept free of the Tauri bridge so
// the component package never pulls in host.ts.

export type ToolReadiness = 'ready' | 'needsSetup' | 'interactive' | 'unsupported'

export interface ToolStatus {
  id: string
  adapter?: string | null
  status: ToolReadiness
  detail: string
  fix?: string | null
  executable?: string | null
  version?: string | null
  packages?: Record<string, string> | null
  source: string
}

export interface ArtifactDescriptor {
  uri: string
  type: string
  path: string
  mediaType: string
  bytes?: number
}

export interface RunStepRecord {
  tool: string
  toolVersion?: string
  status: string
  exitCode?: number | null
  startedAt?: string
  endedAt?: string
  inputs?: Record<string, unknown>
  outputs?: Record<string, unknown>
  types?: Record<string, string>
  error?: string | null
}

export interface RunRecord {
  runId?: string
  workflow?: string
  status?: string
  startedAt?: string
  endedAt?: string
  failedStep?: string
  steps?: Record<string, RunStepRecord>
  outputs?: Record<string, { type: string; step: string; output: string }>
}

export interface RunStructured {
  runId: string
  status: string
  outputs: Record<string, unknown>
  provenance: string
  failedStep?: string
  error?: string
  logs?: { stdout: string; stderr: string }
}

export type RunFinishedEvent =
  | { ticket: string; ok: false; error: string }
  | {
      ticket: string
      ok: boolean
      runId: string
      status: string
      structured: RunStructured
      summary: string
      sessionDir: string
      record: RunRecord
    }

export function isArtifactDescriptor(value: unknown): value is ArtifactDescriptor {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as ArtifactDescriptor).path === 'string' &&
    typeof (value as ArtifactDescriptor).uri === 'string'
  )
}
