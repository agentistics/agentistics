import { describe, expect, test } from 'bun:test'
import { bornConversationLink } from './born-link'

describe('bornConversationLink — a spawned row is born knowing its conversation', () => {
  test('a REOPEN is born linked to the conversation it resumed', () => {
    // The reported defect: the reopened row was written unlinked and patched afterwards, and the
    // chat view read it in between — "this session has no linked conversation yet".
    expect(bornConversationLink(undefined, 'conv-1')).toEqual({ conversationId: 'conv-1', conversationLink: 'assigned', conversationLinkVia: 'resumed-id' })
  })
  test('a fresh session keeps the id the CLI was handed', () => {
    expect(bornConversationLink('conv-2', undefined)).toEqual({ conversationId: 'conv-2', conversationLink: 'assigned', conversationLinkVia: 'assigned-id' })
  })
  test('nothing known means nothing claimed', () => {
    expect(bornConversationLink(undefined, undefined)).toBeUndefined()
  })
})
