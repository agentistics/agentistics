import { describe, expect, test } from 'bun:test'
import {
  grantsPower,
  planAgentNarrowing,
  planMcpServerShadow,
  planProfileNarrowing,
  resolveCatalogue,
} from './precedence.ts'
import { CATALOGUE_KINDS, type CatalogueEntry, type CatalogueKind, type CatalogueScope } from './types.ts'
import { problem } from './problems.ts'
import type { PolicyRule } from '../policy/rules.ts'

function entry<K extends CatalogueKind>(
  kind: K,
  name: string,
  scope: CatalogueScope,
  extra: Partial<CatalogueEntry<K>> = {},
): CatalogueEntry<K> {
  return {
    kind,
    name,
    scope,
    source: scope === 'builtin' ? {} : { path: `/${scope}/${kind}/${name}` },
    enabled: true,
    trust: scope === 'project' ? 'untrusted' : 'n/a',
    problems: [],
    ...extra,
  }
}

const cmd = (name: string, scope: CatalogueScope, override?: boolean, extra: Partial<CatalogueEntry<'command'>> = {}) =>
  entry('command', name, scope, {
    def: { description: 'd', template: 't', ...(override === undefined ? {} : { override }) },
    ...extra,
  })

describe('resolveCatalogue precedence', () => {
  const kinds: CatalogueKind[] = ['skill', 'agent', 'mcpServer', 'permissionProfile', 'afterEdit']
  for (const kind of kinds) {
    test(`project > user > compat > builtin for ${kind}`, () => {
      const all = (['builtin', 'compat', 'user', 'project'] as const).map((s) => entry(kind, 'x', s))
      const r = resolveCatalogue(all)
      expect(r.entries).toHaveLength(1)
      expect(r.entries[0]?.scope).toBe('project')
      expect(r.entries[0]?.shadows).toEqual({ scope: 'user', path: '/user/' + kind + '/x' })
      expect(r.shadowed.map((e) => e.scope)).toEqual(['user', 'compat', 'builtin'])
    })
  }

  test('names do not collide across kinds', () => {
    const r = resolveCatalogue([entry('skill', 'x', 'user'), entry('agent', 'x', 'user')])
    expect(r.entries).toHaveLength(2)
    expect(r.shadowed).toHaveLength(0)
  })

  test('a lone entry carries no shadows', () => {
    const r = resolveCatalogue([entry('skill', 'x', 'user')])
    expect(r.entries[0]?.shadows).toBeUndefined()
  })

  test('shadows omits path when the shadowed entry is builtin', () => {
    const r = resolveCatalogue([entry('skill', 'x', 'user'), entry('skill', 'x', 'builtin')])
    expect(r.entries[0]?.shadows).toEqual({ scope: 'builtin' })
  })

  test('a disabled entry is listed, does not win, and lets the lower one show through', () => {
    const off = entry('skill', 'x', 'project', { enabled: false })
    const low = entry('skill', 'x', 'user')
    const r = resolveCatalogue([off, low])
    expect(r.entries).toHaveLength(2)
    const enabled = r.entries.filter((e) => e.enabled)
    expect(enabled).toHaveLength(1)
    expect(enabled[0]?.scope).toBe('user')
    expect(enabled[0]?.shadows).toBeUndefined()
    expect(r.entries.find((e) => e.scope === 'project')).toEqual(off)
  })

  test('a problem entry is listed unchanged and never wins', () => {
    const bad = entry('skill', 'x', 'project', { enabled: false, problems: [problem('c', '/p', 3, 'e', 'p')] })
    const r = resolveCatalogue([bad, entry('skill', 'x', 'user')])
    expect(r.entries.find((e) => e.scope === 'project')).toEqual(bad)
    expect(r.entries.find((e) => e.enabled)?.scope).toBe('user')
  })

  test('a problem entry alone is still listed', () => {
    const bad = entry('agent', 'y', 'user', { enabled: false, problems: [problem('c', '/p', 1, 'e', 'p')] })
    expect(resolveCatalogue([bad]).entries).toEqual([bad])
  })
})

