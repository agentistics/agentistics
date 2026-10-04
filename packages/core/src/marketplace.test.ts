import { describe, expect, test } from 'bun:test'
import { filterListings, marketplaceKindMatches, marketplaceSourceKind, redactUrlCredentials, type MarketplaceListing } from './marketplace'

const l = (name: string, kind: string, description = '', author = 'Agentistics'): MarketplaceListing =>
  ({ name, version: '1.0.0', kind, description, author, source: '', sha256: '0'.repeat(64), installedVersion: null })

describe('marketplace wire helpers', () => {
  test('kind filter: free-text index kinds, `bundle` only under "all"', () => {
    expect(marketplaceKindMatches('Skill', 'skill')).toBe(true)
    expect(marketplaceKindMatches('permissionProfile', 'profile')).toBe(true)
    expect(marketplaceKindMatches('mcp-server', 'mcp')).toBe(true)
    expect(marketplaceKindMatches('bundle', 'skill')).toBe(false)
    expect(marketplaceKindMatches('bundle', 'all')).toBe(true)
  })
  test('search reads name, description and author', () => {
    const all = [l('review-kit', 'skill', 'Code review'), l('lint', 'agent', 'Lints', 'Ana')]
    expect(filterListings(all, 'REVIEW', 'all').map(x => x.name)).toEqual(['review-kit'])
    expect(filterListings(all, 'ana', 'all').map(x => x.name)).toEqual(['lint'])
    expect(filterListings(all, '', 'agent').map(x => x.name)).toEqual(['lint'])
  })
  test('credentials are stripped from any URL in a string', () => {
    expect(redactUrlCredentials('git:https://alice:tok@github.com/x.git failed')).toBe('git:https://github.com/x.git failed')
    expect(redactUrlCredentials('https://github.com/x')).toBe('https://github.com/x')
  })
  test('source kinds: absolute paths only for folders and claude:', () => {
    expect(marketplaceSourceKind('market:review-kit')).toBe('market')
    expect(marketplaceSourceKind('git+https://github.com/a/b#v1')).toBe('git')
    expect(marketplaceSourceKind('https://x.dev/p.tar.gz')).toBe('archive')
    expect(marketplaceSourceKind('/home/me/pkg')).toBe('folder')
    expect(marketplaceSourceKind('claude:/home/me/.claude/plugins/x')).toBe('claude')
    expect(marketplaceSourceKind('claude:rel')).toBe('invalid')
    expect(marketplaceSourceKind('rel/dir')).toBe('invalid')
    expect(marketplaceSourceKind('https://x.dev/page')).toBe('invalid')
  })
})
