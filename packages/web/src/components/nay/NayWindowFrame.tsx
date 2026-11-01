import { useIsMobile } from '../../hooks/useIsMobile'
import { useRef, type PointerEvent as ReactPointerEvent, type ReactNode, type Ref } from 'react'
import { ArrowDownToLine, SquareArrowOutUpRight, PictureInPicture2, Minus, X } from 'lucide-react'
import { windowZIndex, type NayWindow } from '../../lib/nayDock'
type Lang = 'pt' | 'en'
const ORANGE = 'var(--anthropic-orange)'
const ORANGE_DIM = 'var(--anthropic-orange-dim)'

export function NayWindowFrame({ win, lang, title, onFocus, onMove, onDock, onGoTo, onMinimize, onClose, responsive = false, frameRef, children }: {
  win: NayWindow
  lang: Lang
  title: string
  onFocus: () => void
  onMove: (next: Partial<Pick<NayWindow, 'x' | 'y' | 'w' | 'h'>>) => void
  onDock?: () => void
  /** Open this session in the Sessions workspace; the window stays as it is. */
  onGoTo?: () => void
  onMinimize: () => void
  onClose: () => void
  frameRef?: Ref<HTMLDivElement>
  responsive?: boolean
  children: ReactNode
}) {
  const pt = lang === 'pt'
  const mobile = useIsMobile() && responsive
  const dragRef = useRef<{ x: number; y: number; wx: number; wy: number } | null>(null)
  const width = responsive ? `min(${win.w}px, calc(100vw / var(--ui-zoom, 1)))` : win.w
  const height = responsive ? `min(${win.h}px, calc(100dvh / var(--ui-zoom, 1)))` : win.h
  const left = responsive ? `clamp(0px, ${win.x}px, max(0px, calc(100vw / var(--ui-zoom, 1) - ${win.w}px)))` : win.x
  const top = responsive ? `clamp(0px, ${win.y}px, max(0px, calc(100dvh / var(--ui-zoom, 1) - ${win.h}px)))` : win.y

  const startDrag = (e: ReactPointerEvent) => {
    if ((e.target as HTMLElement).closest('button')) return
    e.preventDefault()
    onFocus()
    dragRef.current = { x: e.clientX, y: e.clientY, wx: win.x, wy: win.y }
    const move = (ev: PointerEvent) => {
      const d = dragRef.current
      if (d) onMove({ x: d.wx + ev.clientX - d.x, y: d.wy + ev.clientY - d.y })
    }
    const up = () => { dragRef.current = null; window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const startResize = (e: ReactPointerEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const start = { x: e.clientX, y: e.clientY, w: win.w, h: win.h }
    const move = (ev: PointerEvent) => onMove({ w: start.w + ev.clientX - start.x, h: start.h + ev.clientY - start.y })
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  return (
    <div ref={frameRef} tabIndex={responsive ? -1 : undefined} role={responsive ? 'complementary' : undefined} aria-label={responsive ? title : undefined}
      onPointerDownCapture={onFocus}
      style={{
        position: 'fixed', left, top, width, height, zIndex: windowZIndex(win),
        // THE SAME DISCREET FRAME the terminal's floating windows wear (`FloatingPanelLayer`) — a
        // hairline border, a 10px radius and their shadow. It was a loud orange outline, which read
        // as an alert rather than as a window (owner, 2026-09-29). Their drag bar is NOT borrowed:
        // this window's own header row below is where it is dragged from.
        background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 10,
        boxShadow: '0 14px 36px rgba(0, 0, 0, 0.34), 0 2px 6px rgba(0, 0, 0, 0.18)',
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
      }}
    >
      <header onPointerDown={startDrag} style={{
        display: 'flex', alignItems: 'center', gap: 6, padding: '6px 8px', cursor: 'move', userSelect: 'none',
        borderBottom: '1px solid var(--border)', background: 'var(--bg-elevated, var(--bg-surface))', flexShrink: 0,
      }}>
        <PictureInPicture2 size={13} color="var(--text-tertiary)" style={{ flexShrink: 0 }} />
        <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, fontWeight: 700, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</span>
        {onDock && <LabelButton icon={<ArrowDownToLine size={13} />} label={pt ? 'Acoplar' : 'Dock'}
          title={pt ? 'Voltar esta sessão para o painel do chat' : 'Put this session back in the chat panel'} onClick={onDock} />}
        {onGoTo && <LabelButton icon={<SquareArrowOutUpRight size={13} />} label={pt ? 'Ir para a sessão' : 'Go to session'}
          title={pt ? 'Abrir esta sessão na tela de Sessões' : 'Open this session in the Sessions workspace'} onClick={onGoTo} />}
        <IconButton label={pt ? 'Minimizar' : 'Minimize'} onClick={onMinimize} isMobile={mobile} largeTarget={mobile}><Minus size={14} /></IconButton>
        <IconButton label={pt ? 'Fechar a janela' : 'Close the window'} onClick={onClose} isMobile={mobile} largeTarget={mobile}><X size={14} /></IconButton>
      </header>
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {children}
      </div>
      <div onPointerDown={startResize} title={pt ? 'Arraste para redimensionar' : 'Drag to resize'} style={{
        position: 'absolute', right: 0, bottom: 0, width: 14, height: 14, cursor: 'nwse-resize',
        background: 'linear-gradient(135deg, transparent 50%, var(--border) 50%)',
      }} />
    </div>
  )
}

/** A shared icon control; mobile targets use the existing projected tap area. */
export function IconButton({ label, onClick, isMobile, largeTarget = false, children }: { label: string; onClick: () => void; isMobile: boolean; largeTarget?: boolean; children: ReactNode }) {
  return (
    <button onClick={onClick} aria-label={label} title={label} className={isMobile && !largeTarget ? 'ag-tap-icon' : undefined} style={{
      width: largeTarget ? 44 : 30, height: largeTarget ? 44 : 30, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
      border: 'none', borderRadius: 7, background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer',
    }}>{children}</button>
  )
}

/** A control whose action must be unmistakable: an icon AND a word, orange-outlined (red to end). */
export function LabelButton({ icon, label, title, onClick, danger }: { icon: ReactNode; label: string; title: string; onClick: () => void; danger?: boolean }) {
  const tone = danger ? 'var(--accent-red, #ef4444)' : ORANGE
  return (
    <button onClick={onClick} title={title} style={{
      display: 'flex', alignItems: 'center', gap: 5, flexShrink: 0, padding: '4px 9px', borderRadius: 7,
      border: `1px solid ${tone}`, background: danger ? 'rgba(239, 68, 68, 0.1)' : ORANGE_DIM, color: tone, cursor: 'pointer',
      fontFamily: 'inherit', fontSize: 11.5, fontWeight: 600, whiteSpace: 'nowrap',
    }}>
      {icon}{label}
    </button>
  )
}
