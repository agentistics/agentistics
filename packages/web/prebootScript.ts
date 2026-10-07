/**
 * prebootScript.ts — turns `src/lib/d1Loader.ts` + `src/boot/preboot.ts` into the ONE classic
 * script the HTML boot splash runs (see `boot/preboot.ts` for why it is not part of the bundle).
 *
 * Pure string work over code that has ALREADY been stripped of its types (vite.config.ts uses
 * `transformWithOxc`, the test uses Bun's transpiler). It refuses rather than guesses: a loader
 * that grew an import, or a boot file importing anything but the loader, would produce a script
 * that cannot run, so the build fails with a sentence instead.
 */
export const PREBOOT_SOURCES = ['src/lib/d1Loader.ts', 'src/boot/preboot.ts'] as const

/** The dev URL; a build serves `assets/ag-boot-<hash>.js` instead. Both replace this in the shell. */
export const PREBOOT_DEV_PATH = '/ag-boot.js'

const LOADER_IMPORT = /^\s*import\s*\{[^}]*\}\s*from\s*['"]\.\.\/lib\/d1Loader(?:\.ts)?['"];?\s*$/m

export function composePrebootScript(loaderJs: string, bootJs: string): string {
  if (/^\s*import\b/m.test(loaderJs)) throw new Error('d1Loader.ts must not import anything: the boot splash runs it as a classic script')
  const boot = bootJs.replace(LOADER_IMPORT, '')
  if (/^\s*import\b/m.test(boot)) throw new Error('boot/preboot.ts may import only from ../lib/d1Loader')
  if (/^\s*export\b/m.test(boot)) throw new Error('boot/preboot.ts must not export anything')
  const loader = loaderJs.replace(/^(\s*)export\s+(?=(?:const|function|let|class)\b)/gm, '$1')
  if (/^\s*export\b/m.test(loader)) throw new Error('d1Loader.ts may only export declarations (export const/function)')
  return `(function(){"use strict";\n${loader}\n${boot}\n})();\n`
}
