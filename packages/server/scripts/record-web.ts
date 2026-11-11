/**
 * record-web.ts — record the web UI as GIFs.
 *
 * Playwright records each flow to webm; ffmpeg turns it into a GIF through a
 * generated palette (a straight webm→gif is dithered mud). Everything is driven
 * against the DEMO fleet built by seed-demo.ts, never a real machine — these
 * files get published, and a real project name in one cannot be taken back.
 *
 * Prerequisites:
 *   bun run packages/server/scripts/seed-demo.ts --force
 *   HOME=~/.agentistics-demo-home-1 PORT=47391 ./release/agentop server &
 *
 * Usage:
 *   bun run packages/server/scripts/record-web.ts [--only <name>]
 *
 * Env: MACHINE_URL (http://localhost:47392), OUT_DIR (./casts).
 */

import { chromium, type Page, type Browser, type BrowserContext } from 'playwright'
import { mkdir, readdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const MACHINE_URL = process.env.MACHINE_URL ?? 'http://localhost:47392'
const OUT_DIR = process.env.OUT_DIR ?? join(import.meta.dirname, '..', '..', '..', 'casts')

const DESKTOP = { width: 1440, height: 900 }
const MOBILE = { width: 390, height: 844 }

const onlyFlag = process.argv.indexOf('--only')
const ONLY = onlyFlag >= 0 ? process.argv[onlyFlag + 1] : null

/* ------------------------------------------------------------------- helpers */

const wait = (ms: number) => new Promise(r => setTimeout(r, ms))

/** The dashboard's first load scans every harness dir and can take tens of
 *  seconds on real history; `networkidle` never fires because the SPA holds an
 *  SSE connection open, so the loading copy is the only honest signal. */
async function ready(page: Page, timeout = 90_000): Promise<void> {
  await page.waitForFunction(
    () => !document.body.innerText.includes('Loading your data')
       && !document.body.innerText.includes('Carregando'),
    undefined, { timeout },
  ).catch(() => {})
  await wait(1200)
}

/** Scroll in steps rather than jumping: a GIF of an instant jump reads as a cut,
 *  and the reveal-on-scroll animations never get a chance to play.
 *
 *  Use it sparingly. In a GIF every pixel of a scrolling frame changes, so the
 *  inter-frame compression has nothing to work with and a few seconds of gliding
 *  costs megabytes — see `hop`, which is what the long pages use. */
async function glide(page: Page, distance: number, steps = 18): Promise<void> {
  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel(0, distance / steps)
    await wait(90)
  }
  await wait(600)
}

/** Jump to a position and HOLD there. Reads as a cut between two shots, which is
 *  how a tour is normally edited anyway, and costs one changed frame instead of
 *  a hundred — the difference between a 300kB GIF and an 8MB one. */
async function hop(page: Page, y: number, hold = 2200): Promise<void> {
  await page.evaluate(top => window.scrollTo({ top, behavior: 'instant' as ScrollBehavior }), y)
  await wait(hold)
}

async function click(page: Page, selector: string, pause = 1100): Promise<boolean> {
  const el = page.locator(selector).first()
  if (!(await el.count())) return false
  await el.scrollIntoViewIfNeeded().catch(() => {})
  await el.click({ timeout: 5_000 }).catch(() => {})
  await wait(pause)
  return true
}

async function clickText(page: Page, text: string, pause = 1100): Promise<boolean> {
  const el = page.getByText(text, { exact: false }).first()
  if (!(await el.count())) return false
  await el.scrollIntoViewIfNeeded().catch(() => {})
  await el.click({ timeout: 5_000 }).catch(() => {})
  await wait(pause)
  return true
}

/* --------------------------------------------------------------------- video */

/** One flow = one context, because Playwright finalizes a video only when its
 *  context closes. The file lands under a random name, so it is renamed after. */
async function record(
  browser: Browser,
  name: string,
  viewport: { width: number; height: number },
  drive: (page: Page, context: BrowserContext) => Promise<void>,
): Promise<void> {
  if (ONLY && ONLY !== name) return
  const dir = join(OUT_DIR, `.video-${name}`)
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })

  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: 1,
    recordVideo: { dir, size: viewport },
    colorScheme: 'dark',
  })
  // The first-run "install the app" modal dims the whole page behind it, so a
  // recording that meets it is a recording of a dimmed dashboard. It is keyed on
  // localStorage, which a fresh context always starts empty — set it up front
  // rather than trying to click the modal away after it has already appeared.
  await context.addInitScript(() => {
    try { localStorage.setItem('agentistics-install-dismissed', 'true') } catch { /* ignore */ }
  })
  const page = await context.newPage()
  try {
    await drive(page, context)
  } catch (err) {
    console.warn(`  ${name}: ${String(err).slice(0, 160)}`)
  }
  await context.close()

  const files = (await readdir(dir)).filter(f => f.endsWith('.webm'))
  if (!files.length) { console.warn(`  ${name}: no video produced`); return }
  const webm = join(OUT_DIR, `${name}.webm`)
  await rename(join(dir, files[0]!), webm)
  await rm(dir, { recursive: true, force: true })

  toGif(webm, join(OUT_DIR, `${name}.gif`), viewport.width, SKIP_SECONDS[name] ?? 0)
  console.log(`  ${name}.gif`)
}

