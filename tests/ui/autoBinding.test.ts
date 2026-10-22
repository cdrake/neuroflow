// npm run test:ui
// registry.ts pickAutoBinding: which source a new step's required input is bound to.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { SourceSuggestion } from '../../src/domain/registry'
import { pickAutoBinding } from '../../src/domain/registry'

const suggestion = (ref: string, exact = true): SourceSuggestion => ({
  ref,
  type: 'neuro:volume',
  label: ref,
  exact,
  pipeable: false,
  pipeModes: []
})

test('an output whose name matches the input wins over one earlier in ref order', () => {
  const picked = pickAutoBinding(
    [suggestion('steps.correct.outputs.output_bias'), suggestion('steps.correct.outputs.output_image')],
    'input_image'
  )
  assert.equal(picked?.ref, 'steps.correct.outputs.output_image')
})

test('a partial name match beats no match', () => {
  const picked = pickAutoBinding(
    [suggestion('steps.strip.outputs.mask'), suggestion('steps.strip.outputs.brain_image')],
    'image'
  )
  assert.equal(picked?.ref, 'steps.strip.outputs.brain_image')
})

test('an exact type match still comes before a name match', () => {
  const picked = pickAutoBinding(
    [suggestion('steps.a.outputs.image', false), suggestion('steps.b.outputs.brain')],
    'image'
  )
  assert.equal(picked?.ref, 'steps.b.outputs.brain')
})

test('without a name match the first suggestion is kept', () => {
  const picked = pickAutoBinding(
    [suggestion('steps.a.outputs.labels'), suggestion('steps.b.outputs.report')],
    't1'
  )
  assert.equal(picked?.ref, 'steps.a.outputs.labels')
  assert.equal(pickAutoBinding([], 't1'), undefined)
})