describe('built-in commands', () => {
  test('a project command cannot replace a built-in one', () => {
    const r = resolveCatalogue([cmd('help', 'builtin'), cmd('help', 'project')])
    const proj = r.entries.find((e) => e.scope === 'project')
    expect(proj?.enabled).toBe(false)
    expect(proj?.problems[0]?.code).toBe('catalogue.builtin-shadow-refused')
    expect(proj?.problems[0]?.en).toContain('/help')
    expect(proj?.problems[0]?.pt).toContain('embutido')
    expect(proj?.problems[0]?.path).toBe('/project/command/help')
    const active = r.entries.filter((e) => e.enabled)
    expect(active).toHaveLength(1)
    expect(active[0]?.scope).toBe('builtin')
  })

  test('a compat command is treated like a project one', () => {
    const r = resolveCatalogue([cmd('help', 'builtin'), cmd('help', 'compat')])
    expect(r.entries.find((e) => e.scope === 'compat')?.problems[0]?.code).toBe('catalogue.builtin-shadow-refused')
  })

  test('a user command without override is refused and says how to fix it', () => {
    const r = resolveCatalogue([cmd('help', 'builtin'), cmd('help', 'user')])
    const u = r.entries.find((e) => e.scope === 'user')
    expect(u?.enabled).toBe(false)
    expect(u?.problems[0]?.code).toBe('catalogue.builtin-shadow-needs-override')
    expect(u?.problems[0]?.en).toContain('override: true')
    expect(r.entries.find((e) => e.enabled)?.scope).toBe('builtin')
  })

  test('override: false is not an override', () => {
    const r = resolveCatalogue([cmd('help', 'builtin'), cmd('help', 'user', false)])
    expect(r.entries.find((e) => e.scope === 'user')?.enabled).toBe(false)
  })

  test('a user command with override wins and shadows the built-in', () => {
    const r = resolveCatalogue([cmd('help', 'builtin'), cmd('help', 'user', true)])
    const active = r.entries.filter((e) => e.enabled)
    expect(active).toHaveLength(1)
    expect(active[0]?.scope).toBe('user')
    expect(active[0]?.shadows).toEqual({ scope: 'builtin' })
    expect(r.shadowed.map((e) => e.scope)).toEqual(['builtin'])
  })

  test('with override user wins, and a project command is still refused', () => {
    const r = resolveCatalogue([cmd('help', 'builtin'), cmd('help', 'user', true), cmd('help', 'project')])
    expect(r.entries.filter((e) => e.enabled).map((e) => e.scope)).toEqual(['user'])
  })

  test('the guard applies to commands only', () => {
    const r = resolveCatalogue([entry('skill', 'help', 'builtin'), entry('skill', 'help', 'project')])
    expect(r.entries.find((e) => e.enabled)?.scope).toBe('project')
  })

  test('a project command on a name with no built-in is fine', () => {
    const r = resolveCatalogue([cmd('deploy', 'project')])
    expect(r.entries[0]?.enabled).toBe(true)
  })
})

describe('duplicates and ordering', () => {
  test('the same name twice in one scope: first stays, the rest are problems', () => {
    const a = entry('skill', 'x', 'user', { source: { path: '/a' } })
    const b = entry('skill', 'x', 'user', { source: { path: '/b' } })
    const r = resolveCatalogue([b, a])
    expect(r.entries).toHaveLength(2)
    const ok = r.entries.find((e) => e.enabled)
    expect(ok?.source.path).toBe('/a')
    const dup = r.entries.find((e) => !e.enabled)
    expect(dup?.source.path).toBe('/b')
    expect(dup?.problems[0]?.code).toBe('catalogue.duplicate-name')
    expect(dup?.problems[0]?.path).toBe('/b')
    expect(dup?.problems[0]?.line).toBe(1)
  })

  test('output order is deterministic under shuffled input', () => {
    const base: CatalogueEntry[] = [
      entry('afterEdit', 'z', 'user'),
      entry('command', 'b', 'user'),
      entry('command', 'a', 'project'),
      entry('command', 'a', 'user'),
      entry('skill', 'a', 'user'),
      entry('skill', 'a', 'project'),
      entry('skill', 'b', 'builtin', { enabled: false }),
      entry('skill', 'b', 'user', { enabled: false }),
      entry('agent', 'q', 'compat'),
    ]
    const expected = resolveCatalogue(base)
    const keys = (r: ReturnType<typeof resolveCatalogue>) => [
      r.entries.map((e) => `${e.kind}/${e.name}/${e.scope}`),
      r.shadowed.map((e) => `${e.kind}/${e.name}/${e.scope}`),
    ]
    expect(keys(expected)).toEqual([
      ['command/a/project', 'command/b/user', 'skill/a/project', 'skill/b/user', 'skill/b/builtin', 'agent/q/compat', 'afterEdit/z/user'],
      ['command/a/user', 'skill/a/user'],
    ])
    let seed = 7
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
    for (let i = 0; i < 20; i++) {
      const shuffled = [...base].sort(() => rnd() - 0.5)
      expect(resolveCatalogue(shuffled)).toEqual(expected)
    }
    expect(CATALOGUE_KINDS.indexOf('command')).toBeLessThan(CATALOGUE_KINDS.indexOf('skill'))
  })
})

