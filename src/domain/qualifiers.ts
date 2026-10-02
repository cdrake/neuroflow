import type { ToolDefinition, ValidationIssue, WorkflowDocument } from './neuroflow'
import { isRefBinding } from './neuroflow'
import { resolveToolDefinition } from './registry'
import { isTypeCompatible } from './typeCompatibility'

export const TYPE_QUALIFIERS = ['formats', 'space', 'resolution', 'density', 'labelSystem'] as const
export type Compatibility = 'compatible' | 'incompatible' | 'requires-runtime-check'
export interface QualifierCheck {
  qualifier: string
  outcome: Compatibility
  source: unknown
  target: unknown
  message: string
}
export interface ResolvedQualifiers {
  declaration: Record<string, unknown>
  spaceIdentity?: string
}

const PARENTS: Readonly<Record<string, string>> = {
  nii: 'nifti', 'nii-gz': 'nifti', 'nii-pair': 'nifti', mgz: 'mgh',
  'seg-nrrd': 'nrrd', 'dicom-seg': 'dicom', 'dseg-tsv': 'tsv',
  'cifti-dtseries': 'cifti', 'cifti-dscalar': 'cifti', 'cifti-dlabel': 'cifti',
  'cifti-dconn': 'cifti', 'cifti-pconn': 'cifti', 'cifti-ptseries': 'cifti', 'cifti-pscalar': 'cifti'
}
const INPUT_REF = /^inputs\.[a-z][A-Za-z0-9_-]*$/
const FORMAT = /^(?:(?!(?:core|neuro|bids|prov):)[a-z][a-z0-9.-]*:)?[a-z][a-z0-9-]*$/
const LABEL = /^(?:(?!(?:core|neuro|bids|prov):)[a-z][a-z0-9.-]*:)?[A-Za-z0-9][A-Za-z0-9_-]*(?:@[A-Za-z0-9][A-Za-z0-9._-]*)?$/
const DENSITY = /^(?:(?!(?:core|neuro|bids|prov):)[a-z][a-z0-9.-]*:)?[A-Za-z0-9][A-Za-z0-9_-]*$/

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {}
}

export function declaredQualifiers(declaration: object): string[] {
  return TYPE_QUALIFIERS.filter((qualifier) => qualifier in declaration)
}

function accepted(source: string, target: string): boolean {
  return source === target || (PARENTS[source] !== undefined && accepted(PARENTS[source], target))
}

function formats(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.length > 0 && value.every((v): v is string => typeof v === 'string') ? value : undefined
}

function spacing(value: unknown): number[] | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return [value, value, value]
  return Array.isArray(value) && value.length === 3 && value.every((v): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0) ? value : undefined
}

