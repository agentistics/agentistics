#!/usr/bin/env bun
/**
 * Generate EVERY raster/icon asset of the brand from the four source SVGs in
 * `packages/web/branding/`. Dev-only tool, NOT part of the build: the outputs are committed.
 * Re-run it when the artwork changes and nothing else needs touching by hand.
 *
 *     bun packages/web/scripts/gen-brand-assets.ts
 *
 * Sources (the only files edited by a person):
 *   logo-dark.svg                 the plate, dark  -> app icons on every platform
 *   logo-light.svg                the plate, light -> README / light-theme exports
 *   logo-no-background.svg        the bare glyph  -> favicon, in-app mark, mask
 *   logo-no-background-vscode.svg the bare glyph for the VS Code activity bar (tinted by VS Code)
 *
 * Rendered with Chromium (Playwright), not ImageMagick: the plate carries an SVG inner-shadow
 * filter that ImageMagick's own renderer silently drops.
 *
 * The central variant is the same artwork with the accent swapped for teal — a colour swap on
 * the vector, not a hue-rotate of pixels, so it is exact at every size.
 */
import { chromium } from 'playwright'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..', '..')
const WEB = join(ROOT, 'packages/web')
const SRC = join(WEB, 'branding')
const PUBLIC = join(WEB, 'public')
const ICONS = join(PUBLIC, 'icons')
const DESKTOP = join(ROOT, 'packages/desktop/icons')
const VSCODE = join(ROOT, 'packages/vscode/media')
const EXPORTS = join(SRC, 'exports')

const AMBER = '#FD8924'
const TEAL = '#06B6D4' // central-branding.ts CENTRAL_THEME_COLOR
const PLATE_DARK = '#191C24'

const read = (f: string) => readFileSync(join(SRC, f), 'utf8')
const inner = (svg: string) => svg.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '')
const teal = (svg: string) => svg.split(AMBER).join(TEAL)

const DARK = read('logo-dark.svg')
const LIGHT = read('logo-light.svg')
const GLYPH = read('logo-no-background.svg')
/** The owner's own export of the light logo, when present. It is the final art (the SVG renders
 *  a hairline seam on the left wing and a harder shadow), so where it exists it is used as-is and
 *  only scaled. The teal central variant still comes from the SVG: a raster cannot be recoloured
 *  without touching pixels. */
const LIGHT_PNG = existsSync(join(SRC, 'logo-light.png'))
  ? `data:image/png;base64,${readFileSync(join(SRC, 'logo-light.png')).toString('base64')}`
  : null
const VSC = read('logo-no-background-vscode.svg')

/** The glyph without its plate, in the plate's 85-unit space (filters/defs dropped). */
const glyphOf85 = (svg: string) => (inner(svg).match(/<path[\s\S]*?\/>/g) ?? []).join('\n')
const GLYPH85 = glyphOf85(DARK)
// Centre of the glyph's bounding box inside the 85-unit plate (measured from the paths).
const GX = 42.5
const GY = 41.4

