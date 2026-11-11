import { expect, test } from 'bun:test'
import { structuredOnlyNotice } from './spawn-error'
import { HERMES_STRUCTURED_ONLY_NOTICE } from './structured-route'

test('spawn explainer returns the Hermes structured-only notice', () => {
  expect(structuredOnlyNotice({ code: 'structured-only', harness: 'hermes', notice: HERMES_STRUCTURED_ONLY_NOTICE }))
    .toBe(HERMES_STRUCTURED_ONLY_NOTICE)
})
