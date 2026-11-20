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

/**
 * The order the runtime runs steps in (neuroflow-core `step_order`): repeatedly
 * the first step, in document order, whose `steps.<id>.outputs.*` inputs are
 * all done. Hosts can receive `steps` with its keys re-sorted (a JSON layer
 * without preserve-order), so the UI orders by dependency, not by key. A cycle
 * (rejected by validation) leaves the rest in document order.
 */
export function stepOrder(workflow: { steps: Record<string, { inputs?: Record<string, unknown> }> }): string[] {
  const ids = Object.keys(workflow.steps)
  const deps = new Map(ids.map((id) => {
    const set = new Set<string>()
    for (const binding of Object.values(workflow.steps[id].inputs ?? {})) {
      const ref = (binding as { ref?: unknown } | null)?.ref
      const parts = typeof ref === 'string' ? ref.split('.') : []
      if (parts.length === 4 && parts[0] === 'steps' && ids.includes(parts[1])) set.add(parts[1])
    }
    return [id, set]
  }))
  const done: string[] = []
  while (done.length < ids.length) {
    const next = ids.find((id) => !done.includes(id) && [...deps.get(id)!].every((d) => done.includes(d)))
    if (!next) return [...done, ...ids.filter((id) => !done.includes(id))]
    done.push(next)
  }
  return done
}
