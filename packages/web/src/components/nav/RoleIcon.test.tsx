import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { RoleIcon } from './RoleIcon'

describe('RoleIcon', () => {
  test('leader keeps the purple crown', () => {
    const h = renderToStaticMarkup(<RoleIcon kind="leader" size={13} pt />)
    expect(h).toContain('data-role-icon="leader"')
    expect(h).toContain('var(--accent-purple)')
    expect(h).toContain('aria-label="líder"')
  })
  test('worker is the blue crossed tools', () => {
    const h = renderToStaticMarkup(<RoleIcon kind="worker" size={13} pt={false} />)
    expect(h).toContain('data-role-icon="worker"')
    expect(h).toContain('var(--accent-cyan)')
    expect(h).toContain('width="13"')
  })
  test('auto is a quiet grey mark named in both languages', () => {
    expect(renderToStaticMarkup(<RoleIcon kind="auto" size={13} pt />)).toContain('aria-label="papel automático"')
    const en = renderToStaticMarkup(<RoleIcon kind="auto" size={13} pt={false} />)
    expect(en).toContain('aria-label="automatic role"')
    expect(en).toContain('var(--text-tertiary)')
  })
})
