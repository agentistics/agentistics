/** Local dashboard patches only. A central's data requires per-viewer scoping and keeps its GET. */
import { randomUUID } from 'node:crypto'
import { planDataPatch } from '@agentistics/core'
import { versionOf } from './data-response-cache'
const boot = randomUUID()
let held: { revision: string; data: Record<string, unknown> } | null = null
export function dataRevision(build: object): string { return `${boot}:${versionOf(build)}` }
export function rememberDataBuild(build: object): void {
  if (!held) held = { revision: dataRevision(build), data: JSON.parse(JSON.stringify(build)) }
}
export function patchDataBuild(build: object): ReturnType<typeof planDataPatch> | null {
  const revision = dataRevision(build)
  const data = JSON.parse(JSON.stringify(build)) as Record<string, unknown>
  const previous = held
  held = { revision, data }
  if (!previous || previous.revision === revision) return null
  return planDataPatch(previous.data, data, previous.revision, revision)
}
