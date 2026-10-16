import { mkdir, readFile, readdir, rm, rmdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { HarnessId } from '@agentistics/core'
import { availableHarnesses } from './sessions/harness-available'
import { AGENTISTICS_DATA_DIR, HOME_DIR } from './config'
import { readPreferences } from './preferences'
import { BRIEFING_VERSION, MANAGED_OPEN, briefingSkills, managedBlock, managedTargets, removeManagedBlocks, replaceManagedBlock, skillMarkdown, type ManagedTarget } from './briefing'

export type InstallOptions = { home: string; harnesses?: readonly HarnessId[]; uninstall?: boolean; planLimitsAvailable?: boolean; toolNames?: readonly string[] }
export type InstallResult = { harness: HarnessId; path: string; changed: boolean; removed?: boolean; skipped?: boolean }[]

export const BRIEFING_STATE_FILE = join(AGENTISTICS_DATA_DIR, 'briefing-state.json')

type BriefingState = { version: number }

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

async function pruneEmpty(path: string): Promise<void> {
  try {
    if ((await readdir(path)).length === 0) { await rmdir(path); await pruneEmpty(dirname(path)) }
  } catch { /* absent or non-empty */ }
}

export async function installBriefing(o: InstallOptions): Promise<InstallResult> {
  const out: InstallResult = []
  for (const target of selected(o)) {
    const before = await read(target.path)
    if (target.skills) {
      const root = join(dirname(target.path), 'skills')
      for (const skill of briefingSkills({ planLimitsAvailable: o.planLimitsAvailable ?? o.toolNames?.includes('agentistics_plan_limits') })) {
        const path = join(root, skill.name, 'SKILL.md')
        const desired = skillMarkdown(skill)
        const prior = await read(path)
        if (prior !== null && !prior.includes(MANAGED_OPEN)) {
          // A file we did not write: never overwrite it.
          console.warn(`[briefing] skipped ${path}: exists and is not managed by agentistics`)
          out.push({ harness: target.harness, path, changed: false, skipped: true })
          continue
        }
        // Owned file: replace only the managed block (and our version stamp), keep user text around it.
        const next = prior === null ? desired : replaceManagedBlock(prior, managedBlock(skill)).replace(/(agentistics-version: )"\d+"/, `$1"${BRIEFING_VERSION}"`)
        if (prior !== next) { await mkdir(dirname(path), { recursive: true, mode: 0o700 }); await writeFile(path, next, { mode: 0o600 }) }
        out.push({ harness: target.harness, path, changed: prior !== next })
      }
      continue
    }
    let content = before ?? ''
    for (const skill of briefingSkills({ planLimitsAvailable: o.planLimitsAvailable ?? o.toolNames?.includes('agentistics_plan_limits') })) content = replaceManagedBlock(content, managedBlock(skill))
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
        if (content?.includes(MANAGED_OPEN)) {
          const after = removeManagedBlocks(content)
          // Only our generated frontmatter left → nothing of the user's remains: delete the file.
          const bare = after.replace(/^---\nname: [^\n]*\ndescription: [^\n]*\nmetadata:\n  agentistics-version: "\d+"\n---\n?/, '').trim() === ''
          if (bare) { await rm(path); out.push({ harness: target.harness, path, changed: true, removed: true }) }
          else { await writeFile(path, after, { mode: 0o600 }); out.push({ harness: target.harness, path, changed: true }) }
        }
        await pruneEmpty(dirname(path))
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

export type AutoInstallOptions = {
  home?: string
  dataDir?: string
  env?: NodeJS.ProcessEnv
  harnesses?: readonly HarnessId[]
  toolNames?: readonly string[]
  readSettings?: () => Promise<{ briefingAutoInstall?: boolean }>
}

async function readState(path: string): Promise<BriefingState | null> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as Partial<BriefingState>
    return typeof value.version === 'number' ? { version: value.version } : null
  } catch { return null }
}

/** Install managed briefing content once per product briefing version, without touching user text. */
export async function ensureBriefingInstalled(o: AutoInstallOptions = {}): Promise<InstallResult | null> {
  const env = o.env ?? process.env
  if (env.AGENTISTICS_BRIEFING === '0' || env.AGENTISTICS_BRIEFING_AUTO_INSTALL === '0') return null
  const settings = await (o.readSettings ?? readPreferences)()
  if (settings.briefingAutoInstall === false) return null
  const dataDir = o.dataDir ?? AGENTISTICS_DATA_DIR
  const statePath = join(dataDir, 'briefing-state.json')
  const state = await readState(statePath)
  if (state?.version === BRIEFING_VERSION) return []
  const result = await installBriefing({
    home: o.home ?? HOME_DIR,
    harnesses: o.harnesses ?? (() => {
      const available = availableHarnesses()
      return available.blind ? [] : available.ids
    })(),
    toolNames: o.toolNames,
  })
  await mkdir(dataDir, { recursive: true, mode: 0o700 })
  await writeFile(statePath, JSON.stringify({ version: BRIEFING_VERSION }) + '\n', { mode: 0o600 })
  return result
}
