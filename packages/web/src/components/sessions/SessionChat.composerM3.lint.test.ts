/** Focused source checks for the M3 composer controls. */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { stripComments } from '../../lib/stripComments'

const source = stripComments(readFileSync(join(import.meta.dir, 'SessionChat.tsx'), 'utf8'))
const statusAt = source.indexOf('data-composer-status')
const statusSource = source.slice(statusAt)

describe('M3 composer status controls', () => {
  test('anchors the mode menu to the visible status button', () => {
    expect(statusAt).toBeGreaterThan(0)
    expect(statusSource).toContain('ref={modeButtonRef}')
    expect(source.slice(0, statusAt)).not.toContain('ref={modeButtonRef}')
    expect(statusSource).toContain('getBoundingClientRect()')
  })

  test('opens the model menu from the visible model button', () => {
    expect(statusSource).toContain('ref={moreButtonRef}')
    expect(statusSource).toContain('title={pt ? \'Trocar modelo e esforço\' : \'Change model and effort\'}')
    expect(statusSource).toContain('onClick={() => setMoreOpen(value => !value)}')
    expect(source.slice(0, statusAt)).not.toContain('ref={moreButtonRef}')
  })

  test('keeps the status band mounted while answering a question', () => {
    expect(source.slice(Math.max(0, statusAt - 80), statusAt + 80)).not.toContain('!answeringNow')
  })
})
