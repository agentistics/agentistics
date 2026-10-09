import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { SessionActions } from './SessionActions'
import type { FleetRow } from '../../lib/fleet'

const row = (verbs: FleetRow['verbs']): FleetRow => ({
  id: 'agentop-abc', title: 'a session', harness: 'claude', cwd: '/x', project: 'x',
  state: 'waiting', stateLabel: 'waiting', actionable: true, attachCommand: '', verbs,
} as FleetRow)

const act = async () => ({ ok: true, message: '' })

describe('SessionActions — Open in terminal', () => {
  test('the menu stays closed until opened (the verb is inside it)', () => {
    const html = renderToStaticMarkup(<SessionActions row={row([{ action: 'terminal', label: 'Open in terminal', enabled: true }])} lang="en" act={act} />)
    expect(html).toContain('Session actions')
    expect(html).not.toContain('Open in terminal')
  })
})
