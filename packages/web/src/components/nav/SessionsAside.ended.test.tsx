import { expect, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import type { ControlSession } from '@agentistics/tui/control/session-fleet'
import { SessionRow } from './SessionsAside'

const resume = { action: 'resume', label: 'Reopen', enabled: true }
const session = { id: 'ended-row', title: 'Finished work', harness: 'codex', state: 'exited', stateLabel: 'Ended', task: 'Delivery marker', model: 'model-marker' } as ControlSession

test('ended row reuses the rail’s single-line identity without the full card metadata', () => {
  const html = renderToStaticMarkup(<SessionRow session={session} compact selected={false} cardColor="wash" onOpen={() => {}} lang="en" />)
  expect(html).toContain('Finished work')
  expect(html).toContain('white-space:nowrap')
  expect(html).toContain('padding:6px 8px')
  expect(html).not.toContain('Delivery marker')
  // The full model is still in the row tooltip, not a second line.
  expect(html).not.toContain('>model-marker</span>')
  const normal = renderToStaticMarkup(<SessionRow session={session} selected={false} cardColor="wash" onOpen={() => {}} />)
  expect(normal).toContain('Delivery marker')
})

test('compact row still opens, pins and exposes its resume actions on mobile and keyboard', () => {
  let opened = 0, pinned = 0, menu = 0
  let row!: ReturnType<typeof SessionRow>
  function Row() {
    row = SessionRow({ session, compact: true, selected: true, cardColor: 'wash', tap: 44, lang: 'en',
      onOpen: () => { opened++ }, onPin: () => { pinned++ }, verbs: [resume],
      onOpenMenu: (_x, _y, verbs) => { expect(verbs).toEqual([resume]); menu++ },
    })
    return row
  }
  const html = renderToStaticMarkup(<Row />)
  expect(html).toContain('min-height:44px')
  expect(html).toContain('Options for Finished work')
  expect(html).toContain('aria-haspopup="menu"')
  row.props.onClick()
  const event = { stopPropagation() {}, preventDefault() {}, key: 'Enter', currentTarget: { getBoundingClientRect: () => ({ left: 10, bottom: 20 }) } }
  React.Children.forEach(row.props.children, child => {
    if (!React.isValidElement<{ 'aria-label'?: string; onClick?: (e: typeof event) => void; onKeyDown?: (e: typeof event) => void }>(child)) return
    if (child.props['aria-label'] === 'Options for Finished work') child.props.onKeyDown!(event)
    if (child.props['aria-label'] === 'Pin') child.props.onClick!(event)
  })
  expect(opened).toBe(1); expect(pinned).toBe(1); expect(menu).toBe(1)
})

test('expanded ended members select compact rows while live members keep full rows', () => {
  const src = readFileSync(new URL('./SessionsAside.tsx', import.meta.url), 'utf8')
  expect(src).toContain('{live.map(s => renderRow(s))}')
  expect(src).toContain('{endedOpen && ended.map(s => renderRow(s, true))}')
  expect(src).toContain('compact={compact}')
})