const wrap = (viewBox: string, body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="${viewBox}" width="100%" height="100%">${body}</svg>`

/** The rounded plate as designed (transparent corners) — the "any" purpose icon. */
/** The plate EXACTLY as designed: the whole 85-unit canvas, its own margin, border and shadow
 *  intact. Used wherever the logo is shown as a picture (footer, PDF, README, exports). The
 *  cropped `plate` below trims that margin for app icons, which must fill their square, and in
 *  doing so clips the border and the shadow — fine for an icon, wrong for the logo itself. */
const plateFull = (svg: string) => svg.replace(/<svg[^>]*>/, m => m.replace(/width="\d+" height="\d+"/, 'width="100%" height="100%"'))

/** The supplied PNG as a picture, or the SVG rendering when there is none. */
const lightLogo = () => LIGHT_PNG
  ? `<img src="${LIGHT_PNG}" style="display:block;width:100%;height:100%" alt="">`
  : plateFull(LIGHT)

const plate = (svg: string) => svg.replace(/<svg[^>]*>/, m => m.replace(/width="\d+" height="\d+" viewBox="[^"]*"/, 'viewBox="1.5 1.5 82 82" width="100%" height="100%"'))

/** Full-bleed square (no rounded corners, no transparency): the OS applies its own mask. */
const bleed = (fg: string, scale: number, bg = PLATE_DARK) =>
  wrap('0 0 85 85',
    `<rect width="85" height="85" fill="${bg}"/>` +
    `<g transform="translate(42.5 42.5) scale(${scale}) translate(${-GX} ${-GY})">${fg}</g>`)

/** Glyph alone on transparency, centred on the plate's coordinates. */
const floating = (fg: string, scale: number) =>
  wrap('0 0 85 85', `<g transform="translate(42.5 42.5) scale(${scale}) translate(${-GX} ${-GY})">${fg}</g>`)

const circle = (svg: string) =>
  svg.replace(/(<svg[^>]*>)/, '$1<defs><clipPath id="c"><circle cx="42.5" cy="42.5" r="42.5"/></clipPath></defs><g clip-path="url(#c)">').replace(/<\/svg>$/, '</g></svg>')

const bare = (svg: string) => svg.replace(/<svg[^>]*>/, '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="1 1 54 54" width="100%" height="100%">')

// THE LOGO'S GEOMETRY IS NEVER TOUCHED. The SVGs are the design: stroke widths, shapes and
// proportions between the parts are the owner's, and a script may only change SCALE (how big the
// drawing sits in its canvas) and COLOUR (the teal central set). Thickening a stroke "for
// legibility" was tried once and rejected outright: it is a different drawing.
//
// The Windows taskbar draws an icon at ~26 px on a dark bar, where a dark plate vanishes into it.
// So the icons Windows shows there are the BARE glyph (no plate), scaled up to fill the canvas.
// Everything else keeps the plate.
const BOLD_SCALE = 1.45
const boldGlyph = () => floating(GLYPH85, BOLD_SCALE)

const MASKABLE_SCALE = 0.85 // glyph radius must stay inside the 80% safe circle
const BLEED_SCALE = 1.0
const ANDROID_FG_SCALE = 0.7 // 108dp canvas, 66dp safe circle

// ---------------------------------------------------------------------------------------------

const browser = await chromium.launch()
const ctx = await browser.newContext({ deviceScaleFactor: 1 })
const page = await ctx.newPage()

/** Every render shares ONE page, so they must run one at a time — never inside Promise.all. */
async function each<T, R>(xs: readonly T[], fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = []
  for (const x of xs) out.push(await fn(x))
  return out
}

async function png(svg: string, w: number, h = w): Promise<Buffer> {
  await page.setViewportSize({ width: w, height: h })
  await page.setContent(`<!doctype html><html><body style="margin:0;background:transparent;width:${w}px;height:${h}px">${svg}</body></html>`)
  return await page.screenshot({ omitBackground: true, type: 'png' }) as Buffer
}

const written: string[] = []
function put(path: string, data: Buffer | string) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, data)
  written.push(path.replace(ROOT + '/', ''))
}

function ico(images: { size: number; data: Buffer }[]): Buffer {
  const head = Buffer.alloc(6)
  head.writeUInt16LE(1, 2)
  head.writeUInt16LE(images.length, 4)
  let offset = 6 + 16 * images.length
  const dirs = images.map(({ size, data }) => {
    const d = Buffer.alloc(16)
    d[0] = size >= 256 ? 0 : size
    d[1] = size >= 256 ? 0 : size
    d.writeUInt16LE(1, 4)
    d.writeUInt16LE(32, 6)
    d.writeUInt32LE(data.length, 8)
    d.writeUInt32LE(offset, 12)
    offset += data.length
    return d
  })
  return Buffer.concat([head, ...dirs, ...images.map(i => i.data)])
}

function icns(entries: [string, Buffer][]): Buffer {
  const chunks = entries.map(([type, data]) => {
    const h = Buffer.alloc(8)
    h.write(type, 0, 'ascii')
    h.writeUInt32BE(8 + data.length, 4)
    return Buffer.concat([h, data])
  })
  const body = Buffer.concat(chunks)
  const h = Buffer.alloc(8)
  h.write('icns', 0, 'ascii')
  h.writeUInt32BE(8 + body.length, 4)
  return Buffer.concat([h, body])
}

for (const central of [false, true]) {
  const c = central ? teal : (s: string) => s
  const tag = central ? '-central' : ''

  // ---- Web / PWA -------------------------------------------------------------------------
  for (const s of [192, 512]) {
    put(join(ICONS, `icon${tag}-${s}.png`), await png(c(boldGlyph()), s)) // 'any': what Windows draws on the taskbar
    put(join(ICONS, `icon${tag}-${s}-maskable.png`), await png(c(bleed(c(GLYPH85), MASKABLE_SCALE)), s))
  }
  // iOS home screen: opaque, square, the OS rounds it.
  put(join(PUBLIC, `apple-touch-icon${tag}.png`), await png(c(bleed(c(GLYPH85), BLEED_SCALE)), 180))

  // Browser tab: the bare glyph reads on light and dark tab strips, a dark plate does not.
  const fav = await each([16, 32, 48, 64], async size => ({ size, data: await png(c(bare(GLYPH)), size) }))
  put(join(PUBLIC, `favicon${tag}.ico`), ico(fav))
}

// ---- In-app mark (sidebar) and Studio mask ---------------------------------------------------
put(join(PUBLIC, 'minimalistLogo.png'), await png(bare(GLYPH), 512))
put(join(PUBLIC, 'markMask.png'), await png(bare(GLYPH), 512))

// ---- Logos that follow the place they are drawn in -------------------------------------------
// The plate carries its own background, so it reads on any surface; the light one exists for the
// places that are themselves light (light theme, PDF on white paper, README on GitHub light).
put(join(PUBLIC, 'logo.png'), await png(plateFull(DARK), 512))
put(join(PUBLIC, 'logo-light.png'), await png(lightLogo(), 512))
// The central's in-app marks: the same drawings in teal, picked at runtime by `brandAsset()`
// (web/src/lib/brand.ts) — a central and a machine serve one bundle, so the choice cannot be made
// at build time. Without these the central's sidebar, footer and login kept the amber mark while
// its favicon and installed icon were already teal.
put(join(PUBLIC, 'minimalistLogo-central.png'), await png(teal(bare(GLYPH)), 512))
put(join(PUBLIC, 'logo-central.png'), await png(teal(plateFull(DARK)), 512))
put(join(PUBLIC, 'logo-light-central.png'), await png(teal(plateFull(LIGHT)), 512))
put(join(ROOT, 'packages/desktop/ui/logo.png'), await png(bare(GLYPH), 256)) // dark window, bare glyph

// ---- Exports for docs / README / store listings ----------------------------------------------
for (const s of [1024, 512, 256]) {
  put(join(EXPORTS, `logo-dark-${s}.png`), await png(plateFull(DARK), s))
  put(join(EXPORTS, `logo-light-${s}.png`), await png(lightLogo(), s))
  put(join(EXPORTS, `logo-mark-${s}.png`), await png(bare(GLYPH), s))
  put(join(EXPORTS, `logo-mark-teal-${s}.png`), await png(teal(bare(GLYPH)), s))
}
const inter = readFileSync(join(PUBLIC, 'fonts/inter-700.woff2')).toString('base64')
const social = (w: number, h: number) => `
<style>@font-face{font-family:I;font-weight:700;src:url(data:font/woff2;base64,${inter})}
body{margin:0}.c{width:${w}px;height:${h}px;background:radial-gradient(120% 140% at 15% 20%,#23273a 0%,${PLATE_DARK} 60%);display:flex;align-items:center;justify-content:center;gap:${h * 0.07}px;font-family:I,sans-serif;color:#ECECEC}
.t{font-size:${h * 0.15}px;letter-spacing:-.02em;line-height:1}.s{font-size:${h * 0.05}px;font-weight:700;color:#9aa0ae;margin-top:${h * 0.03}px;letter-spacing:0}
.l{width:${h * 0.42}px;height:${h * 0.42}px}</style>
<div class="c"><div class="l">${plate(DARK)}</div><div><div class="t">agentistics</div><div class="s">Analytics for your AI coding assistants</div></div></div>`
put(join(EXPORTS, 'social-preview-1280x640.png'), await png(social(1280, 640), 1280, 640))
put(join(EXPORTS, 'og-image-1200x630.png'), await png(social(1200, 630), 1200, 630))

// ---- Tauri (desktop: Windows / macOS / Linux) ---------------------------------------------------
const appPlate = (s: number) => png(plate(DARK), s)
const winIcon = (s: number) => png(boldGlyph(), s) // Windows-only surfaces: taskbar, Start, Store
const tauriSquare = (s: number) => png(bleed(GLYPH85, BLEED_SCALE), s)
for (const [name, s] of [['32x32', 32], ['64x64', 64], ['128x128', 128], ['128x128@2x', 256], ['icon', 512]] as const) {
  put(join(DESKTOP, `${name}.png`), await appPlate(s))
}
for (const s of [30, 44, 71, 89, 107, 142, 150, 284, 310]) put(join(DESKTOP, `Square${s}x${s}Logo.png`), await winIcon(s))
put(join(DESKTOP, 'StoreLogo.png'), await winIcon(50))
put(join(DESKTOP, 'icon.ico'), ico(await each([16, 24, 32, 48, 64, 128, 256], async size => ({ size, data: await winIcon(size) }))))
put(join(DESKTOP, 'icon.icns'), icns(await each(
  ([['icp4', 16], ['icp5', 32], ['icp6', 64], ['ic07', 128], ['ic08', 256], ['ic09', 512], ['ic10', 1024]] as const),
  async ([t, s]) => [t, await appPlate(s)] as [string, Buffer])))

// Windows installer (NSIS) artwork: 24-bit BMP, the only format the bundler accepts. Chromium has
// no BMP encoder, so the PNG is converted with ImageMagick (`convert`), the one place it is needed.
const bmp = (name: string, data: Buffer) => {
  const tmp = join(EXPORTS, `.${name}.png`)
  writeFileSync(tmp, data)
  const out = join(DESKTOP, name)
  const r = Bun.spawnSync(['convert', tmp, '-background', 'white', '-alpha', 'remove', '-alpha', 'off', `BMP3:${out}`])
  if (r.exitCode !== 0) throw new Error(`convert failed for ${name}: ${r.stderr.toString()}`)
  rmSync(tmp)
  written.push(out.replace(ROOT + '/', ''))
}
const nsisSidebar = `<style>@font-face{font-family:I;font-weight:700;src:url(data:font/woff2;base64,${inter})}body{margin:0}
.c{width:164px;height:314px;background:linear-gradient(180deg,#23273a 0%,${PLATE_DARK} 55%);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;font-family:I,sans-serif;color:#ECECEC}
.l{width:96px;height:96px}.t{font-size:17px;letter-spacing:-.01em}</style><div class="c"><div class="l">${plate(DARK)}</div><div class="t">agentistics</div></div>`
bmp('nsis-sidebar.bmp', await png(nsisSidebar, 164, 314))
bmp('nsis-header.bmp', await png(`<div style="width:150px;height:57px;background:#fff;display:flex;align-items:center;justify-content:center"><div style="width:47px;height:47px">${plate(DARK)}</div></div>`, 150, 57))

// iOS: every AppIcon-<w>x<w>@<n>x.png already in the folder keeps its name and gets its pixel size.
for (const f of readdirSync(join(DESKTOP, 'ios'))) {
  const m = f.match(/^AppIcon-(\d+(?:\.\d+)?)x\1@(\d)x/)
  const px = m ? Math.round(parseFloat(m[1]!) * parseInt(m[2]!)) : f.startsWith('AppIcon-512@2x') ? 1024 : 0
  if (px) put(join(DESKTOP, 'ios', f), await tauriSquare(px))
}
// Android: launcher (legacy), round, and the adaptive foreground (glyph only, safe-zone sized).
const DENSITY: Record<string, number> = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 }
for (const [d, k] of Object.entries(DENSITY)) {
  const dir = join(DESKTOP, 'android', `mipmap-${d}`)
  put(join(dir, 'ic_launcher.png'), await png(bleed(GLYPH85, BLEED_SCALE), 48 * k))
  put(join(dir, 'ic_launcher_round.png'), await png(circle(bleed(GLYPH85, BLEED_SCALE)), 48 * k))
  put(join(dir, 'ic_launcher_foreground.png'), await png(floating(GLYPH85, ANDROID_FG_SCALE), 108 * k))
}
put(join(DESKTOP, 'android/values/ic_launcher_background.xml'),
  `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n  <color name="ic_launcher_background">${PLATE_DARK}</color>\n</resources>\n`)

// ---- VS Code -------------------------------------------------------------------------------
put(join(VSCODE, 'icon.png'), await png(plate(DARK), 256))
put(join(VSCODE, 'icon.svg'),
  `<!--\n  The agentistics mark, generated from branding/logo-no-background-vscode.svg by\n  packages/web/scripts/gen-brand-assets.ts. Only change: currentColor instead of the fixed\n  fill, because VS Code tints an activity-bar icon itself (dim when inactive, foreground when\n  active) and a hardcoded colour reads as a broken icon.\n-->\n` +
  VSC.replace(/#6672A5/g, 'currentColor'))

await browser.close()
console.log(`wrote ${written.length} files`)
for (const w of written) console.log('  ' + w)
