import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { INBOX_CSS } from './ThreadsPanel'

const src = readFileSync(join(import.meta.dir, 'ThreadsPanel.tsx'), 'utf8')
describe('the inbox rows look clickable', () => {
  test('hover wash, pointer, a chevron that reacts, and a focus ring', () => {
    expect(INBOX_CSS).toContain('.ag-inbox-row{cursor:pointer')
    expect(INBOX_CSS).toContain('.ag-inbox-row:hover')
    expect(INBOX_CSS).toContain('.ag-inbox-chev')
    expect(INBOX_CSS).toContain(':focus-visible')
  })
  test('topics and "loose comments" both carry the row class and a chevron', () => {
    expect((src.match(/className="ag-inbox-row"/g) ?? []).length).toBe(2)
    expect((src.match(/className="ag-inbox-chev"/g) ?? []).length).toBe(2)
  })
})
