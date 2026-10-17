/**
 * The control's markup in each state, via `renderToStaticMarkup` (no jsdom here). What matters: the
 * pill becomes a progress bar with a caption — never a silent spinner — and the answer is a sentence
 * that survives the pill being withdrawn.
 */
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { SendNowControl } from './SendNowControl'
import { personQueuedCount } from '../../lib/queuedCards'
import { sendNowShown } from '../../lib/promptHistory'

const noop = () => {}

describe('SendNowControl', () => {
  test('idle and offered: the pill, with the count when the queue holds several', () => {
    const html = renderToStaticMarkup(
      <SendNowControl offered count={2} run={null} pt onSend={noop} onDismiss={noop} />,
    )
    expect(html).toContain('Enviar agora (2)')
    expect(html).not.toContain('progressbar')
  })

  test('nothing offered and nothing to report renders nothing', () => {
    expect(renderToStaticMarkup(
      <SendNowControl offered={false} count={0} run={null} pt onSend={noop} onDismiss={noop} />,
    )).toBe('')
  })

  test('running: a progress bar with the live caption, and no pill', () => {
    const html = renderToStaticMarkup(
      <SendNowControl offered count={1} run={{ kind: 'running', startedAt: Date.now() }} pt onSend={noop} onDismiss={noop} />,
    )
    expect(html).toContain('role="progressbar"')
    expect(html).toContain('Inserindo mensagem imediatamente…')
    expect(html).not.toContain('Enviar agora')
  })

  test('done: the server sentence stays even once the pill is withdrawn', () => {
    const html = renderToStaticMarkup(
      <SendNowControl offered={false} count={0} run={{ kind: 'done', ok: true, message: 'Entregue agora.' }} pt onSend={noop} onDismiss={noop} />,
    )
    expect(html).toContain('Entregue agora.')
    expect(html).toContain('role="status"')
  })

  test('a failure is an alert, with the pill back to retry', () => {
    const html = renderToStaticMarkup(
      <SendNowControl offered count={1} run={{ kind: 'done', ok: false, message: 'Não entregue.' }} pt={false} onSend={noop} onDismiss={noop} />,
    )
    expect(html).toContain('role="alert"')
    expect(html).toContain('Não entregue.')
    expect(html).toContain('Send now')
  })
})


describe('queued message ownership', () => {
  const notice = { text: '[from session ab12 · handback]\nready' }
  function renderQueue(queued: { text: string }[]) {
    const count = personQueuedCount(queued)
    return renderToStaticMarkup(<SendNowControl
      offered={sendNowShown({ harness: 'claude', working: true, queuedCount: count, dialogOpen: false })}
      count={count} run={null} pt onSend={noop} onDismiss={noop}
    />)
  }
  test('a system-only queue offers nothing', () => {
    expect(renderQueue([notice])).toBe('')
  })
  test('a mixed queue offers send-now with only the person’s count', () => {
    const html = renderQueue([notice, { text: 'Please review' }, { text: 'Then publish' }])
    expect(html).toContain('Enviar agora (2)')
    expect(html).not.toContain('Enviar agora (3)')
  })
  test('a typed message still offers send-now', () => {
    expect(renderQueue([{ text: 'Please review' }])).toContain('Enviar agora')
  })
})
