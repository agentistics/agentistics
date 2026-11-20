import { describe, expect, test } from 'bun:test'
import { chatHarnessesNeedPolling, type HarnessChatStatus } from './useChatHarnesses'

const h = (over: Partial<HarnessChatStatus>): HarnessChatStatus => ({ id: 'x', label: 'X', installed: true, authReady: true, ready: true, models: [], defaultModel: '', setup: {}, ...over })

describe('chatHarnessesNeedPolling (USO.LENTO: the Usage page re-asked the server every 4 s forever)', () => {
  test('nothing known yet: keep asking until the first answer', () => expect(chatHarnessesNeedPolling([])).toBe(true))
  test('everything ready: stop', () => expect(chatHarnessesNeedPolling([h({}), h({ id: 'y' })])).toBe(false))
  test('a harness that is NOT installed will not flip on its own: it must not keep the poll alive', () => {
    expect(chatHarnessesNeedPolling([h({}), h({ id: 'hermes', installed: false, authReady: false, ready: false })])).toBe(false)
  })
  test('installed but waiting for a sign-in can flip by itself: keep asking', () => {
    expect(chatHarnessesNeedPolling([h({}), h({ id: 'codex', authReady: false, ready: false })])).toBe(true)
  })
})
