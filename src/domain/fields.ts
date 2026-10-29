import type { ValidationIssue } from './neuroflow'
import { TYPE_QUALIFIERS } from './qualifiers'

// Mirrors crates/neuroflow-core/src/fields.rs: the spec schemas close most workflow
// declarations (additionalProperties: false), so a misspelt field such as `optinal`
// makes a document invalid. tests/ui/unknownFields.test.ts checks these lists against
// the schemas vendored in crates/neuroflow-conformance/tests/spec.

const ROOT = ['$schema', 'neuroflow', 'kind', 'id', 'version', 'description', 'inputs', 'context', 'steps', 'outputs', 'errorPolicy', 'extensions']
const CONTEXT = ['description', 'fields']
const CONTEXT_FIELD = [
  'type', 'description', 'label', 'heuristic', 'dependsOn', 'optional', 'default', 'enum', 'min', 'max', 'liveWritable', 'extensions',
  // Beyond the schema, see BEYOND_SCHEMA.
  ...TYPE_QUALIFIERS
]
const INPUT = ['type', 'description', 'label', 'optional', 'default', 'enum', 'min', 'max', 'minItems', 'maxItems', ...TYPE_QUALIFIERS, 'extensions']
const STEP = ['tool', 'inputs', 'outputMappings', 'condition', 'stage', 'eventBindings', 'awaitApproval', 'fixLoop', 'errorPolicy', 'extensions']
const BINDING = ['ref', 'constant']
const STEP_ERROR_POLICY = ['onError', 'tolerateItemFailures', 'requiredOutputs', 'notify']
const TOLERATE_ITEM_FAILURES = ['max', 'maxFraction', 'minSuccesses']
const FIX_LOOP = ['fixerStep', 'maxIterations', 'stopOn']
const EVENT_BINDINGS = ['transport', 'contextWrites', 'subscribeTo']
const SIBLING_SUBSCRIPTION = ['step', 'types', 'names', 'inputBinding']
const OUTPUT = ['type', 'ref', 'description', 'label', 'optional', ...TYPE_QUALIFIERS, 'extensions']
const WORKFLOW_ERROR_POLICY = ['defaultOnError', 'haltOnSteps', 'onError', 'notify', 'completionStatus']

/** Each closed key set with the schema declaration it mirrors, as `<file>#<JSON pointer>`. */
export const CLOSED_FIELDS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['workflow.schema.json#', ROOT],
  ['workflow.schema.json#/properties/context', CONTEXT],
  ['workflow.schema.json#/$defs/contextFieldDef', CONTEXT_FIELD],
  ['common.schema.json#/$defs/typeDeclaration', INPUT],
  ['workflow.schema.json#/$defs/stepDef', STEP],
  ['common.schema.json#/$defs/binding', BINDING],
  ['workflow.schema.json#/$defs/stepErrorPolicyDef', STEP_ERROR_POLICY],
  ['workflow.schema.json#/$defs/stepErrorPolicyDef/properties/tolerateItemFailures', TOLERATE_ITEM_FAILURES],
  ['workflow.schema.json#/$defs/fixLoopDef', FIX_LOOP],
  ['events.schema.json#/$defs/stepEventBindings', EVENT_BINDINGS],
  ['events.schema.json#/$defs/siblingSubscription', SIBLING_SUBSCRIPTION],
  ['workflow.schema.json#/$defs/outputDef', OUTPUT],
  ['workflow.schema.json#/$defs/workflowErrorPolicyDef', WORKFLOW_ERROR_POLICY]
]

/** Keys accepted although the schema does not list them: RFC 0010 qualifiers on context fields. */
export const BEYOND_SCHEMA: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['workflow.schema.json#/$defs/contextFieldDef', TYPE_QUALIFIERS]
]

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function entries(value: unknown): Array<[string, unknown]> {
  return Object.entries(object(value) ?? {})
}

/**
 * Reports every key outside its declaration's closed set as an `unknown-field` error.
 * `default` and `delivery` on a workflow output are left to validateDocumentQualifiers,
 * which explains them.
 */
export function unknownFieldIssues(workflow: unknown): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const root = object(workflow)
  if (!root) return issues
  check(issues, '', root, ROOT)
  if ('context' in root) {
    const context = object(root.context)
    check(issues, 'context', context, CONTEXT)
    for (const [name, field] of entries(context?.fields)) check(issues, `context.fields.${name}`, field, CONTEXT_FIELD)
  }
  for (const [name, input] of entries(root.inputs)) check(issues, `inputs.${name}`, input, INPUT)
  for (const [name, value] of entries(root.steps)) {
    const path = `steps.${name}`
    const step = object(value)
    check(issues, path, step, STEP)
    for (const [input, binding] of entries(step?.inputs)) check(issues, `${path}.inputs.${input}`, binding, BINDING)
    const policy = object(step?.errorPolicy)
    check(issues, `${path}.errorPolicy`, policy, STEP_ERROR_POLICY)
    check(issues, `${path}.errorPolicy.tolerateItemFailures`, policy?.tolerateItemFailures, TOLERATE_ITEM_FAILURES)
    check(issues, `${path}.fixLoop`, step?.fixLoop, FIX_LOOP)
    check(issues, `${path}.eventBindings`, step?.eventBindings, EVENT_BINDINGS)
    const subscriptions = object(step?.eventBindings)?.subscribeTo
    if (Array.isArray(subscriptions)) {
      subscriptions.forEach((subscription, index) => check(issues, `${path}.eventBindings.subscribeTo[${index}]`, subscription, SIBLING_SUBSCRIPTION))
    }
  }
  for (const [name, output] of entries(root.outputs)) check(issues, `outputs.${name}`, output, OUTPUT, ['default', 'delivery'])
  check(issues, 'errorPolicy', root.errorPolicy, WORKFLOW_ERROR_POLICY)
  return issues
}

function check(issues: ValidationIssue[], path: string, value: unknown, allowed: readonly string[], explained: readonly string[] = []): void {
  for (const key of Object.keys(object(value) ?? {})) {
    if (allowed.includes(key) || explained.includes(key)) continue
    const near = closest(key, allowed)
    issues.push({
      severity: 'error',
      path: path ? `${path}.${key}` : key,
      message: `Unknown field ${key}.`,
      hint: near ? `Did you mean ${near}?` : `Allowed fields: ${allowed.join(', ')}.`,
      code: 'unknown-field'
    })
  }
}

/** The allowed key within two edits of `key`, if exactly one is closest. */
export function closest(key: string, allowed: readonly string[]): string | undefined {
  let best: { distance: number; candidate: string } | undefined
  let tied = false
  for (const candidate of allowed) {
    const distance = editDistance(key, candidate)
    if (best && distance > best.distance) continue
    if (best && distance === best.distance) {
      tied = true
      continue
    }
    best = { distance, candidate }
    tied = false
  }
  return best && best.distance <= 2 && !tied ? best.candidate : undefined
}

export function editDistance(a: string, b: string): number {
  const target = [...b]
  const row = Array.from({ length: target.length + 1 }, (_, i) => i)
  ;[...a].forEach((ca, i) => {
    let previous = row[0]
    row[0] = i + 1
    target.forEach((cb, j) => {
      const substitution = previous + (ca === cb ? 0 : 1)
      previous = row[j + 1]
      row[j + 1] = Math.min(substitution, previous + 1, row[j] + 1)
    })
  })
  return row[target.length]
}
