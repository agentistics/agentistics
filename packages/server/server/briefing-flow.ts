// The numbered start flow — ONE source for the spawn context (sessions/agentistics-context.ts) and the
// installed briefing (briefing.ts), so a session started outside agentistics follows the same steps.
// Pure. No double quotes in the text: it travels through JSON-serialised spawn plans.
// TODO(engine): native sessions (/api/runtime/sessions) do not receive this flow; the engine leader owns that path.
export type FlowLang = 'en' | 'pt'

export function flowLines(lang: FlowLang, role?: 'leader' | 'worker', hasTask = false): string[] {
  const pt = lang === 'pt'
  const steps: string[] = []
  if (!role) {
    steps.push(pt
      ? 'Papel: antes de assumir qualquer papel, veja com agentistics_sessions se já há um líder neste projeto/tarefa (exclua esta sessão). Se houver, chame agentistics_session_role com role worker e reporte a ele; senão decida líder ou worker pelo pedido e chame agentistics_session_role.'
      : 'Role: before taking any role, check agentistics_sessions for an existing leader in this project/task (exclude this session). If one exists, call agentistics_session_role with role worker and report to it; otherwise decide leader or worker from the request and call agentistics_session_role.')
  } else if (role === 'leader') {
    steps.push(pt
      ? 'Líder único: veja com agentistics_sessions se já há outro líder neste projeto/tarefa (exclua esta sessão); se houver, chame agentistics_session_role com role worker e reporte a ele.'
      : 'One leader: check agentistics_sessions for another leader in this project/task (exclude this session); if one exists, call agentistics_session_role with role worker and report to it.')
  }
  steps.push(pt
    ? (hasTask
        ? 'Tarefa: esta sessão já está vinculada; se o trabalho se dividir, crie subtarefas (agentistics_task_subtask) e vincule a sessão com agentistics_task_session.'
        : 'Tarefa: encontre ou crie a tarefa (agentistics_tasks; senão agentistics_task_create com prioridade e tipo) e então vincule esta sessão com agentistics_task_session; use subtarefas se o trabalho se dividir.')
    : (hasTask
        ? 'Task: this session is already linked; if the work splits, create subtasks (agentistics_task_subtask) and link the session with agentistics_task_session.'
        : 'Task: find or create the task (agentistics_tasks; else agentistics_task_create with priority and type), then link this session with agentistics_task_session; use subtasks when the work splits.'))
  steps.push(pt
    ? 'Andamento: ao começar, status in_progress (agentistics_task_status); comente os marcos (agentistics_task_comment); ao entregar, in_review; nunca done.'
    : 'Progress: set in_progress when you start (agentistics_task_status); comment at milestones (agentistics_task_comment); set in_review on delivery; never done.')
  steps.push(pt
    ? 'Fim: handback para a sessão que iniciou esta (agentistics_session_message); sem pai, um comentário na tarefa.'
    : 'Finish: handback to the session that started this one (agentistics_session_message); with no parent, a comment on the task.')
  return [pt ? 'Fluxo (siga em ordem, em qualquer projeto):' : 'Flow (follow in order, in any project):', ...steps.map((t, n) => `${n + 1}. ${t}`)]
}

/** Both languages, for the installed briefing (read by sessions started outside agentistics). */
export function flowBriefing(): string {
  return [...flowLines('en'), ...flowLines('pt')].join('\n')
}
