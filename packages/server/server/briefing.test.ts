import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { BRIEFING_VERSION, MANAGED_OPEN, PLAN_LIMITS_TOOL, briefingSkills, briefingText, managedBlock, managedTargets, removeManagedBlocks, replaceManagedBlock, skillMarkdown } from './briefing'
import { flowLines } from './briefing-flow'
import { ensureBriefingInstalled, installBriefing, uninstallBriefing } from './briefing-installer'

describe('managed briefing source', () => {
  test('all skills follow the Agent Skills frontmatter contract', () => {
    for (const skill of briefingSkills()) {
      const text = skillMarkdown(skill)
      expect(text).toMatch(new RegExp(`^---\\nname: ${skill.name}\\ndescription: .+\\n`))
      expect(text).toContain(`agentistics-version: "${BRIEFING_VERSION}"`)
      expect(text).toContain('agentistics-managed-briefing:')
    }
  })

  test('replaces only agentistics-owned blocks and leaves user text', () => {
    const user = '# Mine\n\n' + managedBlock(briefingSkills()[0]!, 0)
    const next = replaceManagedBlock(user, managedBlock(briefingSkills()[0]!))
    expect(next).toContain('# Mine')
    expect(next).toContain(`v${BRIEFING_VERSION}`)
    expect(removeManagedBlocks(next)).toBe('# Mine\n')
  })

  test('keeps all four managed topics and is idempotent for instruction-only harnesses', async () => {
    const home = await mkdtemp(join(tmpdir(), 'agentistics-briefing-topics-'))
    const path = join(home, '.codex', 'AGENTS.md')
    await Bun.write(path, '# User rules\n')
    await installBriefing({ home, harnesses: ['codex'] })
    const first = await readFile(path, 'utf8')
    for (const skill of briefingSkills()) expect(first).toContain(skill.name)
    await installBriefing({ home, harnesses: ['codex'] })
    expect(await readFile(path, 'utf8')).toBe(first)
    await uninstallBriefing({ home, harnesses: ['codex'] })
    expect(await readFile(path, 'utf8')).toBe('# User rules\n')
  })

  test('plan limits and Portuguese briefing are guarded and complete', () => {
    expect(briefingText('en')).not.toContain(PLAN_LIMITS_TOOL)
    expect(briefingText('en', { planLimitsAvailable: true })).toContain(PLAN_LIMITS_TOOL)
    expect(briefingText('pt')).toContain('segredos')
    expect(briefingText('pt')).toContain('hand-off')
    expect(briefingText('en')).toContain('Ask the person in the conversation')
    expect(briefingText('pt')).toContain('Pergunte à pessoa na conversa')
    expect(briefingText('en')).toContain('in_progress → in_review → done')
    expect(briefingText('pt')).toContain('in_progress → in_review → done')
    expect(briefingText('pt')).toContain('Habilidades gerenciadas instaladas:')
    expect(briefingText('pt', { planLimitsAvailable: true })).toContain('Antes de abrir sessões')
  })

  test('installer detects plan limits from the actual tool list', async () => {
    const home = await mkdtemp(join(tmpdir(), 'agentistics-briefing-limits-'))
    await installBriefing({ home, harnesses: ['codex'], toolNames: [PLAN_LIMITS_TOOL] })
    expect(await readFile(join(home, '.codex', 'AGENTS.md'), 'utf8')).toContain(PLAN_LIMITS_TOOL)
  })
})