function labelIdentity(value: string): [string, string | undefined] {
  if (/^https?:\/\//.test(value)) return [value, undefined]
  const at = value.indexOf('@')
  return at < 0 ? [value, undefined] : [value.slice(0, at), value.slice(at + 1)]
}

function compareAxis(axis: string, source: unknown, target: unknown, sourceIdentity?: string, targetIdentity?: string): Compatibility {
  if (target === undefined || target === null) return 'compatible'
  if (source === undefined || source === null || (typeof source === 'string' && source.startsWith('inputs.')) || (typeof target === 'string' && target.startsWith('inputs.'))) return 'requires-runtime-check'
  switch (axis) {
    case 'formats': {
      const s = formats(source), t = formats(target)
      if (!s || !t) return 'requires-runtime-check'
      if (s.every((s) => t.some((t) => accepted(s, t)))) return 'compatible'
      return s.every((s) => t.every((t) => !accepted(s, t) && !accepted(t, s))) ? 'incompatible' : 'requires-runtime-check'
    }
    case 'resolution': {
      const s = spacing(source), t = spacing(target)
      if (!s || !t) return 'requires-runtime-check'
      return s.every((s, i) => Math.abs(s - t[i]) < 0.001) ? 'compatible' : 'incompatible'
    }
    case 'space':
    case 'labelSystem': {
      if (typeof source !== 'string' || typeof target !== 'string') return 'requires-runtime-check'
      const [s, sr] = labelIdentity(source), [t, tr] = labelIdentity(target)
      if (s !== t) return axis === 'labelSystem' && (s === 'embedded' || t === 'embedded') ? 'requires-runtime-check' : 'incompatible'
      if (tr !== undefined && sr !== tr) return 'requires-runtime-check'
      if (axis === 'space' && (s === 'individual' || s === 'fsnative') && (sourceIdentity === undefined || sourceIdentity !== targetIdentity)) return 'requires-runtime-check'
      return 'compatible'
    }
    case 'density': return source === target ? 'compatible' : 'incompatible'
    default: return 'requires-runtime-check'
  }
}

/** Identities come from binding provenance, never from filenames or matching affines. */
export function compareQualifiers(sourceDeclaration: object, targetDeclaration: object, sourceIdentity?: string, targetIdentity?: string): QualifierCheck[] {
  const source = record(sourceDeclaration), target = record(targetDeclaration)
  if (typeof source.type === 'string' && typeof target.type === 'string' && !isTypeCompatible(source.type, target.type)) {
    return [{ qualifier: 'type', source: source.type, target: target.type, outcome: 'incompatible', message: `type is incompatible: source ${source.type}, target ${target.type}.` }]
  }
  return TYPE_QUALIFIERS.map((qualifier) => {
    const s = source[qualifier] ?? null, t = target[qualifier] ?? null
    const outcome = compareAxis(qualifier, s, t, sourceIdentity, targetIdentity)
    const status = outcome === 'requires-runtime-check' ? 'requires a runtime check' : `is ${outcome}`
    return { qualifier, source: s, target: t, outcome, message: `${qualifier} ${status}: source ${JSON.stringify(s)}, target ${JSON.stringify(t)}.` }
  })
}

export function resolveQualifiers(reference: string, workflow: WorkflowDocument, tools: Map<string, ToolDefinition>, visiting = new Set<string>()): ResolvedQualifiers {
  if (visiting.has(reference)) return { declaration: {} }
  visiting.add(reference)
  const parts = reference.split('.')
  let declaration: Record<string, unknown> = {}
  let step: WorkflowDocument['steps'][string] | undefined
  if (parts[0] === 'inputs' && parts.length === 2) declaration = record(workflow.inputs[parts[1]])
  if (parts[0] === 'context' && parts.length === 2) declaration = record(workflow.context?.fields[parts[1]])
  if (parts[0] === 'steps' && parts.length === 4 && parts[2] === 'outputs') {
    step = workflow.steps[parts[1]]
    if (step) declaration = record(resolveToolDefinition(tools, step.tool)?.outputs[parts[3]])
  }
  let spaceIdentity = !reference.startsWith('context.') && declaration.space !== undefined ? reference : undefined
  for (const axis of TYPE_QUALIFIERS) {
    const value = declaration[axis]
    if (typeof value !== 'string' || !value.startsWith('inputs.')) continue
    const binding = step?.inputs[value.slice('inputs.'.length)]
    const inherited = isRefBinding(binding) ? resolveQualifiers(binding.ref, workflow, tools, visiting) : { declaration: {}, spaceIdentity: undefined }
    const resolved = record(inherited.declaration)[axis]
    if (resolved === undefined) delete declaration[axis]
    else declaration[axis] = resolved
    if (axis === 'space') spaceIdentity = inherited.spaceIdentity
  }
  visiting.delete(reference)
  return { declaration, spaceIdentity }
}

function allowed(axis: string, type: string): boolean {
  const t = type.startsWith('core:array<') && type.endsWith('>') ? type.slice(11, -1) : type
  if (!['core', 'neuro', 'bids', 'prov'].includes(t.split(':')[0])) return true
  if (['core:string', 'core:number', 'core:integer', 'core:boolean', 'core:object', 'core:json'].includes(t)) return false
  const gridded = ['neuro:volume', 'neuro:mask', 'neuro:label-map', 'neuro:statmap', 'neuro:probseg']
  switch (axis) {
    case 'formats': return true
    case 'space': return [...gridded, 'neuro:surface', 'neuro:tract', 'neuro:cifti'].includes(t)
    case 'resolution': return gridded.includes(t)
    case 'density': return ['neuro:surface', 'neuro:cifti'].includes(t)
    case 'labelSystem': return ['neuro:label-map', 'neuro:probseg'].includes(t)
    default: return false
  }
}

function validValue(axis: string, value: unknown): boolean {
  switch (axis) {
    case 'formats': {
      const values = formats(value)
      return values !== undefined && values.every((v) => FORMAT.test(v)) && new Set(values).size === values.length
    }
    case 'resolution': return spacing(value) !== undefined
    case 'density': return typeof value === 'string' && DENSITY.test(value)
    case 'space': return typeof value === 'string' && LABEL.test(value)
    case 'labelSystem': return typeof value === 'string' && (LABEL.test(value) || /^https?:\/\/\S+$/.test(value))
    default: return false
  }
}

/** Semantic checks supplement JSON Schema, including envelope and inheritance. */
export function validateDocumentQualifiers(document: object): ValidationIssue[] {
  const doc = record(document), issues: ValidationIssue[] = []
  const inputs = record(doc.inputs)
  const sections = { inputs, outputs: record(doc.outputs), 'context.fields': record(record(doc.context).fields) }
  for (const [section, declarations] of Object.entries(sections)) {
    for (const [name, value] of Object.entries(declarations)) {
      const declaration = record(value)
      for (const axis of TYPE_QUALIFIERS) {
        if (!(axis in declaration)) continue
        const value = declaration[axis], path = `${section}.${name}.${axis}`
        const fail = (message: string) => issues.push({ severity: 'error', path, message })
        if (doc.neuroflow !== '0.1.1') fail('Type qualifiers require neuroflow 0.1.1.')
        const t = typeof declaration.type === 'string' ? declaration.type : ''
        if (!allowed(axis, t)) fail(`${axis} is not allowed on ${t}.`)
        if (typeof value === 'string' && value.startsWith('inputs.')) {
          if (doc.kind !== 'tool' || section !== 'outputs' || !INPUT_REF.test(value)) fail('Qualifier inheritance is allowed only on tool outputs as inputs.<local-id>.')
          const input = value.slice('inputs.'.length)
          if (!(input in inputs)) fail(`Qualifier references undeclared input ${input}.`)
          else {
            const source = record(inputs[input])
            if (typeof source.type !== 'string' || !allowed(axis, source.type)) fail(`Input ${input} cannot carry ${axis}.`)
          }
        } else if (!validValue(axis, value)) fail(`Invalid ${axis} qualifier value ${JSON.stringify(value)}.`)
      }
    }
  }
  return issues
}

export function qualifierIssues(path: string, checks: QualifierCheck[]): ValidationIssue[] {
  return checks.flatMap((check): ValidationIssue[] => check.outcome === 'compatible' ? [] : [{ path, severity: check.outcome === 'incompatible' ? 'error' : 'warning', message: check.message }])
}
