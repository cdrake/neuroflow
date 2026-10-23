// npm run test:ui
// typeCompatibility.ts isTypeCompatible: mirrors is_type_compatible in neuroflow-core.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isTypeCompatible } from '../../src/domain/typeCompatibility'

test('coercions and array element types follow the shared table', () => {
  assert.equal(isTypeCompatible('neuro:statmap', 'neuro:volume'), true)
  assert.equal(isTypeCompatible('core:array<neuro:probseg>', 'core:array<neuro:volume>'), true)
  assert.equal(isTypeCompatible('neuro:volume', 'neuro:mask'), false)
})

test('a single value fills a one-element array input', () => {
  assert.equal(isTypeCompatible('neuro:volume', 'core:array<neuro:volume>'), true)
  assert.equal(isTypeCompatible('neuro:mask', 'core:array<neuro:volume>'), true)
  assert.equal(isTypeCompatible('neuro:volume', 'core:array<neuro:mask>'), false)
  assert.equal(isTypeCompatible('core:array<neuro:volume>', 'neuro:volume'), false)
})
