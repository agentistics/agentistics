import { ConfirmModal } from '../../pages/settings/primitives'
import { answerReviewOverride, useReviewOverride } from '../../lib/statusWrites'

export function StatusWriteFeedback({ lang }: { lang: string }) {
  const prompt = useReviewOverride()
  const pt = lang === 'pt'
  return <ConfirmModal open={prompt !== null} title={pt ? 'Ainda há subtarefas abertas' : 'Subtasks are still open'}
    message={pt ? `Esta tarefa tem ${prompt?.count ?? 0} subtarefas abertas. Mover a tarefa-mãe para revisão mesmo assim?` : `This task has ${prompt?.count ?? 0} open subtasks. Move the parent task to review anyway?`}
    confirmLabel={pt ? 'Mover mesmo assim' : 'Move anyway'} cancelLabel={pt ? 'Cancelar' : 'Cancel'}
    onConfirm={() => answerReviewOverride(true)} onCancel={() => answerReviewOverride(false)} />
}
