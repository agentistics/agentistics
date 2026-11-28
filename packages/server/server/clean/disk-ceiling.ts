/**
 * disk-ceiling.ts — PURE. Is the volume holding the worktrees nearly full, and what is said about it
 * (DISCO.WORKTREES). Nothing here removes anything; the notice offers the cleanup and says how much it
 * would free.
 */
import { fmtBytes } from './clean-plan'

const GiB = 1024 ** 3
export const DEFAULT_CEILING = { freePct: 15, freeGB: 30 }
export const NOTICE_EVERY_MS = 86_400_000
/** A recovery counts only a tenth above the line, or free space hovering at it would re-notify. */
const RECOVERY_MARGIN = 1.1

export interface DiskCeiling { freePct: number; freeGB: number }
export interface DiskVolume { path: string; freeBytes: number; totalBytes: number }

export function resolveCeiling(raw: Partial<DiskCeiling> | undefined): DiskCeiling {
  const ok = (v: unknown, max: number): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max
  return {
    freePct: ok(raw?.freePct, 100) ? raw.freePct : DEFAULT_CEILING.freePct,
    freeGB: ok(raw?.freeGB, 1_000_000) ? raw.freeGB : DEFAULT_CEILING.freeGB,
  }
}

/** The floor is whichever of the two is LARGER. */
export function ceilingBytes(totalBytes: number, cfg: DiskCeiling): number {
  return Math.max(totalBytes * cfg.freePct / 100, cfg.freeGB * GiB)
}

export function evaluateDiskCeiling(i: { freeBytes: number; totalBytes: number; cfg: DiskCeiling; lastNoticeMs: number | null; nowMs: number }): { low: boolean; notify: boolean; lastNoticeMs: number | null } {
  const floor = ceilingBytes(i.totalBytes, i.cfg)
  if (i.freeBytes < floor) {
    const notify = i.lastNoticeMs === null || i.nowMs - i.lastNoticeMs >= NOTICE_EVERY_MS
    return { low: true, notify, lastNoticeMs: notify ? i.nowMs : i.lastNoticeMs }
  }
  return { low: false, notify: false, lastNoticeMs: i.freeBytes >= floor * RECOVERY_MARGIN ? null : i.lastNoticeMs }
}

export function isWsl(procVersion: string, env: Record<string, string | undefined>): boolean {
  return /microsoft/i.test(procVersion) || !!env.WSL_DISTRO_NAME
}

export function wslNote(lang: 'en' | 'pt'): string {
  return lang === 'pt'
    ? 'No WSL, o espaço liberado só volta para o Windows com o VHD esparso ligado (no Windows: wsl --manage <distro> --set-sparse true) ou depois de compactar o disco virtual.'
    : 'On WSL, freed space only returns to Windows with sparse VHD turned on (on Windows: wsl --manage <distro> --set-sparse true) or after compacting the virtual disk.'
}

/** What a LEADER session is told. The person's notification has its own wording in the web app. */
export function diskNoticeText(i: { lang: 'en' | 'pt'; freeBytes: number; thresholdBytes: number; freeableBytes: number; count: number; wsl: boolean }): string {
  const free = fmtBytes(i.freeBytes), floor = fmtBytes(i.thresholdBytes), can = fmtBytes(i.freeableBytes)
  const head = i.lang === 'pt'
    ? `Pouco espaço em disco: ${free} livres no volume das worktrees (limite ${floor}). A limpeza segura do agentistics liberaria ${can} (${i.count} item(ns)). Nada é removido sozinho: ofereça a limpeza à pessoa (ferramenta MCP agentistics_clean, ou o diálogo "Limpeza" no painel) e só aplique com o aval dela.`
    : `Low disk space: ${free} free on the volume holding the worktrees (floor ${floor}). The safe agentistics cleanup would free ${can} (${i.count} item(s)). Nothing is removed on its own: offer the cleanup to the person (the agentistics_clean MCP tool, or the Cleanup dialog in the dashboard) and apply it only with their go-ahead.`
  return i.wsl ? `${head}\n${wslNote(i.lang)}` : head
}