/** Seconds to drop from the FRONT of a clip, for a flow whose opening is setup
 *  rather than content. Trimming guesses at a duration that changes
 *  with the machine. */
const SKIP_SECONDS: Record<string, number> = {}

/** Two passes: one to compute a palette from the whole clip, one to apply it.
 *  A single-pass gif quantizes per frame and the UI's flat panels band badly.
 *
 *  The knobs are all there to keep a README GIF in the low hundreds of kB: a
 *  multi-megabyte GIF is one a reader watches load, not one they watch. The
 *  dashboard is mostly flat panels on a dark background, so 128 colours is
 *  indistinguishable here, and a coarse ordered dither compresses far better
 *  than a fine one because neighbouring frames stay identical. */
function toGif(webm: string, gif: string, sourceWidth: number, skipSeconds = 0): void {
  const width = sourceWidth > 900 ? 900 : sourceWidth
  const filters = `fps=10,scale=${width}:-1:flags=lanczos`
  const palette = `${gif}.png`
  // `-ss` before `-i` seeks, so the skipped part costs nothing to decode.
  const seek = skipSeconds > 0 ? ['-ss', String(skipSeconds)] : []
  const limit = ['-t', '20'] // no single loop runs longer than 20s
  spawnSync('ffmpeg', ['-y', '-loglevel', 'error', ...seek, ...limit, '-i', webm,
    '-vf', `${filters},palettegen=max_colors=128:stats_mode=diff`, palette])
  spawnSync('ffmpeg', ['-y', '-loglevel', 'error', ...seek, ...limit, '-i', webm, '-i', palette,
    '-lavfi', `${filters}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`, gif])
  spawnSync('rm', ['-f', palette])
}

/* ---------------------------------------------------------------- the flows */

async function run(): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true })
  const browser = await chromium.launch()

  // --- machine ---------------------------------------------------------

  await record(browser, 'machine-dashboard', DESKTOP, async page => {
    await page.goto(MACHINE_URL, { waitUntil: 'load' })
    await ready(page)
    await wait(2400)          // the KPI row
    await hop(page, 700)      // charts
    await hop(page, 1500)     // heatmap + hourly usage
    await hop(page, 2400)     // highlights and recent sessions
    await hop(page, 0, 1600)
  })

  await record(browser, 'machine-compare', DESKTOP, async page => {
    await page.goto(`${MACHINE_URL}/compare`, { waitUntil: 'load' })
    await ready(page)
    await wait(2400)
    await hop(page, 800)
    await hop(page, 1600)
  })

  await record(browser, 'machine-repositories', DESKTOP, async page => {
    await page.goto(`${MACHINE_URL}/repositories`, { waitUntil: 'load' })
    await ready(page)
    await hop(page, 500)
    await clickText(page, 'atlas-api', 2000)
    await wait(1200)
    for (const tab of ['Members', 'Sessions', 'Overview']) await clickText(page, tab, 1600)
  })

  await record(browser, 'machine-tags', DESKTOP, async page => {
    await page.goto(`${MACHINE_URL}/tags`, { waitUntil: 'load' })
    await ready(page)
    await hop(page, 450)
    await wait(1600)
  })

  await record(browser, 'machine-custom', DESKTOP, async page => {
    await page.goto(`${MACHINE_URL}/custom`, { waitUntil: 'load' })
    await ready(page)
    await clickText(page, 'Edit', 1600)
    await hop(page, 600)
    await wait(1800)
  })

  await record(browser, 'machine-mobile', MOBILE, async page => {
    await page.goto(MACHINE_URL, { waitUntil: 'load' })
    await ready(page)
    await hop(page, 600)
    await hop(page, 1200)
    await click(page, 'button:has-text("More"), button[aria-label="More"]', 1600)
    await wait(1400)
  })

  await browser.close()
  console.log(`\ngifs in ${OUT_DIR}`)
}

await run()
