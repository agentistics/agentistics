import { afterAll, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { FleetOverview } from './FleetOverview'

const root = globalThis as unknown as { window?: unknown }
const had = root.window
root.window = { innerWidth: 1440, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), addEventListener() {}, removeEventListener() {} }
afterAll(() => { root.window = had })

for (const lang of ['pt', 'en'] as const) test(`an empty live fleet says nothing runs, never that the machine has no sessions (${lang})`, () => {
  const html = renderToStaticMarkup(<FleetOverview lang={lang} rows={[]} loading={false} unsupported={false} />)
  expect(html).toContain(lang === 'pt' ? 'Nada rodando nesta máquina agora.' : 'Nothing is running on this machine right now.')
  expect(html).toContain(lang === 'pt' ? 'Encerradas' : 'Ended')
  expect(html).not.toContain(lang === 'pt' ? 'Nenhuma sessão nesta máquina ainda' : 'No sessions on this machine yet')
})
