import { describe, expect, test } from 'bun:test'
import { browserBinSentence, kindOfPath, resolveBrowserBin, type BinLookup } from './browser-bin'

function lookup(files: string[], dirs: Record<string, string[]>, env: Record<string, string> = {}, platform: NodeJS.Platform = 'linux'): BinLookup {
  return { env: { PATH: '/usr/bin:/bin', ...env }, home: '/h', platform, executable: (p) => files.includes(p), list: (d) => dirs[d] ?? [] }
}
const CACHE = '/h/.cache/ms-playwright'

describe('browser-bin', () => {
  test('env wins and names its kind', () => {
    const b = resolveBrowserBin(lookup(['/opt/my-headless_shell', '/usr/bin/chromium'], {}, { AGENTISTICS_BROWSER_BIN: '/opt/my-headless_shell' }))
    expect(b).toEqual({ found: true, path: '/opt/my-headless_shell', kind: 'headless-shell', source: 'env' })
  })
  test('a named env binary that does not work is REPORTED, never silently replaced', () => {
    const b = resolveBrowserBin(lookup(['/usr/bin/chromium'], {}, { AGENTISTICS_BROWSER_BIN: '/nope' }))
    expect(b).toEqual({ found: false, reason: 'env-not-executable', tried: ['/nope'] })
    expect(browserBinSentence(b)).toContain('/nope')
  })
  test('the newest Playwright headless shell, current layout', () => {
    const p1 = `${CACHE}/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell`
    const p2 = `${CACHE}/chromium_headless_shell-1300/chrome-headless-shell-linux64/chrome-headless-shell`
    const b = resolveBrowserBin(lookup([p1, p2, '/usr/bin/chromium'], { [CACHE]: ['chromium-1234', 'chromium_headless_shell-1234', 'chromium_headless_shell-1300', 'ffmpeg-1011'] }))
    expect(b).toEqual({ found: true, path: p2, kind: 'headless-shell', source: 'playwright' })
  })
  test('old Playwright layout too', () => {
    const p = `${CACHE}/chromium_headless_shell-1100/chrome-linux/headless_shell`
    expect(resolveBrowserBin(lookup([p], { [CACHE]: ['chromium_headless_shell-1100'] }))).toMatchObject({ found: true, path: p })
  })
  test('PLAYWRIGHT_BROWSERS_PATH is honoured', () => {
    const p = '/pw/chromium_headless_shell-1/chrome-headless-shell-linux64/chrome-headless-shell'
    expect(resolveBrowserBin(lookup([p], { '/pw': ['chromium_headless_shell-1'] }, { PLAYWRIGHT_BROWSERS_PATH: '/pw' }))).toMatchObject({ found: true, path: p })
  })
  test('then chromium on PATH, then chrome', () => {
    expect(resolveBrowserBin(lookup(['/bin/chromium-browser', '/usr/bin/google-chrome'], {}))).toEqual({ found: true, path: '/bin/chromium-browser', kind: 'chromium', source: 'path' })
    expect(resolveBrowserBin(lookup(['/usr/bin/google-chrome'], {}))).toEqual({ found: true, path: '/usr/bin/google-chrome', kind: 'chrome', source: 'path' })
  })
  test('macOS standard install', () => {
    const p = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    expect(resolveBrowserBin(lookup([p], {}, {}, 'darwin'))).toEqual({ found: true, path: p, kind: 'chrome', source: 'system' })
  })
  test('nothing found says why and lists what was tried', () => {
    const b = resolveBrowserBin(lookup([], {}))
    expect(b.found).toBe(false)
    if (!b.found) {
      expect(b.reason).toBe('none')
      expect(b.tried).toContain('/usr/bin/chromium')
    }
    expect(browserBinSentence(b, 'pt')).toBe('Este computador não tem um navegador que o agentistics possa usar.')
  })
  test('kind from a path', () => {
    expect(kindOfPath('/x/chrome-headless-shell')).toBe('headless-shell')
    expect(kindOfPath('/x/Chromium')).toBe('chromium')
    expect(kindOfPath('C:\\x\\msedge.exe')).toBe('chrome')
  })
})
