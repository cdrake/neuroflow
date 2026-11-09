import type { ParameterDef, WorkflowDocument } from './neuroflow'

type Locked = Record<string, string> | undefined

/** `initial` wins over stored values for the keys it sets; non-strings are JSON-stringified. */
export function seedValues(stored: Record<string, string>, initial?: Record<string, unknown>): Record<string, string> {
  const out = { ...stored }
  for (const [key, value] of Object.entries(initial ?? {})) {
    out[key] = typeof value === 'string' ? value : JSON.stringify(value)
  }
  return out
}

export function missingInputs(workflow: WorkflowDocument, values: Record<string, string>, locked?: Locked): string[] {
  return Object.entries(workflow.inputs)
    .filter(([name, def]) => !locked?.[name] && def.optional !== true && def.default === undefined && !values[name]?.trim())
    .map(([name]) => name)
}

export function buildPayload(workflow: WorkflowDocument, values: Record<string, string>, locked?: Locked): Record<string, unknown> {
  const payload: Record<string, unknown> = {}
  for (const [name, def] of Object.entries(workflow.inputs)) {
    if (locked && name in locked) continue
    const raw = values[name]
    if (raw === undefined || raw.trim() === '') continue
    payload[name] = coerce(raw, def)
  }
  return payload
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
