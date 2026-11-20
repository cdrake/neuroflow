// Progress messages from neuroflow-mcp (notifications/progress `message`):
//   "step <i>/<n>: <stepId> (<toolId>)"            as a step starts
//   "step <i>/<n>: <stepId> (<toolId>): <stage>"   as the step reports a stage
//   "done"                                         when the run is over
// Pure, so both the desktop host and @medview/neuroflow-react can use it.

export interface ProgressMessage {
  /** 1-based step number. */
  index: number
  total: number
  stepId: string
  toolId?: string
  /** What the step is doing now (e.g. a recon-all stage), when it reports one. */
  stage?: string
}

export function parseProgressMessage(message: string): ProgressMessage | null {
  const match = /^step (\d+)\/(\d+): (\S+)(?: \(([^()]*)\))?(?:: (.+))?$/.exec(message.trim())
  if (!match) return null
  const parsed: ProgressMessage = { index: Number(match[1]), total: Number(match[2]), stepId: match[3] }
  if (match[4]) parsed.toolId = match[4]
  if (match[5]?.trim()) parsed.stage = match[5].trim()
  return parsed
}

export type StepRunStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped'

/** One step's state in a run, as the run panel and the diagram show it. */
export interface StepRunState {
  status: StepRunStatus
  /** What a running step is doing now, when its tool reports stages (e.g. a recon-all stage). */
  stage?: string
}
