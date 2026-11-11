import { createRoot, type Root } from 'react-dom/client'
import { Phone } from 'lucide-react'
import { ComposerTaskButton, useComposerTask } from '../src/components/chat/ComposerTask'
import { ComposerAttachButton, ComposerMicButton, ComposerIconButton, ComposerShell, ComposerToolbar, ComposerSendButton } from '../src/components/chat/ComposerShell'
import '../src/index.css'

function Preview() {
  const task = useComposerTask()
  return <main style={{ maxWidth: 800, margin: '0 auto', padding: 12, minHeight: '100dvh', display: 'flex', flexDirection: 'column', justifyContent: 'end', gap: 20 }}>
    <div style={{ color: 'var(--text-primary)', fontSize: 18, fontWeight: 600 }}>Agentistics · Motor</div>
    <div style={{ color: 'var(--text-secondary)', fontSize: 13, lineHeight: 1.6 }}>Corrigir o envio e registrar a tarefa com prioridade e prazo.</div>
    <div style={{ marginTop: 'auto', paddingBottom: 16 }}>
      <ComposerShell>
        <textarea aria-label="Mensagem" placeholder="Escreva sua mensagem…" style={{ width: '100%', minHeight: 64, background: 'transparent', border: 0, color: 'var(--text-primary)', padding: 8, fontFamily: 'inherit', fontSize: 16 }} />
        <ComposerToolbar>
          <ComposerAttachButton label="Anexar arquivo" disabled={false} uploading={false} onClick={() => {}} />
          <ComposerMicButton label="Ditar" disabled={false} listening={false} onClick={() => {}} />
          <ComposerIconButton aria-label="Ligação"><Phone size={15} /></ComposerIconButton>
          <ComposerTaskButton options={task.options} onChange={task.setOptions} pt disabled={false} />
          <span style={{ flex: 1 }} />
          <ComposerSendButton onClick={() => { task.take('Deadline task'); task.complete() }} disabled={false} sending={false} active label="Enviar" />
        </ComposerToolbar>
      </ComposerShell>
    </div>
  </main>
}
const preview = globalThis as typeof globalThis & { composerTaskPreviewRoot?: Root }
preview.composerTaskPreviewRoot ??= createRoot(document.getElementById('root')!)
preview.composerTaskPreviewRoot.render(<Preview />)
