import { describe, expect, it } from 'bun:test'
import { resolveTeamSessionRefresh } from './teamSessionRefresh'

describe('resolveTeamSessionRefresh', () => {
  it('a successful read replaces whatever was there before', () => {
    expect(resolveTeamSessionRefresh({ editorEnabled: false }, { editorEnabled: true }, { editorEnabled: false }))
      .toEqual({ editorEnabled: true })
  })

  it('turning the switch back off is read exactly the same way — both directions of the toggle', () => {
    expect(resolveTeamSessionRefresh({ editorEnabled: true }, { editorEnabled: false }, { editorEnabled: false }))
      .toEqual({ editorEnabled: false })
  })

  it('the very first read (nothing known yet) falls back to the boot default on failure', () => {
    expect(resolveTeamSessionRefresh(undefined, null, { required: false, authed: true }))
      .toEqual({ required: false, authed: true })
  })

  it('a LATER failed refresh keeps the last-known state — it never wipes it back to the boot default', () => {
    interface Session { required: boolean; authed: boolean; central?: boolean; editorEnabled?: boolean }
    const known: Session = { required: false, authed: true, central: true, editorEnabled: true }
    expect(resolveTeamSessionRefresh<Session>(known, null, { required: false, authed: true })).toBe(known)
  })

  it('a fetched `false`/`0`/empty-object answer is not mistaken for "nothing came back"', () => {
    expect(resolveTeamSessionRefresh({ n: 1 }, { n: 0 }, { n: -1 })).toEqual({ n: 0 })
    expect(resolveTeamSessionRefresh({ n: 1 }, {}, { n: -1 })).toEqual({})
  })
})
