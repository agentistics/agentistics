import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { HarnessId } from '@agentistics/core'
import { availableHarnesses } from './sessions/harness-available'
import { briefingSkills, managedBlock, managedTargets, removeManagedBlocks, replaceManagedBlock, skillMarkdown, type ManagedTarget } from './briefing'

export type InstallOptions = { home: string; harnesses?: readonly HarnessId[]; uninstall?: boolean; planLimitsAvailable?: boolean }
export type InstallResult = { harness: HarnessId; path: string; changed: boolean; removed?: boolean }[]

function selected(o: InstallOptions): ManagedTarget[] {
  const ids = o.harnesses ?? (() => {
    const a = availableHarnesses()
    return a.blind ? [] : a.ids
  })()
  return managedTargets(o.home).filter(t => ids.includes(t.harness))
}

async function read(path: string): Promise<string | null> {
  try { return await readFile(path, 'utf8') } catch { return null }
}

export async function installBriefing(o: InstallOptions): Promise<InstallResult> {
  const out: InstallResult = []
  for (const target of selected(o)) {
    const before = await read(target.path)
    if (target.skills) {
      const root = join(dirname(target.path), 'skills')
      for (const skill of briefingSkills({ planLimitsAvailable: o.planLimitsAvailable })) {
        const path = join(root, skill.name, 'SKILL.md')
        const desired = skillMarkdown(skill)
        const prior = await read(path)
        if (prior !== desired) { await mkdir(dirname(path), { recursive: true, mode: 0o700 }); await writeFile(path, desired, { mode: 0o600 }) }
        out.push({ harness: target.harness, path, changed: prior !== desired })
      }
      continue
    }
    let content = before ?? ''
    for (const skill of briefingSkills({ planLimitsAvailable: o.planLimitsAvailable })) content = replaceManagedBlock(content, managedBlock(skill))
    if (content !== before) { await mkdir(dirname(target.path), { recursive: true, mode: 0o700 }); await writeFile(target.path, content, { mode: 0o600 }) }
    out.push({ harness: target.harness, path: target.path, changed: content !== before })
  }
  return out
}

export async function uninstallBriefing(o: InstallOptions): Promise<InstallResult> {
  const out: InstallResult = []
  for (const target of selected(o)) {
    if (target.skills) {
      for (const skill of briefingSkills()) {
        const path = join(dirname(target.path), 'skills', skill.name, 'SKILL.md')
        const content = await read(path)
        if (content?.includes('agentistics-managed-briefing:')) { await rm(path); out.push({ harness: target.harness, path, changed: true, removed: true }) }
      }
      continue
    }
    const before = await read(target.path)
    if (before === null || !before.includes('agentistics-managed-briefing:')) { out.push({ harness: target.harness, path: target.path, changed: false }); continue }
    const after = removeManagedBlocks(before)
    if (after.trim() === '') await rm(target.path)
    else await writeFile(target.path, after, { mode: 0o600 })
    out.push({ harness: target.harness, path: target.path, changed: true, removed: after.trim() === '' })
  }
  return out
}
