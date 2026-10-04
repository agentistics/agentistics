/**
 * SourceSettings — a chat SOURCE's own settings for its next turns, inside the composer's standard
 * "more" menu (UI.UNIFY). Today only the native runtime gives any: reasoning effort (B9.1) on the
 * same `EffortPicker` the new-session dialog uses, the gated browser (B6.4) and the extra folders
 * (H20) through the controls the session's own page used to draw. Every one waits while a turn runs.
 */
import { EffortPicker } from './EffortPicker'
import { NativeBrowserSwitch } from './NativeBrowserSwitch'
import { NativeExtraDirs } from './NativeExtraDirs'
import type { SourceControls } from './chatSource'

const heading = {
  margin: '2px 8px 4px', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-tertiary)',
} as const
const rule = { height: 1, background: 'var(--border)', margin: '4px 2px' } as const

export function SourceSettings({ controls, pt, onRefused }: { controls: SourceControls; pt: boolean; onRefused: (sentence: string) => void }) {
  const lang = pt ? 'pt' : 'en'
  const { effort, browser, extraDirs, busy } = controls
  return (
    <div data-testid="source-settings">
      {effort && (
        <>
          <div style={rule} />
          <p style={heading}>{pt ? 'Raciocínio' : 'Reasoning'}</p>
          <div style={{ padding: '0 8px 6px', opacity: busy ? 0.6 : 1, pointerEvents: busy ? 'none' : 'auto' }} aria-disabled={busy}
            title={busy ? (pt ? 'Uma run está em andamento — mude quando ela terminar.' : 'A run is in progress — change it when it ends.') : undefined}>
            <EffortPicker efforts={effort.efforts} value={effort.value}
              onChange={v => { void effort.set(v).then(r => { if (r) onRefused(r) }) }} />
          </div>
        </>
      )}
      {(browser || extraDirs) && <div style={rule} />}
      {browser && (
        <div style={{ padding: '4px 8px' }}>
          <NativeBrowserSwitch on={browser.on} running={busy} lang={lang} onSet={on => browser.set(on)} />
        </div>
      )}
      {extraDirs && (
        <div style={{ padding: '4px 8px 6px' }}>
          <NativeExtraDirs dirs={extraDirs.dirs} running={busy} lang={lang} onAdd={p => extraDirs.add(p)} />
        </div>
      )}
    </div>
  )
}
