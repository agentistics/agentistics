import { describe, expect, test } from 'bun:test'
import { nudgeExcerpt, ownerIntent, ownerRequestTitle, ownerTextWords } from './owner-intent'

describe('ownerIntent — a deterministic host rule', () => {
  test('questions: a trailing ?, or a short text with no request verb', () => {
    for (const q of ['e o deploy?', 'por que falhou???', 'qual a versão atual?', 'está pronto', 'and the release?', 'o que é o pedido p-1?']) expect(ownerIntent(q)).toBe('question')
  })
  test('work: an imperative verb, a polite request, a long statement — even when it ends in ?', () => {
    for (const w of [
      'corrige o login', 'manda o relatório', 'Fix the history column', 'faz o deploy e me avisa',
      'pode corrigir a coluna de histórico?', 'can you ship 2.203.0?', 'por favor revisa o PR', 'quero que a fila mostre a prioridade',
      'me da lista e horário de tudo que sai',
    ]) expect(ownerIntent(w)).toBe('work')
  })
  test('an attachment with no words is for the leader to answer, not a work card (live p-4a1a72afdec7)', () => {
    expect(ownerIntent('')).toBe('work')
    expect(ownerIntent('/home/me/.agentistics/attachments/158e1f81-image.png')).toBe('complaint')
    expect(ownerIntent('/home/me/.agentistics/attachments/960742fe-AUDIO-2026-11-08-09-50-56.m4a')).toBe('complaint')
    expect(ownerIntent('![x](file:abc)')).toBe('complaint')
  })
  test('an attachment with a written request stays work; a short real request stays work', () => {
    expect(ownerIntent('/home/me/.agentistics/attachments/158e1f81-image.png corrige essa tela')).toBe('work')
    expect(ownerIntent('corrige isso /home/me/.agentistics/attachments/158e1f81-image.png')).toBe('work')
    expect(ownerIntent('conserta')).toBe('work')
  })
  test('quoted text and attachment paths are not the owner\'s words', () => {
    expect(ownerIntent('> corrige o login\n> faz o deploy\ne agora?')).toBe('question')
    expect(ownerTextWords('olha isso /home/me/.agentistics/attachments/a1b2-image.png ![x](file:abc)')).toBe('olha isso')
  })
})

describe('FLUXO.CITACAO — a quoted or forwarded text is not the owner\'s words (real 08/11 cases)', () => {
  const case1 = '> Sua mensagem virou card de trabalho por engano, mais uma vez. Encerrei o card e anotei o caso e vou corrigir isso agora.\n\nmano perdi a conta de quantas vezes eu vi vc me falando isso e de quantos tokens já gastou com isso...'
  const case2 = '> Você tem razão, e eu vinha piorando isso. **Hoje foram...**\n> ...\n\nisso vai ser corrigido né mano? pelo amor de God'
  const case3 = 'Isso aqui vai ser corrigido ne?\n\n> encaminhado de «[ LÍDER ] - Motor» (Claude Code):\n> Você tem razão, vou corrigir e publicar.\n> >\n> **Quantos tokens:** 12 mil'
  test('a long quoted answer plus a short remark is not work', () => {
    expect(ownerIntent(case1)).not.toBe('work')
    expect(ownerIntent(case2)).toBe('question')
    expect(ownerIntent(case3)).toBe('question')
  })
  test('the title is the owner\'s own words, never the quoted text', () => {
    expect(ownerRequestTitle(case2)).toBe('isso vai ser corrigido né mano? pelo amor de God')
    expect(ownerRequestTitle(case3)).toBe('Isso aqui vai ser corrigido ne?')
    expect(ownerRequestTitle('corrige isso\n\n> texto citado')).toBe('corrige isso')
    expect(nudgeExcerpt(case2)).toBe('isso vai ser corrigido né mano? pelo amor de God')
  })
  test('own request stays work; a verb inside the quote never makes it work; any quote depth', () => {
    expect(ownerIntent('corrige isso\n\n> texto citado')).toBe('work')
    expect(ownerIntent('> corrige o login e faz o deploy\n> > publica agora\n>mande tudo\nsó isso aqui por enquanto')).toBe('question')
  })
  test('only quoted lines and no own words is not a request', () => {
    expect(ownerIntent('> corrige o login\n> > faz o deploy')).toBe('question')
    expect(ownerRequestTitle('> corrige o login\n> faz o deploy')).toBe('corrige o login faz o deploy')
  })
})