const rule = (id: string, effect: PolicyRule['effect']): PolicyRule => ({ id, effect, match: { tool: id } })
const profile = (scope: CatalogueScope, rules: PolicyRule[], description?: string) =>
  entry('permissionProfile', 'p', scope, { def: { rules, ...(description === undefined ? {} : { description }) } })

describe('planProfileNarrowing', () => {
  const wider = profile('user', [rule('w-allow', 'allow'), rule('w-deny', 'deny')], 'wide')

  test('untrusted project allow is ignored and listed; deny and ask are added', () => {
    const narrow = profile('project', [rule('n-allow', 'allow'), rule('n-deny', 'deny'), rule('n-ask', 'ask')])
    const plan = planProfileNarrowing(wider, narrow, { trusted: false })
    expect(plan.effective.rules.map((r) => r.id)).toEqual(['w-allow', 'w-deny', 'n-deny', 'n-ask'])
    expect(plan.ignored).toHaveLength(1)
    expect(plan.ignored[0]?.what).toBe('n-allow')
    expect(plan.ignored[0]?.en).toContain('needs trust')
    expect(plan.ignored[0]?.pt).toContain('confiança')
    expect(plan.effective.description).toBe('wide')
  })

  test('trusted project allow is kept', () => {
    const narrow = profile('project', [rule('n-allow', 'allow')], 'mine')
    const plan = planProfileNarrowing(wider, narrow, { trusted: true })
    expect(plan.effective.rules.map((r) => r.id)).toEqual(['w-allow', 'w-deny', 'n-allow'])
    expect(plan.ignored).toEqual([])
    expect(plan.effective.description).toBe('mine')
  })

  test('user scope is the person: its allows apply without trust', () => {
    const base = profile('builtin', [rule('b-deny', 'deny')])
    const plan = planProfileNarrowing(base, profile('user', [rule('u-allow', 'allow')]), { trusted: false })
    expect(plan.effective.rules.map((r) => r.id)).toEqual(['b-deny', 'u-allow'])
    expect(plan.ignored).toEqual([])
  })

  test('a colliding id is kept on both sides', () => {
    const plan = planProfileNarrowing(wider, profile('project', [rule('w-deny', 'deny')]), { trusted: false })
    expect(plan.effective.rules.map((r) => r.id)).toEqual(['w-allow', 'w-deny', 'w-deny'])
  })

  test('a narrower with no def leaves the wider untouched', () => {
    const plan = planProfileNarrowing(wider, entry('permissionProfile', 'p', 'project'), { trusted: false })
    expect(plan.effective.rules).toEqual(wider.def?.rules ?? [])
  })
})

const agent = (scope: CatalogueScope, def: Partial<NonNullable<CatalogueEntry<'agent'>['def']>>) =>
  entry('agent', 'a', scope, { def: { description: 'd-' + scope, prompt: 'p-' + scope, ...def } })

