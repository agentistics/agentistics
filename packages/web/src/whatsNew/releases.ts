/**
 * releases.ts — the curated "what's new" copy, one entry per release worth telling a person about.
 *
 * Source of truth for the modal opened from the "Updated to vX" notification. It is hand-written on
 * purpose: only changes a person can notice belong here (no refactors, tests or internal plumbing),
 * 3–8 short plain-language lines per group, in both languages. A version with no entry announces
 * nothing. EVERY RELEASE ADDS ITS ENTRY IN THE SAME COMMIT (CLAUDE.md release checklist).
 */
export interface Line { pt: string; en: string }
export interface ReleaseNotes { features: Line[]; fixes: Line[] }

export const RELEASES: Record<string, ReleaseNotes> = {
  '2.112.0': {
    features: [
      {
        pt: 'Na Nova sessão, "Procurar pasta…" deixa escolher qualquer pasta clicando, sem digitar caminho, e um filtro mostra um disco por vez.',
        en: 'In New session, "Browse folder…" lets you pick any folder by clicking, without typing a path, and a filter shows one disk at a time.',
      },
      {
        pt: 'Cofre: um só botão de olho por segredo, criar grupo na hora, excluir vários de uma vez e escolher o tipo de cada linha ao importar (inclusive tipos seus).',
        en: 'Vault: one eye button per secret, create a group on the spot, delete several at once and pick each row\'s type when importing (your own types too).',
      },
      {
        pt: 'Segredos do cofre liberados para uma conversa agora funcionam em todos os assistentes, não só no Claude Code.',
        en: 'Vault secrets granted to a conversation now work in every assistant, not only Claude Code.',
      },
      {
        pt: 'Cada assistente já começa sabendo que roda dentro do agentistics, sem responder sozinho.',
        en: 'Every assistant starts knowing it runs inside agentistics, without answering on its own.',
      },
      {
        pt: 'Uma sessão criada por outra mostra quem a criou e avisa a sessão de origem quando termina.',
        en: 'A session started by another one shows who started it and reports back to it when done.',
      },
    ],
    fixes: [
      {
        pt: 'O app fica mais leve enquanto as sessões trabalham: só o que mudou é recalculado.',
        en: 'The app stays lighter while sessions work: only what changed is recalculated.',
      },
      {
        pt: 'O Agentask abre mais rápido, lembrando a última lista, e as colunas se ajustam ao conteúdo.',
        en: 'Agentask opens faster by remembering the last list, and columns fit their content.',
      },
      {
        pt: 'Cada citação fica junto da sua resposta na mensagem.',
        en: 'Each quote stays next to your reply to it in the message.',
      },
      {
        pt: 'Uma mensagem digitada não aparece mais como "Texto colado".',
        en: 'A typed message no longer shows up as "Pasted text".',
      },
      {
        pt: 'Sem o aviso falso "A máquina não respondeu a tempo" quando a mensagem chegou.',
        en: 'No more false "The machine did not answer in time" warning when the message arrived.',
      },
      {
        pt: 'O Codex não trava mais o envio com a pergunta do serviço em segundo plano.',
        en: 'Codex no longer blocks sending with its background-service question.',
      },
      {
        pt: 'Atualizar o app também atualiza a integração com os assistentes e espera a versão nova subir.',
        en: 'Updating the app also refreshes the assistant integrations and waits for the new version to come up.',
      },
    ],
  },
  '2.111.3': {
    features: [],
    fixes: [
      {
        pt: 'O app não fica mais lento por varrer a pasta /tmp e a pasta pessoal procurando repositórios.',
        en: 'The app no longer slows down from scanning /tmp and your home folder looking for repositories.',
      },
    ],
  },
  '2.111.2': {
    features: [
      {
        pt: 'Sessões novas abrem sem travar, mesmo em máquinas com discos grandes; se a busca de projetos demorar, há "Tentar de novo".',
        en: 'New sessions open without freezing, even on machines with big disks; if the project search is slow there is a "Try again" button.',
      },
      {
        pt: 'As respostas do Antigravity agora aparecem no chat.',
        en: 'Antigravity replies now show up in the chat.',
      },
      {
        pt: 'A grade de subtarefas tem larguras de coluna próprias, ajustáveis e lembradas.',
        en: 'The subtask grid has its own column widths, resizable and remembered.',
      },
      {
        pt: 'O custo de uma tarefa mostra as requisições premium do Copilot como valor em dinheiro (aproximado).',
        en: 'Task cost shows Copilot premium requests as money (approximate).',
      },
    ],
    fixes: [
      {
        pt: 'As telas de carregamento ficam centralizadas na janela.',
        en: 'Loading screens are centred in the window.',
      },
      {
        pt: 'A Home se recupera sozinha quando as métricas ainda estão subindo.',
        en: 'Home recovers on its own when the metrics are still warming up.',
      },
      {
        pt: 'Sessões não aparecem mais como encerradas por causa de configuração de idioma do sistema.',
        en: 'Sessions no longer show as ended because of the system language setting.',
      },
    ],
  },
  '2.111.1': {
    features: [
      {
        pt: 'Nova tela de carregamento clássica, do primeiro quadro até o app abrir.',
        en: 'A new classic loading screen, from the first frame until the app opens.',
      },
      {
        pt: 'Respostas com citação aparecem como blocos de citação no campo de mensagem e na mensagem enviada, com "mostrar mais/menos" e remoção.',
        en: 'Quoted replies appear as quote blocks in the composer and in the sent message, with show more/less and remove.',
      },
      {
        pt: 'Os discos dos seus projetos são descobertos automaticamente, com chaves para ligar e desligar cada um.',
        en: 'Your project disks are discovered automatically, with a switch for each one.',
      },
      {
        pt: 'No celular, o modo de chat vira uma lista e as notificações ficam sempre visíveis.',
        en: 'On mobile, chat mode becomes a list and notifications stay on screen.',
      },
    ],
    fixes: [
      {
        pt: 'Os pedidos de aprovação do Codex 0.160.1 mostram a pergunta no chat.',
        en: 'Codex 0.160.1 approval prompts show the question in the chat.',
      },
      {
        pt: 'O sino de sessões silenciadas conta só as sessões em execução.',
        en: 'The muted-sessions bell counts only running sessions.',
      },
    ],
  },
}
