import { describe, expect, test } from 'bun:test'
import { repoFailureText } from './repoErrorText'
import type { RepoFailure } from './repoApi'

describe('repoFailureText', () => {
  test('a refusal the server worded is shown VERBATIM, in both languages', () => {
    const refusal: RepoFailure = {
      ok: false, failure: 'refused', status: 404, reason: 'not-found',
      message: 'Esse caminho não existe mais na pasta da sessão.',
    }
    expect(repoFailureText(refusal, 'pt')).toBe('Esse caminho não existe mais na pasta da sessão.')
    // The server already answered in the language the request carried; nothing here re-words it.
    expect(repoFailureText(refusal, 'en')).toBe('Esse caminho não existe mais na pasta da sessão.')
  })

  test('the closed editor gate carries a code and no sentence, so the UI owns the wording', () => {
    const gate: RepoFailure = { ok: false, failure: 'refused', status: 403, reason: 'editor_disabled' }
    expect(repoFailureText(gate, 'en')).toContain('Settings → Sessions')
    expect(repoFailureText(gate, 'pt')).toContain('Configurações → Sessões')
  })

  test('an empty `message` is not a sentence — the gate wording still wins', () => {
    const gate = {
      ok: false, failure: 'refused', status: 403, reason: 'editor_disabled', message: '',
    } as RepoFailure
    expect(repoFailureText(gate, 'en')).toContain('Settings → Sessions')
  })

  test('an unknown code is shown as itself rather than swallowed', () => {
    const odd: RepoFailure = { ok: false, failure: 'refused', status: 500, reason: 'wat' }
    expect(repoFailureText(odd, 'en')).toBe('wat')
    expect(repoFailureText(odd, 'pt')).toBe('wat')
  })

  test('the three unreachable causes stay three different sentences', () => {
    const of = (cause: 'network' | 'timeout' | 'malformed', lang: 'en' | 'pt') =>
      repoFailureText({ ok: false, failure: 'unreachable', cause }, lang)
    for (const lang of ['en', 'pt'] as const) {
      const said = new Set([of('network', lang), of('timeout', lang), of('malformed', lang)])
      expect(said.size).toBe(3)
      for (const sentence of said) expect(sentence.length).toBeGreaterThan(0)
    }
  })
})