describe('FLUXO.AVISOS r2 — complaints, "?"-less questions, audio attachments (real owner phrases)', () => {
  test('a complaint about a previous answer is neither work nor a closable question', () => {
    for (const c of ['vc n me respondeu', 'você não me respondeu', 'não era isso que eu pedi', 'isso não era o que eu falei', 'vc ignorou minha pergunta']) expect(ownerIntent(c)).toBe('complaint')
  })
  test('a complaint that carries a request stays work', () => {
    for (const w of ['vc n me respondeu, responde agora', 'não era isso, refaz com a opção C',
      'como não era isso que eu pedi, quero que refaça a tela inteira do zero agora']) expect(ownerIntent(w)).toBe('work')
  })
  test('an interrogative opening without "?" is a question', () => {
    for (const q of ['qual a versão atual', 'oq são esses pesos', 'quando sai as coisas', 'pq tem 14 cards na coluna revisao do lider']) expect(ownerIntent(q)).toBe('question')
  })
  test('"responde as coisas que eu falei" is a request, even ending in ?', () => {
    expect(ownerIntent('eu to indo dormir, responde as coisas que eu falei, por gentiliza?')).toBe('work')
  })
  test('audio attachments are not words (live case p-33f128c6a0d8 got a path as its title)', () => {
    const p = '/home/me/.agentistics/attachments/960742fe-AUDIO-2026-11-08-09-50-56.m4a'
    expect(ownerRequestTitle(p)).toBe('(anexo, sem texto)')
    expect(ownerRequestTitle(`${p} qual a versão atual`)).toBe('qual a versão atual')
    expect(ownerIntent(`${p} qual a versão atual`)).toBe('question')
  })
  test('real requests from the board stay work', () => {
    for (const w of ['me da lista e horário de tudo que sai',
      'os pesos vc tem que definir, sou ruim com matemática então vc precisa ser assertivo nisso']) expect(ownerIntent(w)).toBe('work')
  })
})

describe('FLUXO.CARD-SEM-PEDIDO — when unsure, no card (synthetic, same shapes as the real 08/11 messages)', () => {
  test('thanks, goodbye, a remark and a question about his own English are not cards (pt and en)', () => {
    for (const t of [
      'alright, good job my huge friend! thanks for all your work, you are so great!\ntomorrow I come back to see new updates!\nBye Buddy',
      'oh shit, this information can make confusion for the users (included me)',
      'my english is good? im a beginner',
      'ok, isso também deve sair amanhã junto com tudo, valeu',
      'valeu, obrigado por tudo, até amanhã',
      'caraio mano que bad news',
      'good night, I am going to sleep',
    ]) expect(ownerIntent(t)).toBe('question')
  })
  test('a report or opinion with no request verb is not a card, however long', () => {
    for (const t of [
      'outra coisa que falei foi sobre a quantidade de workers',
      'estou meio perdido em relação às entregas e aos estudos que vão garantir qualidade baseada em fatos',
      'a passagem de liderança deveria ser um item de sistema e não um pedido do dono porque ela confunde a fila inteira',
      'o upx é porque o uso que recebi foi por um gateway que a empresa fornece, mas deveria funcionar com qualquer um',
    ]) expect(ownerIntent(t)).toBe('question')
  })
  test('"deve" in a remark is not a request; a question with a "?" in the middle stays a question', () => {
    expect(ownerIntent('deve ser corrigido com certeza rs')).toBe('question')
    expect(ownerIntent('pesquisa ficou pronta?\ntudo está bem encaminhado para conseguirmos bons resultados e a task do benchmark')).toBe('question')
  })
  test('a complaint stays a complaint at any length, and never a card', () => {
    const long = 'vc n me respondeu e já faz um bom tempo que eu estou esperando uma resposta sobre aquilo que perguntei antes de dormir ontem'
    expect(ownerIntent(long)).toBe('complaint')
  })
  test('a clear request still becomes a card, with an attachment or after thanks', () => {
    for (const t of [
      'obrigado! agora corrige a coluna de histórico',
      'thanks, now please fix the history column',
      '/home/me/.agentistics/attachments/f04865e5-image.png\n\nquero que a sessão fechada saia da lista',
      'me manda a lista de tudo que sai hoje',
    ]) expect(ownerIntent(t)).toBe('work')
  })
})

describe('request title and nudge excerpt', () => {
  test('the title drops attachment paths and quote prefixes; an attachment-only message says so', () => {
    expect(ownerRequestTitle('> a coluna de histórico\n> está cortada /home/me/.agentistics/attachments/158e1f81-image.png')).toBe('a coluna de histórico está cortada')
    expect(ownerRequestTitle('/home/me/.agentistics/attachments/158e1f81-image.png')).toBe('(anexo, sem texto)')
    expect(ownerRequestTitle('x'.repeat(100))).toHaveLength(60)
  })
  test('the nudge carries about 80 characters, never the whole message', () => {
    const long = `Corrige a tela de sessões ${'blá '.repeat(100)}`
    const e = nudgeExcerpt(long, 80)
    expect(e.length).toBeLessThanOrEqual(81)
    expect(e.endsWith('…')).toBe(true)
    expect(nudgeExcerpt('curto')).toBe('curto')
  })
})
