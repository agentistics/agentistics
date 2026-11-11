/** Run: agentop heavy -- agentop run --rm -- bun packages/web/qa/menu-rail-expande.ts [evidence-dir] */
import { chromium, expect } from 'playwright/test'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dir, '../../..')
const output = resolve(process.argv[2] ?? 'docs/media/menu-rail-expande')
await mkdir(output, { recursive: true })
const server = await createServer({
  configFile: false, root, publicDir: join(root, 'packages/web/public'), plugins: [react()],
  server: { host: '127.0.0.1', port: Number(process.env.WEB_PORT ?? 48103), strictPort: true },
  resolve: { alias: { '@agentistics/core': join(root, 'packages/core/src/index.ts') } },
})
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
try {
  await server.listen()
  browser = await chromium.launch({ headless: true, executablePath: process.env.QA_CHROMIUM })
  const evidence = []
  for (const mode of ['aside', 'rail']) {
    for (const activation of ['click', 'Enter', 'Space']) {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' })
      const errors: string[] = []
      page.on('pageerror', e => errors.push(e.message))
      await page.route('**/api/**', route => route.fulfill({ json: {} }))
      await page.goto(`http://127.0.0.1:${server.config.server.port}/packages/web/qa/menu-rail-expande.html?mode=${mode}`)
      const group = page.getByRole('button', { name: 'Agentask', exact: true })
      await expect(group).toHaveAttribute('aria-expanded', 'false')
      if (activation === 'click') await page.screenshot({ path: join(output, `${mode}-1280-collapsed.png`) })
      if (activation === 'click') await group.click()
      else { await group.focus(); await page.keyboard.press(activation) }
      const heading = page.locator('[data-area-heading="tasks"]')
      await expect(page.locator('aside')).toHaveAttribute('data-open', 'true')
      await expect(heading).toHaveAttribute('aria-expanded', 'true')
      await expect(heading).toBeFocused()
      await expect(page.locator('a[href="/tasks/calendar"]')).toBeVisible()
      await expect(page.locator('[data-area-heading="usage"]')).toHaveAttribute('aria-expanded', 'true')
      await expect(page.locator('[data-area-heading="sessions"]')).toHaveAttribute('aria-expanded', 'false')
      await expect(page.locator('[data-location]')).toHaveText('/sessions')
      if (activation === 'click') await page.screenshot({ path: join(output, `${mode}-1280-after-click.png`) })
      // Expanded titles retain the toggle contract. Destinations retain navigation in the collapsed menu.
      await heading.click()
      await expect(heading).toHaveAttribute('aria-expanded', 'false')
      await expect(page.locator('[data-location]')).toHaveText('/sessions')
      if (mode === 'rail') await page.locator('[data-area-rail]').getByRole('button', { name: 'Collapse', exact: true }).click()
      else await page.getByRole('button', { name: 'Hide sidebar', exact: true }).click()
      await page.getByRole('button', { name: 'Vault', exact: true }).click()
      await expect(page.locator('[data-location]')).toHaveText('/vault')
      if (errors.length) throw new Error(JSON.stringify(errors))
      evidence.push({ mode, activation, groupOpened: true, groupsPreserved: true, focus: true, unchangedRoute: true, destinationNavigated: true, errors })
      await page.close()
    }
  }
  const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' })
  await phone.route('**/api/**', route => route.fulfill({ json: {} }))
  await phone.goto(`http://127.0.0.1:${server.config.server.port}/packages/web/qa/menu-rail-expande.html?mode=mobile`)
  await phone.getByRole('button', { name: 'More', exact: true }).click()
  await phone.locator('[data-area-heading="tasks"]').click()
  await expect(phone.locator('[data-area-heading="tasks"]')).toHaveAttribute('aria-expanded', 'true')
  await expect(phone.locator('[data-location]')).toHaveText('/sessions')
  if (await phone.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw new Error('Mobile page overflow')
  await phone.screenshot({ path: join(output, 'mobile-390-group-open.png') })
  await phone.locator('a[href="/tasks/calendar"]').click()
  await expect(phone.locator('[data-location]')).toHaveText('/tasks/calendar')
  evidence.push({ mode: 'mobile', width: 390, groupOpened: true, childNavigated: true, overflow: false })
  console.log(JSON.stringify({ evidence, screenshots: output }, null, 2))
} finally {
  await browser?.close()
  await server.close()
}
