/**
 * The experimental glass switch: `data-glass="on" | "off"` on <html>, which every glass rule in
 * `index.css` keys on. Default ON (owner decision); the choice persists per DEVICE in localStorage,
 * on purpose — backdrop blur costs GPU time, so what a phone can afford is not what a desktop can.
 */
import { useSyncExternalStore } from 'react'

const KEY = 'agentistics-glass'
const listeners = new Set<() => void>()

/** Absent or unreadable storage reads as ON; only an explicit '0' turns it off. */
export function readGlass(): boolean {
  try { return localStorage.getItem(KEY) !== '0' } catch { return true }
}

export function applyGlass(on: boolean, root: HTMLElement = document.documentElement): void {
  root.dataset.glass = on ? 'on' : 'off'
}

export function setGlass(on: boolean): void {
  try { localStorage.setItem(KEY, on ? '1' : '0') } catch { /* private mode: it holds for this tab */ }
  applyGlass(on)
  listeners.forEach(l => l())
}

export function useGlass(): boolean {
  return useSyncExternalStore(
    cb => { listeners.add(cb); return () => { listeners.delete(cb) } },
    () => document.documentElement.dataset.glass !== 'off',
    () => true,
  )
}
