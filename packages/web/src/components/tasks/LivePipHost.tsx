/**
 * LivePipHost — mounted ONCE in the app shell. It draws the Live inside the external window the store holds,
 * so the window outlives the route, the session and the popover that opened it.
 *
 * Everything the person does inside the window stays inside it (expand, collapse, accordion, "+N", filters):
 * React forwards a portal's synthetic events to the PARENT tree, and the parent here may be a popover whose
 * click handler navigates the main window to the Live — so the boundary below stops every one of them.
 * The only thing that leaves is "abrir sessão / tarefa", which `LiveDeliveryView` performs on the main router.
 */

import { LiveDelivery } from './LiveDelivery'
import { PipPortal } from './livePip'
import { closePip, usePip } from './livePipStore'

const STOP = (e: { stopPropagation: () => void }) => e.stopPropagation()

export function LivePipHost({ lang }: { lang: 'pt' | 'en' }) {
  const pip = usePip()
  if (!pip) return null
  return (
    <PipPortal win={pip.win} onClose={closePip}>
      <div
        data-live-pip-boundary style={{ height: '100%', minHeight: 0 }}
        onClick={STOP} onMouseDown={STOP} onMouseUp={STOP} onPointerDown={STOP} onPointerUp={STOP} onKeyDown={STOP} onKeyUp={STOP} onDoubleClick={STOP} onContextMenu={STOP} onFocus={STOP}
      >
        <LiveDelivery lang={lang} compact inPip initialTaskIds={pip.taskIds} />
      </div>
    </PipPortal>
  )
}
