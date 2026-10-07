import { describe, expect, test } from 'bun:test'
import { composePrebootScript, PREBOOT_DEV_PATH, PREBOOT_SOURCES } from './prebootScript'
import { D1_PATHS } from './src/lib/d1Loader'

const root = new URL('./', import.meta.url)
const transpile = (code: string) => new Bun.Transpiler({ loader: 'ts' }).transformSync(code)
const read = (path: string) => Bun.file(new URL(path, root)).text()

describe('the boot splash script', () => {
  test('composes the two real sources into one classic script that parses', async () => {
    const [loader, boot] = await Promise.all(PREBOOT_SOURCES.map(async src => transpile(await read(src))))
    const script = composePrebootScript(loader, boot)
    expect(script).not.toMatch(/^\s*(import|export)\b/m)
    expect(() => new Function(script)).not.toThrow()
    expect(script).toContain('startPreboot()')
  })

  test('refuses a loader that imports anything', () => {
    expect(() => composePrebootScript("import x from 'y'\nconst a = 1", '')).toThrow(/must not import/)
  })

  test('refuses a boot file importing anything but the loader', () => {
    expect(() => composePrebootScript('const a = 1', "import { b } from './other'\nb()")).toThrow(/only from/)
  })

  test('drops the single loader import and the export keywords', () => {
    const out = composePrebootScript('export const A = 1\nexport function f() { return A }', "import { A, f } from '../lib/d1Loader'\nf()")
    expect(out).toContain('const A = 1')
    expect(out).not.toContain('import')
    expect(out).not.toContain('export')
  })
})

describe('index.html', () => {
  test('runs the splash script before the app bundle, and has no wordmark', async () => {
    const html = await read('index.html')
    const boot = html.indexOf(`<script src="${PREBOOT_DEV_PATH}"></script>`)
    const app = html.indexOf('<script type="module" src="/src/main.tsx">')
    expect(boot).toBeGreaterThan(html.indexOf('id="ag-preboot"'))
    expect(boot).toBeLessThan(app)
    expect(html).not.toContain('ag-preboot-label')
  })

  test("the first painted frame is D1's frame 0: the brand logo at 10 %, nothing else", async () => {
    const html = await read('index.html')
    const svg = html.match(/<svg class="ag-preboot-mark"[\s\S]*?<\/svg>/)![0]
    const inner = svg.replace(/^<svg[^>]*>/, '').replace(/<\/svg>$/, '')
    expect(inner).toBe(`<g opacity=".1"><path d="${D1_PATHS.shell}" style="fill:none;stroke:#FD8924;stroke-width:3"/>`
      + `<path d="${D1_PATHS.earRight}" style="fill:#FD8924"/><path d="${D1_PATHS.earLeft}" style="fill:#FD8924"/>`
      + `<path d="${D1_PATHS.eyeLeft}" style="fill:none;stroke:#FD8924;stroke-width:2"/><path d="${D1_PATHS.eyeRight}" style="fill:none;stroke:#FD8924;stroke-width:2"/></g>`)
  })
})
