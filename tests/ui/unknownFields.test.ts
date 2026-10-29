// npm run test:ui
// fields.ts: the unknown-field check, against the fixture shared with neuroflow-core and
// the spec schemas vendored in crates/neuroflow-conformance.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { BEYOND_SCHEMA, CLOSED_FIELDS, closest, editDistance } from '../../src/domain/fields'
import { validateWorkflowLocally } from '../../src/domain/validation'

// The bundle runs from target/ui-tests, two levels below the repository root.
const SPEC = new URL('../../crates/neuroflow-conformance/tests/spec/', import.meta.url)
const readJson = (url: URL): any => JSON.parse(readFileSync(url, 'utf8'))

function schemaFields(reference: string): Set<string> {
  const [file, pointer] = reference.split('#')
  let declaration = readJson(new URL(`schemas/${file}`, SPEC))
  for (const key of pointer.split('/').slice(1)) declaration = declaration[key]
  const fields = new Set<string>()
  for (const branch of declaration.oneOf ?? [declaration]) {
    assert.equal(branch.additionalProperties, false, `${reference} is not closed`)
    for (const key of Object.keys(branch.properties)) fields.add(key)
  }
  return fields
}

test('closed fields follow the vendored spec schemas', () => {
  for (const [reference, fields] of CLOSED_FIELDS) {
    const expected = schemaFields(reference)
    for (const [extraReference, extras] of BEYOND_SCHEMA) {
      if (extraReference !== reference) continue
      for (const extra of extras) {
        assert.ok(!expected.has(extra), `${reference} now lists ${extra}`)
        expected.add(extra)
      }
    }
    assert.deepEqual(new Set(fields), expected, reference)
  }
})

test('spec workflow examples have no unknown fields', () => {
  const dir = new URL('examples/', SPEC)
  const names = readdirSync(dir).filter((name) => name.endsWith('.json'))
  assert.ok(names.length > 0)
  for (const name of names) {
    const issues = validateWorkflowLocally(readJson(new URL(name, dir))).issues
    assert.deepEqual(issues.filter((i) => i.code === 'unknown-field'), [], name)
  }
})

const fixture = readJson(new URL('../../crates/neuroflow-core/tests/fixtures/unknown-fields.json', import.meta.url))

test('the shared fixture base has no errors', () => {
  assert.deepEqual(validateWorkflowLocally(fixture.base).issues.filter((i) => i.severity === 'error'), [])
})

for (const entry of fixture.cases) {
  test(`unknown field at ${entry.path}`, () => {
    const document = structuredClone(fixture.base)
    let target = document
    for (const key of entry.at) target = target[key]
    target.unknownField = true
    const unknown = validateWorkflowLocally(document).issues.filter((i) => i.code === 'unknown-field')
    assert.deepEqual(unknown.map((i) => [i.severity, i.path]), [['error', entry.path]])
  })
}

test('an unknown field names the closest allowed field', () => {
  const document = structuredClone(fixture.base)
  document.outputs.volumes.optinal = true
  const issue = validateWorkflowLocally(document).issues.find((i) => i.code === 'unknown-field')
  assert.equal(issue?.message, 'Unknown field optinal.')
  assert.equal(issue?.hint, 'Did you mean optional?')
})

test('output fields that qualifiers.ts explains are reported once', () => {
  const issues = validateWorkflowLocally(readJson(new URL('examples/invalid/bad-output-default.json', SPEC))).issues
  assert.ok(issues.every((i) => i.code !== 'unknown-field'))
  assert.ok(issues.some((i) => i.severity === 'error'))
})

test('closest and editDistance match the core', () => {
  assert.equal(closest('lable', ['type', 'label', 'optional']), 'label')
  assert.equal(closest('zzzzzzzz', ['type', 'label']), undefined)
  assert.equal(editDistance('', 'abc'), 3)
  assert.equal(editDistance('kitten', 'sitting'), 3)
})
