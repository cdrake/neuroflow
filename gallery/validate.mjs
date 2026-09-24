#!/usr/bin/env node
/**
 * Validate every gallery tool and workflow document against the NeuroFlow
 * specification JSON Schemas.
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
const validators = {
  workflow: ajv.getSchema(base + 'workflow.schema.json'),
  tool: ajv.getSchema(base + 'tool.schema.json'),
  heuristic: ajv.getSchema(base + 'heuristic.schema.json'),
  provenance: ajv.getSchema(base + 'provenance.schema.json'),
}

// Explicit file paths (argv) validate just those; otherwise scan the gallery.
const argFiles = process.argv.slice(2)
const docs = []
if (argFiles.length) {
  docs.push(...argFiles)
} else {
  for (const sub of ['tools', 'workflows']) {
    const dir = join(galleryDir, sub)
    if (!existsSync(dir)) continue
    for (const name of readdirSync(dir)) {
      if (name.endsWith('.json')) docs.push(join(sub, name))
    }
  }
}

let failures = 0
for (const rel of docs.sort()) {
  const doc = JSON.parse(readFileSync(isAbsolute(rel) ? rel : join(galleryDir, rel), 'utf8'))
  const validate = validators[doc.kind]
  if (!validate) { console.log(`  ??   ${rel} (unknown kind: ${doc.kind})`); failures++; continue }
  const ok = validate(doc)
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${rel}`)
  if (!ok) { failures++; console.log('       ' + ajv.errorsText(validate.errors, { separator: '\n       ' })) }
}

console.log('')
if (failures) { console.error(`${failures} document(s) failed validation.`); process.exit(1) }
console.log(`All ${docs.length} gallery documents conform to the NeuroFlow spec.`)