describe('planAgentNarrowing', () => {
  test('absent tools keep the wider list; text comes from the narrower', () => {
    const plan = planAgentNarrowing(agent('user', { tools: ['read', 'write'], model: 'm1' }), agent('project', {}), { trusted: false })
    expect(plan.effective.tools).toEqual(['read', 'write'])
    expect(plan.effective.description).toBe('d-project')
    expect(plan.effective.prompt).toBe('p-project')
    expect(plan.effective.model).toBe('m1')
  })

  test('untrusted tools are intersected and extras listed', () => {
    const plan = planAgentNarrowing(agent('user', { tools: ['read', 'write'] }), agent('project', { tools: ['read', 'shell'] }), { trusted: false })
    expect(plan.effective.tools).toEqual(['read'])
    expect(plan.ignored.map((i) => i.what)).toEqual(['shell'])
  })

  test('a narrower list over an unrestricted wider one only removes', () => {
    const plan = planAgentNarrowing(agent('user', {}), agent('project', { tools: ['read'] }), { trusted: false })
    expect(plan.effective.tools).toEqual(['read'])
    expect(plan.ignored).toEqual([])
  })

  test('trusted project may add tools', () => {
    const plan = planAgentNarrowing(agent('user', { tools: ['read'] }), agent('project', { tools: ['read', 'shell'] }), { trusted: true })
    expect(plan.effective.tools).toEqual(['read', 'shell'])
    expect(plan.ignored).toEqual([])
  })

  test('a different permission profile is ignored unless trusted', () => {
    const w = agent('user', { permissionProfile: 'strict' })
    const n = agent('project', { permissionProfile: 'loose' })
    const off = planAgentNarrowing(w, n, { trusted: false })
    expect(off.effective.permissionProfile).toBe('strict')
    expect(off.ignored.map((i) => i.what)).toEqual(['loose'])
    expect(planAgentNarrowing(w, n, { trusted: true }).effective.permissionProfile).toBe('loose')
  })

  test('same or absent permission profile keeps the wider', () => {
    const w = agent('user', { permissionProfile: 'strict' })
    expect(planAgentNarrowing(w, agent('project', { permissionProfile: 'strict' }), { trusted: false }).ignored).toEqual([])
    expect(planAgentNarrowing(w, agent('project', {}), { trusted: false }).effective.permissionProfile).toBe('strict')
  })

  test('naming a profile where the wider named none is a potential widening', () => {
    const plan = planAgentNarrowing(agent('user', {}), agent('project', { permissionProfile: 'loose' }), { trusted: false })
    expect(plan.effective.permissionProfile).toBeUndefined()
    expect(plan.ignored).toHaveLength(1)
  })

  test('user scope narrower widens freely', () => {
    const plan = planAgentNarrowing(agent('builtin', { tools: ['read'] }), agent('user', { tools: ['read', 'shell'] }), { trusted: false })
    expect(plan.effective.tools).toEqual(['read', 'shell'])
  })
})

describe('planMcpServerShadow', () => {
  const srv = (scope: CatalogueScope) =>
    entry('mcpServer', 's', scope, { def: { type: 'stdio', command: ['x'] } })

  test('an untrusted project server needs trust (new or replacing)', () => {
    const fresh = planMcpServerShadow(undefined, srv('project'), { trusted: false })
    expect(fresh.decision).toBe('needs-trust')
    const repl = planMcpServerShadow(srv('user'), srv('project'), { trusted: false })
    expect(repl.decision).toBe('needs-trust')
    expect(repl.en).toContain('replacing')
    expect(repl.pt).toContain('substituindo')
  })

  test('trusted project and user scope are used', () => {
    expect(planMcpServerShadow(srv('user'), srv('project'), { trusted: true }).decision).toBe('use')
    expect(planMcpServerShadow(undefined, srv('user'), { trusted: false }).decision).toBe('use')
  })
})

describe('grantsPower', () => {
  test('classifies each kind', () => {
    expect(grantsPower(entry('mcpServer', 's', 'user'))).toBe(true)
    expect(grantsPower(entry('afterEdit', 'a', 'user'))).toBe(true)
    expect(grantsPower(profile('user', [rule('d', 'deny'), rule('k', 'ask')]))).toBe(false)
    expect(grantsPower(profile('user', [rule('d', 'deny'), rule('a', 'allow')]))).toBe(true)
    expect(grantsPower(agent('user', {}))).toBe(false)
    expect(grantsPower(agent('user', { tools: ['read'] }))).toBe(true)
    expect(grantsPower(agent('user', { permissionProfile: 'p' }))).toBe(true)
    expect(grantsPower(cmd('x', 'user'))).toBe(false)
    expect(grantsPower(entry('skill', 'x', 'user'))).toBe(false)
  })
})
