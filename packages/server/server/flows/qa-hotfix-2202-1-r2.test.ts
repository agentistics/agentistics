/**
 * QA HOTFIX 2.202.1 r2 — probe of 6eb3d5702 (the fix of F1-F4).
 * Passing tests pin what holds; `test.failing` pins a finding (it turns red once fixed — flip it to `test`).
 * Every phrase in the R-groups is the owner's real wording (leader transcripts / flows/pedidos.json, 2026-11).
 */
import { describe, expect, test } from 'bun:test'
import { ownerIntent } from './owner-intent'

const each = (list: string[], want: 'work' | 'question') => { for (const t of list) expect([t, ownerIntent(t)]).toEqual([t, want]) }

describe('what the F1 fix got right', () => {
  test('noun-verbs stay questions outside verb position, and stay work in verb position', () => {
    each(['e o deploy?', 'and the release?', 'o teste passou?', 'e o build?'], 'question')
    each(['faz o deploy', 'deploy isso', 'release agora', 'pode fazer o build?', 'bora build'], 'work')
  })
  test('R: real requests the previous rule missed', () => {
    each(['me faz um artefato pra eu ver como vai ficar'], 'work')
  })
})

describe('R1 — `\\b` is ASCII-only, so a verb followed by an accented letter matches inside a noun', () => {
  // `publica` + `ç` is a word boundary to JS: "publicação" contains the verb. New in 6eb3d5702 (strong verbs match anywhere).
  test.failing('nouns ending in -ção are not verbs', () => {
    each(['e a publicação?', 'cadê a integração?', 'como está a implementação?', 'e a atualização?', 'a verificação passou?', 'como está a liberação?'], 'question')
  })
  test.failing('R: the real message that flipped because of it', () => {
    each(['tá exibindo 6 publicados, oq define quais são as publicações que aparecem ali?'], 'question')
  })
})

describe('R2 — a strong verb anywhere overrides a trailing "?": plain questions became work again', () => {
  // These were questions before 6eb3d5702. Each one now gets a subtask and the staging reminder: the 2.202.0 complaint.
  test.failing('"vai" is the auxiliary of a question far more often than an order', () => {
    each(['quando vai sair?', 'como vai o deploy?', 'isso vai funcionar?', 'quanto tempo vai levar?'], 'question')
  })
  test.failing('R: the real messages', () => {
    each(['se durante a ligacao eu pedir para buscar algo na net vai aparecer o navegador e a ligacao buscando?'], 'question')
  })
  test.failing('a verb inside a question', () => {
    each(['quando sobe?', 'quando publica?', 'o bug continua?', 'isso faz sentido?', 'a sessão fecha sozinha?'], 'question')
  })
  test.failing('"fix" is a noun here, and it is not in AMBIGUOUS', () => {
    each(['e o fix?', 'cadê o fix?', 'did the fix land?'], 'question')
  })
})

describe('R3 — real work that is still `question`: the engine records it answered, with no subtask and no reminder', () => {
  test.failing('R: urgent or defect reports with no listed verb', () => {
    each([
      'hotfix pelo amor de Deus',
      'cara erro critico, eu n to conseguindo reabrir uma sessao do opencode',
      'esses avisos do fluxo estão vindo abertos invés de fechados',
      'ainda n ta aparecendo as porcentagens',
    ], 'work')
  })
  test.failing('R: requests whose verb is not in the list', () => {
    each(['precisa alinhar isso daqui ao canto esquerdo tambem.', 'tudo deve ter mcp para os agentes poderem usar', 'quero url do tailscale rs'], 'work')
  })
  test.failing('common pt verbs missing from the list', () => {
    each(['resolve o bug do login', 'refatora esse módulo', 'tenta de novo', 'reverte esse commit', 'reinicia o servidor', 'gera o relatório', 'olha esse erro', 'quero uma tela nova'], 'work')
  })
  test.failing('noun-verbs after a word with no punctuation (author note 1)', () => {
    each(['ok deploy', 'ok release', 'blz merge', 'mano deploy isso', 'agora teste o login', 'tem que testar o login'], 'work')
  })
})
