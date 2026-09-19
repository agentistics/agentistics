/**
 * The question's markup, rendered with `renderToStaticMarkup` (no jsdom here). The store's
 * server snapshot is empty by design, so the modal is asserted through `UnsavedLeaveQuestion`,
 * which is the guard's whole render as a function of that state.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { UnsavedChangesGuard, UnsavedLeaveQuestion } from './UnsavedChangesGuard'

// `ConfirmModal` reads `window.innerWidth` through `useIsMobile`; Bun has no DOM. Same shim
// `Studio.test.tsx` uses, removed afterwards only if it was ours.
const env = globalThis as unknown as { window?: { innerWidth: number } }
const windowIsOurs = env.window === undefined
env.window ??= { innerWidth: 1280 }
afterAll(() => { if (windowIsOurs) delete env.window })

describe('UnsavedLeaveQuestion', () => {
  test('a held close with dirty files draws the question, naming them', () => {
    const html = renderToStaticMarkup(
      <UnsavedLeaveQuestion files={['src/a.ts', 'README.md']} question={{ cause: 'close' }} lang="en" />,
    )
    expect(html).toContain('Discard unsaved changes?')
    expect(html).toContain('2 files in the Studio have changes that have not been saved (a.ts, README.md).')
    expect(html).toContain('Close anyway')
    expect(html).toContain('Keep editing')
  })

  test('a held navigation says it is LEAVING, in Portuguese too', () => {
    const html = renderToStaticMarkup(
      <UnsavedLeaveQuestion files={['a.ts']} question={{ cause: 'leave' }} lang="pt" />,
    )
    expect(html).toContain('Sair desta sessão descarta o que ainda não foi salvo.')
    expect(html).toContain('Sair mesmo assim')
  })

  test('no question, or nothing left unsaved, draws nothing', () => {
    expect(renderToStaticMarkup(<UnsavedLeaveQuestion files={['a']} question={null} lang="en" />)).toBe('')
    expect(renderToStaticMarkup(
      <UnsavedLeaveQuestion files={[]} question={{ cause: 'close' }} lang="en" />,
    )).toBe('')
  })
})

describe('UnsavedChangesGuard', () => {
  test('mounts inside a router and outside one without throwing', () => {
    expect(() => renderToStaticMarkup(
      <MemoryRouter><UnsavedChangesGuard lang="en" sessionKeys={['s1']} /></MemoryRouter>,
    )).not.toThrow()
    expect(() => renderToStaticMarkup(<UnsavedChangesGuard lang="en" sessionKeys={[]} />)).not.toThrow()
  })
})