describe('briefing installer', () => {
  const flowSkill = () => briefingSkills().find(x => x.name === 'agentistics-session-flow')!
  test('v1 -> v2 upgrade keeps user text around the managed block in an owned SKILL.md', async () => {
    const home = await mkdtemp(join(tmpdir(), 'agentistics-briefing-v1-'))
    const path = join(home, '.claude', 'skills', 'agentistics-vault', 'SKILL.md')
    const vault = briefingSkills().find(x => x.name === 'agentistics-vault')!
    await mkdir(join(home, '.claude', 'skills', 'agentistics-vault'), { recursive: true })
    const v1 = skillMarkdown(vault, 1).replace('\n---\n\n', '\n---\n\nMY NOTES BEFORE\n\n').replace(/\n$/, '\n\nMY NOTES AFTER\n')
    await writeFile(path, v1)
    const r = await installBriefing({ home, harnesses: ['claude'] })
    expect(r.find(x => x.path === path)?.changed).toBe(true)
    const next = await readFile(path, 'utf8')
    expect(next).toContain('MY NOTES BEFORE')
    expect(next).toContain('MY NOTES AFTER')
    expect(next).toContain(`${MANAGED_OPEN}${BRIEFING_VERSION} agentistics-vault`)
    expect(next).not.toContain(`${MANAGED_OPEN}1 `)
    expect(next).toContain(`agentistics-version: "${BRIEFING_VERSION}"`)
    // idempotent, and uninstall keeps the user's text (file not deleted)
    expect((await installBriefing({ home, harnesses: ['claude'] })).some(x => x.changed)).toBe(false)
    await uninstallBriefing({ home, harnesses: ['claude'] })
    const left = await readFile(path, 'utf8')
    expect(left).toContain('MY NOTES BEFORE')
    expect(left).toContain('MY NOTES AFTER')
    expect(left).not.toContain(MANAGED_OPEN)
  })

  test('an unowned SKILL.md with the same name is never overwritten (skipped)', async () => {
    const home = await mkdtemp(join(tmpdir(), 'agentistics-briefing-collide-'))
    const dir = join(home, '.claude', 'skills', 'agentistics-session-flow')
    await mkdir(dir, { recursive: true })
    const mine = '---\nname: agentistics-session-flow\ndescription: mine\n---\nMy own skill\n'
    await writeFile(join(dir, 'SKILL.md'), mine)
    const r = await installBriefing({ home, harnesses: ['claude'] })
    expect(await readFile(join(dir, 'SKILL.md'), 'utf8')).toBe(mine)
    expect(r.find(x => x.path === join(dir, 'SKILL.md'))).toMatchObject({ changed: false, skipped: true })
    // the other skills were still installed
    expect(await readFile(join(home, '.claude', 'skills', 'agentistics-vault', 'SKILL.md'), 'utf8')).toContain(MANAGED_OPEN)
    await uninstallBriefing({ home, harnesses: ['claude'] })
    expect(await readFile(join(dir, 'SKILL.md'), 'utf8')).toBe(mine)
  })

  test('uninstall keeps a SKILL.md whose frontmatter the user customized, deletes a pristine one', async () => {
    const home = await mkdtemp(join(tmpdir(), 'agentistics-briefing-fm-'))
    await installBriefing({ home, harnesses: ['claude'] })
    const custom = join(home, '.claude', 'skills', 'agentistics-session-flow', 'SKILL.md')
    const pristine = join(home, '.claude', 'skills', 'agentistics-vault', 'SKILL.md')
    const edited = (await readFile(custom, 'utf8')).replace(/^description: .*$/m, 'description: my own words').replace('metadata:', 'owner: me\nmetadata:')
    await writeFile(custom, edited)
    await uninstallBriefing({ home, harnesses: ['claude'] })
    const kept = await readFile(custom, 'utf8')
    expect(kept).toContain('description: my own words')
    expect(kept).toContain('owner: me')
    expect(kept).not.toContain(MANAGED_OPEN)
    expect(await readFile(pristine, 'utf8').catch(() => null)).toBeNull()
  })

  test('every installer target output carries the full flow (en+pt) and keeps user text', async () => {
    const home = await mkdtemp(join(tmpdir(), 'agentistics-briefing-targets-'))
    const targets = managedTargets(home)
    for (const t of targets.filter(x => !x.skills)) { await mkdir(join(t.path, '..'), { recursive: true }); await writeFile(t.path, '# User rules\n') }
    await installBriefing({ home, harnesses: targets.map(t => t.harness) })
    expect(targets).toHaveLength(6)
    for (const t of targets) {
      const out = t.skills ? await readFile(join(home, '.claude', 'skills', 'agentistics-session-flow', 'SKILL.md'), 'utf8') : await readFile(t.path, 'utf8')
      for (const line of [...flowLines('en'), ...flowLines('pt')]) expect(out).toContain(line)
      if (!t.skills) expect(out).toContain('# User rules')
    }
  })

  test('is idempotent and uninstall preserves user instructions', async () => {
    const home = await mkdtemp(join(tmpdir(), 'agentistics-briefing-'))
    const codex = join(home, '.codex', 'AGENTS.md')
    await Bun.write(codex, '# User rules\n')
    const first = await installBriefing({ home, harnesses: ['codex'] })
    const bytes = await readFile(codex, 'utf8')
    const second = await installBriefing({ home, harnesses: ['codex'] })
    expect(first.some(x => x.changed)).toBe(true)
    expect(second.some(x => x.changed)).toBe(false)
    expect(await readFile(codex, 'utf8')).toBe(bytes)
    await uninstallBriefing({ home, harnesses: ['codex'] })
    expect(await readFile(codex, 'utf8')).toBe('# User rules\n')
  })

  test('skill harness install and removal is clean', async () => {
    const home = await mkdtemp(join(tmpdir(), 'agentistics-briefing-'))
    await installBriefing({ home, harnesses: ['claude'] })
    const path = join(home, '.claude', 'skills', briefingSkills()[0]!.name, 'SKILL.md')
    expect(await readFile(path, 'utf8')).toContain(briefingSkills()[0]!.name)
    await uninstallBriefing({ home, harnesses: ['claude'] })
    await expect(stat(path)).rejects.toThrow()
    await expect(readdir(join(home, '.claude', 'skills'))).rejects.toThrow()
  })

  test('automatic install is versioned in agentop state and respects opt-outs', async () => {
    const home = await mkdtemp(join(tmpdir(), 'agentistics-briefing-auto-home-'))
    const dataDir = await mkdtemp(join(tmpdir(), 'agentistics-briefing-auto-data-'))
    const options = { home, dataDir, harnesses: ['codex'] as const, readSettings: async () => ({}) }
    const first = await ensureBriefingInstalled(options)
    expect(first?.some(x => x.changed)).toBe(true)
    expect(await readFile(join(dataDir, 'briefing-state.json'), 'utf8')).toContain(`"version":${BRIEFING_VERSION}`)
    expect(await ensureBriefingInstalled(options)).toEqual([])
    expect(await ensureBriefingInstalled({ ...options, env: { AGENTISTICS_BRIEFING: '0' } })).toBeNull()
    expect(await ensureBriefingInstalled({ ...options, readSettings: async () => ({ briefingAutoInstall: false }) })).toBeNull()
  })
})

test('targets use the harness global instruction locations', () => {
  const targets = managedTargets('/home/u')
  expect(targets.find(x => x.harness === 'claude')?.path).toBe('/home/u/.claude/CLAUDE.md')
  expect(targets.find(x => x.harness === 'codex')?.path).toBe('/home/u/.codex/AGENTS.md')
  expect(targets.find(x => x.harness === 'gemini')?.path).toBe('/home/u/.gemini/GEMINI.md')
  expect(targets.find(x => x.harness === 'antigravity')?.path).toBe('/home/u/.gemini/antigravity-cli/AGENTS.md')
  expect(targets.find(x => x.harness === 'antigravity')?.skills).toBe(false)
})
