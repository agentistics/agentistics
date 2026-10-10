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
  '2.115.0': {
    features: [
      {
        pt: 'As novidades abrem sozinhas uma vez depois de cada atualização, com a opção "Não mostrar novamente"; a escolha fica salva nesta máquina.',
        en: 'What\'s new opens by itself once after each update, with a "Don\'t show again" option; the choice is saved on this machine.',
      },
      {
        pt: 'Configurações → Novidades mostra a versão atual e o histórico das atualizações; clicar no número da versão também abre as novidades.',
        en: 'Settings → What\'s new shows the current version and the history of updates; clicking the version number also opens it.',
      },
      {
        pt: 'O cartão de métricas da sessão mostra o custo por resposta e avisa quando a conversa passa do limite de tokens, para passar o bastão a uma sessão nova.',
        en: 'The session metrics card shows the cost per reply and warns when the conversation passes the token limit, so you can hand off to a fresh session.',
      },
      {
        pt: 'O briefing que cada assistente recebe ficou mais curto: só as ferramentas de sessões e do Agentask, com métricas e painéis em uma linha.',
        en: 'The briefing each assistant receives is shorter: only the sessions and Agentask tools, with metrics and dashboards in one line.',
      },
    ],
    fixes: [],
  },
  '2.114.1': {
    features: [],
    fixes: [
      {
        pt: 'O terminal da sessão e o Studio voltaram para a barra de baixo e para o painel lateral, em todos os assistentes.',
        en: 'The session terminal and the Studio are back in the bottom bar and the side panel, for every assistant.',
      },
      {
        pt: 'Um painel fixado e minimizado na barra de baixo agora pode ser desafixado: o mesmo alfinete o devolve ao painel lateral.',
        en: 'A pinned panel minimized to the bottom bar can now be unpinned: the same pin returns it to the side panel.',
      },
    ],
  },
  '2.114.0': {
    features: [
      {
        pt: 'O ⓘ ao lado do título mostra as sessões mais recentes primeiro, com a hora, separa as que estão rodando das encerradas e tem busca.',
        en: 'The ⓘ next to the title lists the newest sessions first, with their time, keeps running ones apart from ended ones and has a search.',
      },
      {
        pt: 'Cada assistente agora começa sabendo trabalhar como líder ou como executor, quais ferramentas do agentistics tem e quando sugerir uma skill de especificação.',
        en: 'Every assistant now starts knowing how to work as a leader or a worker, which agentistics tools it has and when to suggest a specification skill.',
      },
      {
        pt: 'Experimental (agentop experimental enable): sessões de Claude, Codex, Gemini e Kimi criadas pela web conversam pelo protocolo oficial de cada assistente — resposta ao vivo, cartões de permissão e pergunta, e a sessão continua viva quando o servidor reinicia.',
        en: 'Experimental (agentop experimental enable): Claude, Codex, Gemini and Kimi sessions started from the web talk through each assistant\'s official protocol — live answers, permission and question cards, and the session stays alive when the server restarts.',
      },
      {
        pt: 'Codex e Gemini mostram o comando `!` e a saída dele no chat.',
        en: 'Codex and Gemini show a `!` command and its output in the chat.',
      },
    ],
    fixes: [
      {
        pt: 'A animação de atualização vai até o fim sem piscar nem mostrar a tela de carregamento no meio.',
        en: 'The update animation plays to the end without flashing or showing the loading screen in the middle.',
      },
      {
        pt: 'Codex: a web não mostra mais "sessão encerrada" com a sessão viva, a mensagem enviada com o Codex ocupado entra na fila dele e o texto não volta para o campo nem é reenviado.',
        en: 'Codex: the web no longer says "session ended" while the session is alive, a message sent while Codex is busy joins its queue, and the text no longer comes back to the box or gets sent twice.',
      },
      {
        pt: 'Gemini e Kimi ficam ligados à conversa certa desde a criação; reabrir uma sessão Kimi voltou a funcionar.',
        en: 'Gemini and Kimi are linked to the right conversation from the start; reopening a Kimi session works again.',
      },
    ],
  },
  '2.113.0': {
    features: [
      {
        pt: 'Toda sessão nova abre direto no chat, em qualquer assistente (Codex, Gemini, Kimi, Copilot…), mesmo antes da primeira mensagem. O terminal fica a um clique.',
        en: 'Every new session opens straight on the chat, in any assistant (Codex, Gemini, Kimi, Copilot…), even before the first message. The terminal is one click away.',
      },
      {
        pt: 'Um ⓘ ao lado do título mostra quem iniciou a sessão, as sessões que ela iniciou e a tarefa ligada; clique para ir até elas.',
        en: 'An ⓘ next to the title shows who started the session, the sessions it started and its linked task; click to go to them.',
      },
      {
        pt: 'Clique com o botão direito (ou toque longo) num link de uma mensagem para copiar só o link ou abrir numa nova aba.',
        en: 'Right-click (or long-press) a link in a message to copy just the link or open it in a new tab.',
      },
      {
        pt: 'Instale o Claude Code, o Codex, o Gemini ou o Copilot com um clique em Configurações → Harnesses ou na Nova sessão, com progresso na tela e o Node.js incluído quando faltar. "Entrar" abre o login do assistente.',
        en: 'Install Claude Code, Codex, Gemini or Copilot with one click in Settings → Harnesses or in New session, with progress on screen and Node.js included when missing. "Sign in" opens the assistant\'s login.',
      },
    ],
    fixes: [
      {
        pt: 'A primeira mensagem de uma sessão nova, com ou sem anexo, aparece uma vez só e não se perde.',
        en: 'The first message of a new session, with or without an attachment, shows once and is never lost.',
      },
      {
        pt: 'As respostas do Codex, do Kimi e do Antigravity aparecem no chat em poucos segundos, não mais depois de vários minutos.',
        en: 'Codex, Kimi and Antigravity replies show in the chat within seconds, no longer after several minutes.',
      },
      {
        pt: '"Esta sessão" mostra o nome real do modelo (por exemplo, Opus 5.5).',
        en: '"This session" shows the real model name (for example, Opus 5.5).',
      },
      {
        pt: 'Atualizar o app não fica mais preso na animação: se a versão nova já está instalada, o app só reinicia, e se algo demorar aparece o botão "Reiniciar agora".',
        en: 'Updating the app no longer gets stuck on the animation: if the new version is already installed the app just restarts, and if something takes too long a "Restart now" button appears.',
      },
      {
        pt: 'A Nova sessão não perde o que você preencheu quando a janela muda de tamanho.',
        en: 'New session keeps what you filled in when the window changes size.',
      },
      {
        pt: 'Os avisos de instalar o app e de "como você paga" não voltam a cada recarga depois de fechados.',
        en: 'The install-the-app and "how do you pay" notices no longer come back on every reload once closed.',
      },
    ],
  },
  '2.112.1': {
    features: [
      {
        pt: 'Fechar a Nova sessão sem querer não perde mais o que você preencheu: o app pergunta antes de descartar.',
        en: 'Closing New session by accident no longer loses what you filled in: the app asks before discarding.',
      },
      {
        pt: 'Na Nova sessão, "Não achou? Escolher outra pasta…" fica no fim da lista e abre no disco escolhido.',
        en: 'In New session, "Not here? Choose another folder…" sits at the end of the list and opens on the chosen disk.',
      },
    ],
    fixes: [
      {
        pt: 'Ligar um disco (como o C:) passa a procurar projetos nele na hora, sem ficar em zero.',
        en: 'Switching on a disk (like C:) now searches it for projects right away instead of staying at zero.',
      },
      {
        pt: '"Todos os discos" fica selecionado.',
        en: '"All disks" stays selected.',
      },
      {
        pt: 'O agentistics agora é um app só: a "central" e o modo "membro" saíram das telas e dos comandos.',
        en: 'agentistics is now one app: the "central" and "member" modes are gone from the screens and commands.',
      },
    ],
  },
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
