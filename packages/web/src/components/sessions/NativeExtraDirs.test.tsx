import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { NativeExtraDirs } from './NativeExtraDirs'

describe('H20: the extra folders in the native chat', () => {
  test('lists the session\'s folders; the add button is disabled while a run is in flight', () => {
    const idle = renderToStaticMarkup(<NativeExtraDirs dirs={['/home/u/other']} running={false} lang="en" onAdd={async () => null} />)
    expect(idle).toContain('/home/u/other')
    expect(idle).toContain('Add a folder outside the workspace')
    expect(idle).not.toContain('disabled=""')
    const busy = renderToStaticMarkup(<NativeExtraDirs dirs={[]} running lang="pt" onAdd={async () => null} />)
    expect(busy).toContain('disabled=""')
    expect(busy).toContain('pasta')
  })
})
