import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { NativeSessionActions } from './NativeSessionActions'
import { exportUrl, forkUrl } from '../../lib/nativeSession'

describe('H21: fork and export in the native session header', () => {
  test('the menu is closed at first; the URLs are the engine\'s', () => {
    const html = renderToStaticMarkup(<MemoryRouter><NativeSessionActions sessionId="ses_x" running={false} lang="en" /></MemoryRouter>)
    expect(html).toContain('Session actions')
    expect(html).toContain('aria-expanded="false"')
    expect(forkUrl('ses_x')).toBe('/api/runtime/sessions/ses_x/fork')
    expect(exportUrl('ses_x', 'json')).toBe('/api/runtime/sessions/ses_x/export?format=json')
  })
})
