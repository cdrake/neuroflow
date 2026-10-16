#!/usr/bin/env node
/**
 * Validate every gallery tool and workflow document against the NeuroFlow
 * specification JSON Schemas, and each tool's extensions["neuroflow/usage"]
 * block (RFC 0011) when the spec checkout has that extension's schema.
 *
 * Resolves Ajv and the schemas from the sibling neuroflow-spec checkout. Set
 * NEUROFLOW_SPEC_DIR to override its location (default: ../neuroflow-spec).
 *
 *   node gallery/validate.mjs
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, dirname, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const galleryDir = dirname(fileURLToPath(import.meta.url))
const specDir = process.env.NEUROFLOW_SPEC_DIR || join(galleryDir, '..', '..', 'neuroflow-spec')
const schemaDir = join(specDir, 'schemas', '0.1')

if (!existsSync(schemaDir)) {
  console.error(`Cannot find spec schemas at ${schemaDir}.\nSet NEUROFLOW_SPEC_DIR to your neuroflow-spec checkout.`)
  process.exit(2)
}

const require = createRequire(join(specDir, 'package.json'))
const Ajv2020 = require('ajv/dist/2020.js')
const addFormats = require('ajv-formats')
const ajv = new Ajv2020({ allErrors: true, strict: false })
addFormats(ajv)

for (const rel of [
  'common.schema.json', 'events.schema.json', 'workflow.schema.json', 'tool.schema.json',
  'heuristic.schema.json', 'provenance.schema.json',
  'extensions/niivue-ui.schema.json', 'extensions/niivue-runtime.schema.json', 'extensions/bids-profile.schema.json',
]) {
  ajv.addSchema(JSON.parse(readFileSync(join(schemaDir, rel), 'utf8')))
}

const base = 'https://niivue.github.io/neuroflow-spec/schemas/0.1/'
const usageSchema = join(schemaDir, 'extensions', 'neuroflow-usage.schema.json')
const validateUsage = existsSync(usageSchema) ? ajv.compile(JSON.parse(readFileSync(usageSchema, 'utf8'))) : null
const validators = {
  workflow: ajv.getSchema(base + 'workflow.schema.json'),
  tool: ajv.getSchema(base + 'tool.schema.json'),
  heuristic: ajv.getSchema(base + 'heuristic.schema.json'),
  provenance: ajv.getSchema(base + 'provenance.schema.json'),
}

// Explicit file paths (argv) validate just those; otherwise scan the gallery.
const galleryDocs = []
for (const sub of ['tools', 'workflows']) {
  const dir = join(galleryDir, sub)
  if (!existsSync(dir)) continue
  for (const name of readdirSync(dir)) {
    if (name.endsWith('.json')) galleryDocs.push(join(sub, name))
  }
}
const argFiles = process.argv.slice(2)
const docs = argFiles.length ? argFiles : galleryDocs
const readDoc = (rel) => JSON.parse(readFileSync(isAbsolute(rel) ? rel : join(galleryDir, rel), 'utf8'))

// Whether an example value fits a declared type, as the spec's own check does.
// Artifact types (neuro:, bids:, extension types) take a string placeholder or path.
function exampleValueFits(type, value) {
  const array = /^core:array<(.+)>$/.exec(type)
  if (array) return Array.isArray(value) && value.every((v) => exampleValueFits(array[1], v))
  switch (type) {
    case 'core:string': return typeof value === 'string'
    case 'core:number': return typeof value === 'number'
    case 'core:integer': return Number.isInteger(value)
    case 'core:boolean': return typeof value === 'boolean'
    case 'core:object': return value !== null && typeof value === 'object' && !Array.isArray(value)
    case 'core:json': return true
    default: return typeof value === 'string'
  }
}

// The neuroflow/usage block: its schema, then what a schema cannot say. Example
// inputs must be declared and fit their type and enum, and every avoidWhen
// `instead` must name another document in the gallery.
function usageErrors(doc, block, galleryIds) {
  if (!validateUsage(block)) return [ajv.errorsText(validateUsage.errors, { separator: '; ' })]
  const errors = []
  for (const [i, ex] of (block.examples ?? []).entries()) {
    for (const [id, value] of Object.entries(ex.inputs ?? {})) {
      const decl = doc.inputs?.[id]
      if (!decl) errors.push(`examples/${i}/inputs/${id}: not a declared input`)
      else if (!exampleValueFits(decl.type, value)) errors.push(`examples/${i}/inputs/${id}: does not fit ${decl.type}`)
      else if (Array.isArray(decl.enum) && !decl.enum.some((v) => JSON.stringify(v) === JSON.stringify(value))) {
        errors.push(`examples/${i}/inputs/${id}: ${JSON.stringify(value)} is not one of ${JSON.stringify(decl.enum)}`)
      }
    }
    for (const id of Object.keys(ex.outputs ?? {})) {
      if (!doc.outputs?.[id]) errors.push(`examples/${i}/outputs/${id}: not a declared output`)
    }
  }
  for (const [i, a] of (block.avoidWhen ?? []).entries()) {
    if (a.instead === doc.id) errors.push(`avoidWhen/${i}/instead points at this tool`)
    else if (a.instead && !galleryIds.has(a.instead)) errors.push(`avoidWhen/${i}/instead: ${a.instead} is not in the gallery`)
  }
  return errors
}

// `instead` ids resolve against the whole gallery, even when argv names a few files.
const galleryIds = new Set(galleryDocs.map((rel) => readDoc(rel).id))
let failures = 0
let usageBlocks = 0
for (const rel of docs.sort()) {
  const doc = readDoc(rel)
  const validate = validators[doc.kind]
  if (!validate) { console.log(`  ??   ${rel} (unknown kind: ${doc.kind})`); failures++; continue }
  const errors = validate(doc) ? [] : [ajv.errorsText(validate.errors, { separator: '\n       ' })]
  const usage = doc.extensions?.['neuroflow/usage']
  if (usage && validateUsage) {
    usageBlocks++
    errors.push(...usageErrors(doc, usage, galleryIds).map((e) => `neuroflow/usage: ${e}`))
  }
  console.log(`  ${errors.length ? 'FAIL' : 'ok  '} ${rel}`)
  if (errors.length) { failures++; console.log('       ' + errors.join('\n       ')) }
}

console.log('')
if (failures) { console.error(`${failures} document(s) failed validation.`); process.exit(1) }
console.log(`All ${docs.length} gallery documents conform to the NeuroFlow spec.`)
if (validateUsage) console.log(`Checked ${usageBlocks} neuroflow/usage block(s).`)
else console.log(`Skipped neuroflow/usage blocks: ${usageSchema} not found (RFC 0011 schema).`)
