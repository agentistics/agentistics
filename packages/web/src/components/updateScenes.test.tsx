import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { UpdateFinale } from './UpdateFinale'
import { UpgradeOverlay } from './UpgradeOverlay'
import { StageText, useStageRefs } from './UpdateStage'
import { IDLE_FLOW, resetFlow, setFlowForTest } from '../lib/upgradeFlow'

function Probe() { const refs = useStageRefs(); return <StageText lang="pt" isMobile={false} refs={refs} from="2.30.0" to="2.31.0" title="loader.title" phrase="x" /> }

test('the title colours from orange and to green', () => {
  const html = renderToStaticMarkup(<Probe />)
  expect(html).toMatch(/#F59E0B[^>]*>v2\.30\.0/)
  expect(html).toMatch(/#10b981[^>]*>v2\.31\.0/)
  expect(html).toContain('Atualizando ')
})

test('the finale renders its stage and the result text in both languages', () => {
  for (const lang of ['pt', 'en'] as const) {
    const html = renderToStaticMarkup(<UpdateFinale lang={lang} version="2.31.0" from="2.30.0" onDone={() => {}} />)
    expect(html).toContain(lang === 'pt' ? 'Atualizado ' : 'Updated ')
    expect(html).toContain('<canvas')
  }
})

test('the loader renders its stage', () => {
  setFlowForTest({ ...IDLE_FLOW, phase: 'running', target: '2.31.0', from: '2.30.0', startedAt: 1, view: { step: 'data', fraction: 0.2, failed: false } })
  const html = renderToStaticMarkup(<UpgradeOverlay lang="en" isMobile />)
  expect(html).toContain('Updating ')
  resetFlow()
})

test('a timeout offers retry instead of sending a non-technical user to reload', () => {
  setFlowForTest({ ...IDLE_FLOW, phase: 'timeout', target: '2.31.0', from: '2.30.0', startedAt: 1 })
  const html = renderToStaticMarkup(<UpgradeOverlay lang="en" isMobile />)
  expect(html).toContain('Try again')
  expect(html).not.toContain('Reload')
  resetFlow()
})
