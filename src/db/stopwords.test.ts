import { expect, test } from 'bun:test'
import { isStopword } from './stopwords'

test('English function words are stopwords in any case', () => {
  for (const token of ['the', 'The', 'THE', 'and', 'of', 'is', 'not']) {
    expect(isStopword(token)).toBeTrue()
  }
})

test('Russian function words are stopwords in any case', () => {
  for (const token of ['и', 'не', 'что', 'И', 'это', 'как']) {
    expect(isStopword(token)).toBeTrue()
  }
})

test('ё is folded to е before the lookup, so both spellings hit the same entry', () => {
  expect(isStopword('её')).toBeTrue()
  expect(isStopword('ЕЁ')).toBeTrue()
  expect(isStopword('ее')).toBeTrue()
})

test('content words and the empty token are not stopwords', () => {
  for (const token of ['synaptomind', 'graph', 'мысль', 'Граф', '', ' ']) {
    expect(isStopword(token)).toBeFalse()
  }
})
