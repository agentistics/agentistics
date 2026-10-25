import { afterAll, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { FleetOverview } from './FleetOverview'

const root = globalThis as unknown as { window?: unknown }
const had = root.window
root.window = { innerWidth: 1440, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), addEventListener() {}, removeEventListener() {} }
afterAll(() => { root.window = had })

for (const lang of ['pt', 'en'] as const) test(`an empty live fleet points at the list instead of repeating its sentence (${lang})`, () => {
  const html = renderToStaticMarkup(<FleetOverview lang={lang} rows={[]} loading={false} unsupported={false} />)
  expect(html).toContain(lang === 'pt' ? 'Escolha uma conversa na lista, ou comece uma sessão pelo +.' : 'Pick a conversation from the list, or start a session with +.')
  // The list says "Nada rodando agora. N conversas estão em Encerradas."; the centre does not repeat it.
  expect(html).not.toContain(lang === 'pt' ? 'Nada rodando' : 'Nothing is running')
  expect(html).not.toContain(lang === 'pt' ? 'Nenhuma sessão nesta máquina ainda' : 'No sessions on this machine yet')
})
