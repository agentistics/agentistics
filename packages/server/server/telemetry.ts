import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import type { SessionMeta } from '@agentistics/core'
import { AGENTISTICS_DATA_DIR, TEAM_CENTRAL } from './config'
import { CURRENT_VERSION } from './version'

export const TELEMETRY_URL = process.env.AGENTISTICS_TELEMETRY_URL ?? 'https://telemetry.agentistics.com.br/v1/ping'
export const TELEMETRY_STATE_FILE = join(AGENTISTICS_DATA_DIR, 'telemetry.json')
export const TELEMETRY_TEXT = 'Enviar um sinal anônimo de uso (um número aleatório, a versão e o sistema) uma vez por dia, para sabermos quantas pessoas usam o Agentistics. Nada do seu trabalho é enviado.'
export interface TelemetryState { id: string; lastSentDay?: string }
export interface TelemetryPayload { id: string; version: string; os: 'linux' | 'darwin' | 'win32'; arch: string; harnesses: string[]; mode: 'solo' | 'central' }
export function utcDay(now = new Date()): string { return now.toISOString().slice(0, 10) }
export function shouldSendToday(lastSentDay: string | undefined, day: string): boolean { return lastSentDay !== day }
export interface TelemetryDecisionInput {
  isCompiled: boolean
  env: NodeJS.ProcessEnv
  dataDir: string
  tmpDir: string
}
function isUnder(dataDir: string, tmpDir: string): boolean {
  const normalise = (value: string) => value.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase()
  const data = normalise(dataDir)
  const tmp = normalise(tmpDir)
  return data === tmp || data.startsWith(`${tmp}/`)
}
export function shouldSendTelemetry(input: TelemetryDecisionInput): boolean {
  if (!input.isCompiled) return false
  if (input.env.AGENTISTICS_TELEMETRY === '0' || input.env.DO_NOT_TRACK === '1' || input.env.CI !== undefined
    || input.env.NODE_ENV === 'test' || input.env.AGENTISTICS_THROWAWAY === '1') return false
  return !isUnder(input.dataDir, input.tmpDir)
}
export function makePayload(input: Omit<TelemetryPayload, 'harnesses'> & { harnesses: readonly string[] }): TelemetryPayload {
  return { id: input.id, version: input.version, os: input.os, arch: input.arch, harnesses: [...new Set(input.harnesses)].sort(), mode: input.mode }
}
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000
function activityTimes(session: SessionMeta): number[] {
  const times = [
    ...(session.daily ? Object.keys(session.daily).map(day => Date.parse(`${day}T23:59:59.999Z`)) : []),
    ...(session.user_message_timestamps ?? []).map(timestamp => typeof timestamp === 'number' ? timestamp : Date.parse(timestamp)),
    session.end_time ? Date.parse(session.end_time) : NaN,
    session.start_time ? Date.parse(session.start_time) : NaN,
  ]
  return times.filter(Number.isFinite)
}
export function activeHarnesses(sessions: readonly SessionMeta[], now: number): string[] {
  const cutoff = now - SEVEN_DAYS_MS
  const active = new Set<string>()
  for (const session of sessions) {
    if (activityTimes(session).some(time => time >= cutoff)) active.add(session.harness ?? 'claude')
  }
  return [...active].sort()
}
async function readState(path: string): Promise<TelemetryState | null> { try { const p = JSON.parse(await readFile(path, 'utf8')) as Partial<TelemetryState>; return typeof p.id === 'string' ? { id: p.id, lastSentDay: typeof p.lastSentDay === 'string' ? p.lastSentDay : undefined } : null } catch { return null } }
async function saveState(path: string, state: TelemetryState): Promise<void> { await mkdir(join(path, '..'), { recursive: true }); const tmp = `${path}.tmp-${process.pid}`; await writeFile(tmp, JSON.stringify(state), { mode: 0o600 }); await rename(tmp, path) }
export async function ensureTelemetryId(path = TELEMETRY_STATE_FILE): Promise<TelemetryState> { const old = await readState(path); if (old) return old; const state = { id: crypto.randomUUID() }; await saveState(path, state); return state }
function runningCompiledBinary(): boolean {
  return /^\/\$bunfs\//.test(Bun.main) || /^B:\/~BUN\//i.test(Bun.main)
}
export async function sendTelemetry(options: { enabled?: boolean; env?: NodeJS.ProcessEnv; statePath?: string; dataDir?: string; tmpDir?: string; isCompiled?: boolean; now?: Date; sessions?: readonly SessionMeta[]; loadSessions?: () => Promise<readonly SessionMeta[]>; fetchFn?: typeof fetch } = {}): Promise<boolean> {
  const env = options.env ?? process.env; if (env.AGENTISTICS_TELEMETRY === '0' || options.enabled === false) return false
  if (!shouldSendTelemetry({ isCompiled: options.isCompiled ?? runningCompiledBinary(), env, dataDir: options.dataDir ?? AGENTISTICS_DATA_DIR, tmpDir: options.tmpDir ?? tmpdir() })) return false
  const statePath = options.statePath ?? TELEMETRY_STATE_FILE; const now = options.now ?? new Date(); const day = utcDay(now); const state = await ensureTelemetryId(statePath); if (!shouldSendToday(state.lastSentDay, day)) return false
  const sessions = options.sessions ?? await options.loadSessions?.() ?? []
  const payload = makePayload({ id: state.id, version: CURRENT_VERSION, os: process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux', arch: process.arch, harnesses: activeHarnesses(sessions, now.getTime()), mode: TEAM_CENTRAL ? 'central' : 'solo' })
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 5000)
  try { const response = await (options.fetchFn ?? fetch)(env.AGENTISTICS_TELEMETRY_URL ?? TELEMETRY_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: controller.signal }); if (!response.ok) return false; await saveState(statePath, { ...state, lastSentDay: day }); return true } catch { return false } finally { clearTimeout(timer) }
}
