import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { AwayDigestActions } from './NotificationBell'

test('away digest actions are a wrapping row with both buttons, below the message', () => {
  const html = renderToStaticMarkup(<AwayDigestActions pt busy={false} onAnswer={() => {}} />)
  expect(html).toContain('Sim, abrir resumo')
  expect(html).toContain('Não agora')
  expect(html).toContain('flex-wrap:wrap')
  expect(html).toContain('margin-top:8px')
})
test('busy disables both', () => {
  expect(renderToStaticMarkup(<AwayDigestActions pt={false} busy onAnswer={() => {}} />).match(/disabled=""/g)?.length).toBe(2)
})
