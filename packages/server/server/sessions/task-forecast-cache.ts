/** Forecast cache IO. Reads are shared; only the delivery background tick persists anchors. */
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { AGENTISTICS_DATA_DIR } from '../config'
import { FORECAST_METHOD_VERSION, type LiveDelivery } from './task-live'

const path = join(AGENTISTICS_DATA_DIR, 'forecast-anchors.json')
let loading: Promise<ReadonlyMap<string, number>> | null = null
let saving: Promise<void> = Promise.resolve()

export function readForecastAnchors(): Promise<ReadonlyMap<string, number>> {
  return loading ??= (async () => {
    try {
      const doc = JSON.parse(await readFile(path, 'utf8'))
      if (doc.methodVersion !== FORECAST_METHOD_VERSION || !doc.anchors || typeof doc.anchors !== 'object') return new Map<string, number>()
      return new Map<string, number>(Object.entries(doc.anchors)
        .filter((entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isFinite(entry[1]) && entry[1] > 0))
    } catch { return new Map<string, number>() }
  })()
}

/** PURE: serialize only bucket anchors, never forecasts or board mutations. */
export function forecastAnchorSnapshot(pieces: readonly LiveDelivery[]): Map<string, number> {
  const anchors = new Map<string, number>()
  for (const p of pieces) {
    const anchor = p.publishEta.kind === 'estimate' ? p.publishEta.overrunAnchorAtMs : undefined
    if (anchor !== undefined && Number.isFinite(anchor)) anchors.set(p.key, anchor)
  }
  return anchors
}

/** Called after a background tick. Never called from Live/Calendar GET. */
export function saveForecastAnchors(pieces: readonly LiveDelivery[]): Promise<void> {
  const next = forecastAnchorSnapshot(pieces)
  const save = async () => {
    const previous = await readForecastAnchors()
    if (previous.size === next.size && [...next].every(([k, v]) => previous.get(k) === v)) return
    await mkdir(dirname(path), { recursive: true })
    const tmp = `${path}.${process.pid}.tmp`
    await writeFile(tmp, JSON.stringify({ methodVersion: FORECAST_METHOD_VERSION, anchors: Object.fromEntries(next) }), { mode: 0o600 })
    await rename(tmp, path)
    loading = Promise.resolve(next)
  }
  const pending = saving.then(save, save)
  saving = pending.catch(() => {})
  return pending
}
