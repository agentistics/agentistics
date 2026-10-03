/**
 * home-i18n.ts — the `home` and `tasks` tabs' own words (EN default, pt-BR toggle, D-TUI-13). Kept
 * beside the screens like `code-i18n.ts`, so the shell's string table stays the shell's.
 */
export interface HomeStrings {
  harnessLine: string
  noSandbox: string
  filedRule: string
  promptPlaceholder: string
  promptHint: string
  today: string
  cost: string
  tokens: string
  allFour: string
  sessions: string
  live: string
  streak: string
  days: (n: number) => string
  apiEquivalent: string
  todayDown: string
  todayLoading: string
  resume: string
  resumeEmpty: string
  yourTasks: string
  tasksDetail: string
  tasksEmpty: string
  providers: string
  providersManage: string
  providerState: { ready: string; off: string; unreachable: string; missing: string }
  machine: (others: number, need: number) => string
  machineKey: string
  hints: { start: string; resume: string; nextTab: string; sessions: string }
  noCodeTab: string
  noResume: (n: number) => string
  externalRefuse: string
  openingSession: (title: string) => string
  tasksTitle: string
  tasksSub: (n: number) => string
  tasksReadOnly: string
  tasksHints: { move: string; web: string }
  notFiledCost: string
  progress: (done: number, total: number) => string
}

const EN: HomeStrings = {
  harnessLine: 'code · the agentistics native harness',
  noSandbox: '▲ no sandbox — tools run as you',
  filedRule: 'every session is filed under a task',
  promptPlaceholder: 'what are we building?',
  promptHint: 'enter asks for the task',
  today: 'today',
  cost: 'cost',
  tokens: 'tokens',
  allFour: '(all 4)',
  sessions: 'sessions',
  live: 'live',
  streak: 'streak',
  days: n => `${n} ${n === 1 ? 'day' : 'days'}`,
  apiEquivalent: 'api-equivalent cost',
  todayDown: 'N/A — the agentistics server is not running (start it in services)',
  todayLoading: 'reading…',
  resume: 'resume',
  resumeEmpty: 'nothing to resume yet',
  yourTasks: 'your tasks',
  tasksDetail: 'the tasks tab has the detail',
  tasksEmpty: 'no open tasks are yours yet',
  providers: 'providers',
  providersManage: 'manage',
  providerState: { ready: 'ready', off: 'beta · off', unreachable: 'unreachable', missing: 'no key' },
  machine: (others, need) => `${others} other session${others === 1 ? '' : 's'}`,
  machineKey: 'ctrl+s opens the sessions tab',
  hints: { start: 'enter start', resume: '1-3 resume', nextTab: '] next tab', sessions: 'ctrl+s sessions' },
  noCodeTab: 'This build has no native harness, so there is no code tab to start a session in.',
  noResume: n => `There is no session ${n} to resume.`,
  externalRefuse: 'agentop did not start that session, so it cannot be opened from here.',
  openingSession: title => `Opening ${title}…`,
  tasksTitle: 'your tasks',
  tasksSub: n => `${n} · claimed by you or filed by your sessions`,
  tasksReadOnly: 'read-only here · edit on the web',
  tasksHints: { move: '↑↓ select', web: 'w open on the web' },
  notFiledCost: 'N/A',
  progress: (d, t) => `${d}/${t}`,
}

const PT: HomeStrings = {
  harnessLine: 'code · o harness nativo do agentistics',
  noSandbox: '▲ sem sandbox — as ferramentas rodam como você',
  filedRule: 'toda sessão é arquivada numa tarefa',
  promptPlaceholder: 'o que vamos construir?',
  promptHint: 'enter pede a tarefa',
  today: 'hoje',
  cost: 'custo',
  tokens: 'tokens',
  allFour: '(os 4)',
  sessions: 'sessões',
  live: 'ativas',
  streak: 'sequência',
  days: n => `${n} ${n === 1 ? 'dia' : 'dias'}`,
  apiEquivalent: 'custo equivalente à API',
  todayDown: 'N/A — o servidor agentistics não está rodando (inicie em serviços)',
  todayLoading: 'lendo…',
  resume: 'retomar',
  resumeEmpty: 'nada para retomar ainda',
  yourTasks: 'suas tarefas',
  tasksDetail: 'a aba tarefas tem o detalhe',
  tasksEmpty: 'nenhuma tarefa aberta é sua ainda',
  providers: 'provedores',
  providersManage: 'gerenciar',
  providerState: { ready: 'pronto', off: 'beta · desligado', unreachable: 'inacessível', missing: 'sem chave' },
  machine: (others, need) => `${others} outra${others === 1 ? '' : 's'} sess${others === 1 ? 'ão' : 'ões'}`,
  machineKey: 'ctrl+s abre a aba sessões',
  hints: { start: 'enter iniciar', resume: '1-3 retomar', nextTab: '] próxima aba', sessions: 'ctrl+s sessões' },
  noCodeTab: 'Esta versão não tem o harness nativo, então não há aba código para iniciar uma sessão.',
  noResume: n => `Não há sessão ${n} para retomar.`,
  externalRefuse: 'O agentop não iniciou essa sessão, então ela não pode ser aberta daqui.',
  openingSession: title => `Abrindo ${title}…`,
  tasksTitle: 'suas tarefas',
  tasksSub: n => `${n} · assumidas por você ou com sessões suas`,
  tasksReadOnly: 'só leitura aqui · edite na web',
  tasksHints: { move: '↑↓ selecionar', web: 'w abrir na web' },
  notFiledCost: 'N/A',
  progress: (d, t) => `${d}/${t}`,
}

export function homeStrings(lang: 'en' | 'pt'): HomeStrings {
  return lang === 'pt' ? PT : EN
}
