/**
 * content.ts — the data behind the three read-only tabs (Help, Cheat sheet, Contribute).
 *
 * These tabs are content, not behaviour, so they live as plain data and `tabs/Static.tsx` renders
 * any of them. Keeping the text out of the component is what makes both languages cheap and lets
 * the same layout serve three very different bodies.
 *
 * SOURCE OF TRUTH: the argument parsing in `packages/server/bin/cli.ts` — the code, not the `HELP`
 * literal beside it. `--help` prints that literal verbatim and `helpContent()` is the same material
 * restructured into sections, so the two normally read alike; where they have drifted, this file
 * follows what the binary actually does. (They HAVE drifted: `restart <server|watch> --rebuild`
 * rebuilds the native binary from a repo checkout, which HELP still describes as Docker-only.)
 * Nothing in the build will notice either kind of drift, and a help screen that lies is worse than
 * no help screen — every command and flag below was read out of `cli.ts`, not out of memory.
 */

import type { CliLang } from './lang'

export interface ContentRow {
  /**
   * A literal command or flag, rendered in its own aligned column and never translated —
   * it is something the user types.
   */
  cmd?: string
  /** The prose. Localized; may stand alone for rows that are a note rather than a command. */
  text: string
}

export interface ContentSection {
  title: string
  rows: ContentRow[]
}

// ---------------------------------------------------------------------------
// Help — the same material as the HELP literal in packages/server/bin/cli.ts, in sections
// ---------------------------------------------------------------------------

const HELP_EN: ContentSection[] = [
  {
    title: 'Commands',
    rows: [
      { cmd: 'start', text: "Same control center as bare agentop (non-interactive: runs like 'server')" },
      { cmd: 'setup', text: 'Interactive first-run wizard (solo / central / member)' },
      { cmd: 'server', text: 'Start the web dashboard + background daemon (non-interactive)' },
      { text: 'add --central to run the team central natively (no Docker); --bg to detach' },
      { cmd: 'restart', text: "Restart a running mode's service so it picks up new code/config" },
      { cmd: 'status', text: 'Show services (server/central/member) + health' },
      { cmd: 'tui', text: 'Alias for `start` — the metrics are the Dashboard screen of this app' },
      { cmd: 'watch', text: 'Start the background metrics daemon only' },
      { cmd: 'central', text: 'Manage the team central (Docker; runs from anywhere)' },
      { cmd: 'member', text: 'Configure this machine as a team member' },
      { cmd: 'ci-push', text: "One-shot push of a CI runner's metrics to a central" },
      { cmd: 'upgrade', text: 'Upgrade agentop to the latest version' },
      { cmd: 'autostart', text: 'Start a mode with the system (systemd user service on Linux)' },
      { cmd: 'check-update', text: 'Print a notice if a newer version is available (else silent)' },
      { text: 'a release marked [critical] says so louder — auto-install is opt-in' },
    ],
  },
  {
    title: 'Options',
    rows: [
      { cmd: '--help, -h', text: 'Show the plain help text' },
      { cmd: '--version, -v', text: 'Show the current version' },
      { cmd: '--port <n>', text: 'Port for the api + mcp server (default: 47291) — server only' },
      { text: 'the dashboard is served on that port + 1, so --port 4000 opens on 4001' },
      { cmd: '--central', text: 'Run as the team central natively, no Docker — server only' },
      { text: 'reads central.env for MONGO_URL + secrets; needs an external MONGO_URL' },
      { cmd: '--bg', text: 'Start detached in the background, logs to ~/.agentistics — server only' },
    ],
  },
  {
    title: 'Control center',
    rows: [
      { cmd: 'agentop', text: '(on a terminal)' },
      { cmd: 'agentop start', text: '' },
      { text: "One full-screen application, in the terminal's alternate buffer — it adds nothing to your scrollback." },
      { text: 'Screens: Services (start/stop/restart this machine, a central or the Docker machine; turn boot on or off; and the SETUP wizard — solo / central / member, the history-preservation consent, connecting to or leaving a central — reached from the config pane\'s mode row), Sessions (the fleet running right now), Dashboard (the metrics — 1-6 or tab to change screen, `f` filters by assistant, `,`/`.` page a list), Logs, Cheat sheet, Help, Contribute.' },
      { text: 'Picking "foreground" closes it and starts the server in this terminal. Non-interactive stdin runs like `agentop server`.' },
    ],
  },
  {
    // Two `n/m` pairs can be on screen at once, counting different things, and neither said so.
    // A machine reading `ram 4/18` in the header above `5 on screen · 29 known` in the list looked
    // like it was contradicting itself about how many sessions were open.
    title: 'The two counters in the header',
    rows: [
      { cmd: '⏳ n', text: 'Sessions BLOCKED ON YOU right now — waiting for an answer or an approval. It is why this application is open, so it survives a narrow terminal after everything else has been dropped.' },
      { cmd: 'ram n/m', text: 'The parallel-sessions budget: assistant PROCESSES alive, out of how many this machine has the MEMORY to hold. `m` grows and shrinks with free RAM and turns red as you approach it. It is not the same count as the sessions list, and is not meant to be: a background agent is a live process sharing its parent session\u2019s directory, so it costs memory here and has no row of its own there.' },
      { text: 'The sessions list has its own pair, and it counts something else again: `5 on screen · 29 known` means the view is drawing 5 of the 29 sessions this machine has any record of — the rest are closed, lost or withheld by the filter named to its left.' },
      { cmd: 'usage', text: "A row's token figure is EVERY billed counter: fresh input + output + cache read + cache write. Cache read is usually most of it — the conversation re-read on every turn, at roughly a tenth the price of fresh input — which is why a long session reads in the millions. The dashboard's Costs page breaks the four apart." },
    ],
  },
  {
    title: 'Restart',
    rows: [
      { cmd: 'agentop restart', text: '[server|watch|central|--all] [--rebuild]' },
      { text: 'Restart a running mode so it picks up new code (after an upgrade or pull) or config. With no argument it restarts server.' },
      { text: 'server and watch bounce the systemd user service; central restarts its container.' },
      { cmd: '--all', text: 'bounce every service currently up (local + central + machine), non-interactively' },
      { cmd: '--rebuild', text: 'rebuild before restarting, instead of just bouncing' },
      { text: 'central and machine: recreate the Docker image/container. server and watch: rebuild and reinstall the native binary (`bun run bin`), which needs the repo checkout — outside one the rebuild is refused and `agentop upgrade` is the way to get new code.' },
    ],
  },
  {
    title: 'Setup',
    rows: [
      { cmd: 'agentop setup', text: '' },
      { text: 'Interactive wizard: pick solo, host a central, or join one as a member.' },
      { text: "The control center's Setup screen asks the same questions." },
    ],
  },
  {
    title: 'Central',
    rows: [
      { cmd: 'agentop central', text: '<up|init|down|logs|status|restart|pull>' },
      { text: 'Manage the team central via Docker. In a repo checkout it uses central.sh; from the standalone binary it pulls the published image (ghcr.io/blpsoares/agentistics) and materializes a compose in ~/.agentistics/central — no clone required.' },
    ],
  },
  {
    title: 'Member',
    rows: [
      { cmd: 'agentop member connect', text: '--endpoint <url> --token <token> [--org <org>]' },
      { text: 'Verify the token against the central and save this machine as a member.' },
      { cmd: 'agentop member leave', text: 'Notify the central and reset back to solo.' },
      { cmd: 'agentop member status', text: 'Show the current mode/endpoint/user and the last sync state.' },
    ],
  },
  {
    title: 'CI (GitHub Actions)',
    rows: [
      { cmd: 'agentop ci-push', text: '[--endpoint <url>] [--token <ci-token>] [--org <org>]' },
      { text: "One-shot push of this runner's metrics to a central. Prefers keyless GitHub OIDC (needs permissions: id-token: write); falls back to a static token." },
      { text: 'Reads AGENTISTICS_CENTRAL_URL / AGENTISTICS_CI_TOKEN / AGENTISTICS_OIDC_AUDIENCE / AGENTISTICS_TEAM_ORG when the flags are omitted. Never fails the job on a push error.' },
    ],
  },
  {
    title: 'Updates',
    rows: [
      { cmd: 'agentop upgrade', text: '' },
      { text: 'Download the latest binary and restart whatever services are running. Only installs a release published for this platform/arch, and verifies the download (size, executable magic and the new binary\'s own --version) before swapping it in.' },
      { text: 'Keeps the previous binary at <binary>.bak and restores it if anything fails. Exits non-zero when the install was refused or rolled back, or a service could not be restarted onto the new version.' },
      { cmd: 'agentop check-update', text: '' },
      { text: 'Silent when up to date. Answers from ~/.agentistics/version-cache.json and refreshes it in a detached process, so it never delays a shell prompt.' },
      { text: 'An optional update prints a banner; a critical one (its GitHub release notes carry a "[critical]" line outside code fences) prints a louder one telling you to run `agentop upgrade`.' },
      { text: 'Unattended install is opt-in: set AGENTISTICS_AUTO_UPGRADE=1 to let a critical release install itself in the background, logged to ~/.agentistics/auto-upgrade.log.' },
    ],
  },
  {
    title: 'Autostart',
    rows: [
      { cmd: 'agentop autostart', text: '<mode> <enable|disable|status>   mode ∈ { server, central, watch }' },
      { cmd: 'enable', text: 'register + start the service at boot (also adds a terminal update-check hook to ~/.bashrc)' },
      { cmd: 'disable', text: 'stop and remove the service' },
      { cmd: 'status', text: 'show enabled/active state — omit the mode to list all' },
    ],
  },
  {
    title: 'Native central (no Docker)',
    rows: [
      { cmd: 'agentop server --central', text: '[--bg] [--port <n>]' },
      { text: 'Runs the same server process with AGENTISTICS_TEAM_CENTRAL=1, loading central.env (searched as $AGENTISTICS_CENTRAL_ENV, ./central.env, ~/.agentistics/central.env).' },
      { text: 'There is no bundled Mongo — set MONGO_URL to an external cluster. Use --bg to run in the background like the local server.' },
      { text: 'For the all-in-one Docker flow with a bundled Mongo, use `agentop central up`.' },
    ],
  },
]

const HELP_PT: ContentSection[] = [
  {
    title: 'Comandos',
    rows: [
      { cmd: 'start', text: "O mesmo control center do agentop sem argumentos (não interativo: roda como 'server')" },
      { cmd: 'setup', text: 'Assistente de primeira execução (solo / central / member)' },
      { cmd: 'server', text: 'Sobe o dashboard web + o daemon em background (não interativo)' },
      { text: 'use --central para rodar a central nativamente (sem Docker); --bg para desanexar' },
      { cmd: 'restart', text: 'Reinicia o serviço do modo em execução para pegar código/config novos' },
      { cmd: 'status', text: 'Mostra os serviços (server/central/member) + a saúde' },
      { cmd: 'tui', text: 'Apelido de `start` — as métricas são a tela Dashboard deste app' },
      { cmd: 'watch', text: 'Sobe apenas o daemon de métricas em background' },
      { cmd: 'central', text: 'Gerencia a central do time (Docker; roda de qualquer lugar)' },
      { cmd: 'member', text: 'Configura esta máquina como membro de um time' },
      { cmd: 'ci-push', text: 'Envio único das métricas de um runner de CI para uma central' },
      { cmd: 'upgrade', text: 'Atualiza o agentop para a última versão' },
      { cmd: 'autostart', text: 'Inicia um modo junto com o sistema (serviço systemd de usuário no Linux)' },
      { cmd: 'check-update', text: 'Avisa se existe versão nova (caso contrário, fica em silêncio)' },
      { text: 'uma release marcada como [critical] avisa mais alto — a instalação automática é opt-in' },
    ],
  },
  {
    title: 'Opções',
    rows: [
      { cmd: '--help, -h', text: 'Mostra o texto de ajuda puro' },
      { cmd: '--version, -v', text: 'Mostra a versão atual' },
      { cmd: '--port <n>', text: 'Porta do servidor de api + mcp (padrão: 47291) — só no server' },
      { text: 'o dashboard sobe nessa porta + 1, então --port 4000 abre na 4001' },
      { cmd: '--central', text: 'Roda como central do time nativamente, sem Docker — só no server' },
      { text: 'lê o central.env com MONGO_URL + segredos; exige um MONGO_URL externo' },
      { cmd: '--bg', text: 'Sobe desanexado em background, com log em ~/.agentistics — só no server' },
    ],
  },
  {
    title: 'Control center',
    rows: [
      { cmd: 'agentop', text: '(num terminal)' },
      { cmd: 'agentop start', text: '' },
      { text: 'Uma única aplicação em tela cheia, no buffer alternativo do terminal — ela não deixa nada no seu scrollback.' },
      { text: 'Telas: Serviços (subir/parar/reiniciar esta máquina, uma central ou a máquina em Docker; ligar ou desligar o boot; e o assistente de SETUP — solo / central / member, o consentimento de preservação do histórico, conectar ou sair de uma central — aberto pela linha de modo no painel de config), Sessões (a frota rodando agora), Dashboard (as métricas — 1-6 ou tab troca de tela, `f` filtra por assistente, `,`/`.` pagina uma lista), Logs, Comandos, Ajuda, Contribuir.' },
      { text: 'Escolher "foreground" fecha a tela e sobe o servidor neste terminal. Com stdin não interativo, roda como `agentop server`.' },
    ],
  },
  {
    title: 'Os dois contadores do cabeçalho',
    rows: [
      { cmd: '⏳ n', text: 'Sessões PARADAS ESPERANDO VOCÊ agora — uma resposta ou uma aprovação. É o motivo de esta tela estar aberta, então sobrevive a um terminal estreito depois que todo o resto já foi descartado.' },
      { cmd: 'ram n/m', text: 'O orçamento de sessões em paralelo: PROCESSOS de assistente vivos, sobre quantos esta máquina tem MEMÓRIA para segurar. O `m` sobe e desce com a RAM livre e fica vermelho quando você se aproxima dele. Não é a mesma contagem da lista de sessões, e não deveria ser: um agente em background é um processo vivo que compartilha o diretório da sessão que o criou, então custa memória aqui e não tem linha própria lá.' },
      { text: 'A lista de sessões tem o par dela, e conta outra coisa ainda: `5 na tela · 29 conhecidas` quer dizer que a visão está desenhando 5 das 29 sessões de que esta máquina tem qualquer registro — o resto está fechado, perdido ou retido pelo filtro nomeado à esquerda.' },
      { cmd: 'uso', text: 'O número de tokens de uma linha é TODOS os contadores cobrados: entrada nova + saída + leitura + escrita de cache. A leitura de cache costuma ser a maior parte — a conversa relida a cada turno, a cerca de um décimo do preço da entrada nova — e é por isso que uma sessão longa aparece na casa dos milhões. A página de Custos do dashboard separa os quatro.' },
    ],
  },
  {
    title: 'Restart',
    rows: [
      { cmd: 'agentop restart', text: '[server|watch|central|--all] [--rebuild]' },
      { text: 'Reinicia um modo em execução para ele pegar código novo (depois de um upgrade ou pull) ou config nova. Sem argumento, reinicia o server.' },
      { text: 'server e watch reiniciam o serviço systemd; central reinicia o container dela.' },
      { cmd: '--all', text: 'reinicia todos os serviços no ar (local + central + máquina), sem interação' },
      { cmd: '--rebuild', text: 'reconstrói antes de reiniciar, em vez de só reiniciar' },
      { text: 'central e máquina: recria a imagem/container Docker. server e watch: reconstrói e reinstala o binário nativo (`bun run bin`), o que exige o checkout do repositório — fora dele a reconstrução é recusada e `agentop upgrade` é o caminho para pegar código novo.' },
    ],
  },
  {
    title: 'Setup',
    rows: [
      { cmd: 'agentop setup', text: '' },
      { text: 'Assistente interativo: escolher solo, hospedar uma central ou entrar em uma como membro.' },
      { text: 'A tela Setup do control center faz as mesmas perguntas.' },
    ],
  },
  {
    title: 'Central',
    rows: [
      { cmd: 'agentop central', text: '<up|init|down|logs|status|restart|pull>' },
      { text: 'Gerencia a central do time via Docker. Num checkout do repositório usa o central.sh; a partir do binário avulso baixa a imagem publicada (ghcr.io/blpsoares/agentistics) e materializa um compose em ~/.agentistics/central — sem precisar clonar nada.' },
    ],
  },
  {
    title: 'Member',
    rows: [
      { cmd: 'agentop member connect', text: '--endpoint <url> --token <token> [--org <org>]' },
      { text: 'Valida o token na central e salva esta máquina como membro.' },
      { cmd: 'agentop member leave', text: 'Avisa a central e volta esta máquina para solo.' },
      { cmd: 'agentop member status', text: 'Mostra modo/endpoint/usuário atuais e o último estado de sincronização.' },
    ],
  },
  {
    title: 'CI (GitHub Actions)',
    rows: [
      { cmd: 'agentop ci-push', text: '[--endpoint <url>] [--token <ci-token>] [--org <org>]' },
      { text: 'Envio único das métricas deste runner para uma central. Prefere OIDC do GitHub, sem chave (precisa de permissions: id-token: write); cai para um token estático.' },
      { text: 'Lê AGENTISTICS_CENTRAL_URL / AGENTISTICS_CI_TOKEN / AGENTISTICS_OIDC_AUDIENCE / AGENTISTICS_TEAM_ORG quando as flags são omitidas. Nunca quebra o job por erro no envio.' },
    ],
  },
  {
    title: 'Atualizações',
    rows: [
      { cmd: 'agentop upgrade', text: '' },
      { text: 'Baixa o binário mais novo e reinicia os serviços que estiverem rodando. Só instala uma release publicada para esta plataforma/arquitetura e verifica o download (tamanho, magic de executável e o --version do próprio binário novo) antes de trocar.' },
      { text: 'Guarda o binário anterior em <binário>.bak e o restaura se algo falhar. Sai com código diferente de zero quando a instalação foi recusada ou revertida, ou quando um serviço não voltou na versão nova.' },
      { cmd: 'agentop check-update', text: '' },
      { text: 'Silencioso quando está atualizado. Responde a partir de ~/.agentistics/version-cache.json e atualiza esse cache num processo desanexado, então nunca atrasa o prompt do shell.' },
      { text: 'Uma atualização opcional imprime um banner; uma crítica (as notas da release no GitHub têm uma linha "[critical]" fora de blocos de código) imprime um mais forte pedindo para rodar `agentop upgrade`.' },
      { text: 'Instalar sozinho é opt-in: defina AGENTISTICS_AUTO_UPGRADE=1 para uma release crítica se instalar em background, com log em ~/.agentistics/auto-upgrade.log.' },
    ],
  },
  {
    title: 'Autostart',
    rows: [
      { cmd: 'agentop autostart', text: '<modo> <enable|disable|status>   modo ∈ { server, central, watch }' },
      { cmd: 'enable', text: 'registra + inicia o serviço no boot (e adiciona um hook de checagem de versão ao ~/.bashrc)' },
      { cmd: 'disable', text: 'para e remove o serviço' },
      { cmd: 'status', text: 'mostra se está habilitado/ativo — omita o modo para listar todos' },
    ],
  },
  {
    title: 'Central nativa (sem Docker)',
    rows: [
      { cmd: 'agentop server --central', text: '[--bg] [--port <n>]' },
      { text: 'Roda o mesmo processo de servidor com AGENTISTICS_TEAM_CENTRAL=1, carregando o central.env (procurado em $AGENTISTICS_CENTRAL_ENV, ./central.env, ~/.agentistics/central.env).' },
      { text: 'Não há Mongo embutido — aponte MONGO_URL para um cluster externo. Use --bg para rodar em background como o servidor local.' },
      { text: 'Para o fluxo Docker completo, com Mongo embutido, use `agentop central up`.' },
    ],
  },
]

// ---------------------------------------------------------------------------
// Cheat sheet — the subset worth memorising
// ---------------------------------------------------------------------------

const CHEAT_EN: ContentSection[] = [
  {
    title: 'Run',
    rows: [
      { cmd: 'agentop', text: 'open this control center — metrics are its Dashboard screen' },
      { cmd: 'agentop server', text: 'dashboard + daemon, in this terminal' },
      { cmd: 'agentop server --bg', text: 'same, detached — logs to ~/.agentistics' },
      { cmd: 'agentop server --port 4000', text: 'another port — dashboard on 4001' },
      { cmd: 'agentop watch', text: 'metrics daemon only, headless' },
    ],
  },
  {
    title: 'Team',
    rows: [
      { cmd: 'agentop central up', text: 'start the team central (Docker, port 48080)' },
      { cmd: 'agentop central logs', text: "follow the central's container logs" },
      { cmd: 'agentop member connect --endpoint <url> --token <token>', text: 'join a central' },
      { cmd: 'agentop member status', text: 'mode, endpoint, user and last sync' },
      { cmd: 'agentop member leave', text: 'reset this machine back to solo' },
    ],
  },
  {
    title: 'Sessions',
    rows: [
      { cmd: 'agentop session claude --bg -p "fix the tests"', text: 'start a background session' },
      { cmd: 'agentop session list', text: 'see what is running' },
      { cmd: 'agentop session attach <id|name>', text: "take over a session's terminal" },
      { cmd: 'agentop session kill <id|name>', text: 'stop a session' },
    ],
  },
  {
    title: 'Maintain',
    rows: [
      { cmd: 'agentop upgrade', text: 'install the latest release and restart what was running' },
      { cmd: 'agentop restart --all', text: 'bounce every service currently up' },
      { cmd: 'agentop restart --all --rebuild', text: 'same, rebuilding first (images, and the binary in a checkout)' },
      { cmd: 'agentop autostart server enable', text: 'start the server on every boot' },
    ],
  },
  {
    title: 'Diagnose',
    rows: [
      { cmd: 'agentop status', text: 'mode, services and health at a glance' },
      { cmd: 'agentop central status', text: 'the central containers only' },
      { cmd: 'agentop check-update', text: 'silent unless a newer release exists' },
      { cmd: 'agentop --version', text: 'the version this binary is' },
    ],
  },
]

const CHEAT_PT: ContentSection[] = [
  {
    title: 'Rodar',
    rows: [
      { cmd: 'agentop', text: 'abre este centro de controle — as métricas são a tela Dashboard' },
      { cmd: 'agentop server', text: 'dashboard + daemon, neste terminal' },
      { cmd: 'agentop server --bg', text: 'o mesmo, desanexado — log em ~/.agentistics' },
      { cmd: 'agentop server --port 4000', text: 'outra porta — dashboard na 4001' },
      { cmd: 'agentop watch', text: 'só o daemon de métricas, sem interface' },
    ],
  },
  {
    title: 'Time',
    rows: [
      { cmd: 'agentop central up', text: 'sobe a central do time (Docker, porta 48080)' },
      { cmd: 'agentop central logs', text: 'acompanha os logs do container da central' },
      { cmd: 'agentop member connect --endpoint <url> --token <token>', text: 'entra numa central' },
      { cmd: 'agentop member status', text: 'modo, endpoint, usuário e última sincronização' },
      { cmd: 'agentop member leave', text: 'devolve esta máquina para o modo solo' },
    ],
  },
  {
    title: 'Sessões',
    rows: [
      { cmd: 'agentop session claude --bg -p "fix the tests"', text: 'inicia uma sessão em background' },
      { cmd: 'agentop session list', text: 'mostra o que está rodando' },
      { cmd: 'agentop session attach <id|name>', text: 'assume o terminal de uma sessão' },
      { cmd: 'agentop session kill <id|name>', text: 'encerra uma sessão' },
    ],
  },
  {
    title: 'Manter',
    rows: [
      { cmd: 'agentop upgrade', text: 'instala a última release e reinicia o que estava rodando' },
      { cmd: 'agentop restart --all', text: 'reinicia todos os serviços no ar' },
      { cmd: 'agentop restart --all --rebuild', text: 'o mesmo, reconstruindo antes (imagens, e o binário num checkout)' },
      { cmd: 'agentop autostart server enable', text: 'sobe o servidor a cada boot' },
    ],
  },
  {
    title: 'Diagnosticar',
    rows: [
      { cmd: 'agentop status', text: 'modo, serviços e saúde de uma vez' },
      { cmd: 'agentop central status', text: 'apenas os containers da central' },
      { cmd: 'agentop check-update', text: 'silencioso, a menos que exista release nova' },
      { cmd: 'agentop --version', text: 'a versão deste binário' },
    ],
  },
]

// ---------------------------------------------------------------------------
// Contribute — every fact below was read out of the repository, not assumed
// ---------------------------------------------------------------------------

const REPO_URL = 'https://github.com/blpsoares/agentistics'
const ISSUES_URL = `${REPO_URL}/issues`
const BUG_TEMPLATE_URL = `${REPO_URL}/issues/new?template=bug_report.yml`

const CONTRIBUTE_EN: ContentSection[] = [
  {
    title: 'Repository',
    rows: [
      { cmd: REPO_URL, text: '' },
      { text: 'MIT licensed, © 2026 blpsoares — see LICENSE in the repository root.' },
    ],
  },
  {
    title: 'Run from a checkout',
    rows: [
      { cmd: `git clone ${REPO_URL}.git`, text: '' },
      { cmd: 'bun install', text: 'install the workspace (Bun only — Node is not required)' },
      { cmd: 'bun run dev', text: 'api on 47291 + the Vite UI on 47292, with hot reload' },
      { cmd: 'bun run watch:cli', text: 'the terminal dashboard against your own data' },
      { cmd: 'bun test', text: 'the unit tests over the pure functions' },
      { cmd: 'bun run bin', text: 'compile the binary and install it into ~/.local/bin' },
    ],
  },
  {
    title: 'Issues and pull requests',
    rows: [
      { cmd: ISSUES_URL, text: 'bugs, questions and feature requests' },
      { cmd: BUG_TEMPLATE_URL, text: 'the bug template — include your install method and version' },
      { text: 'CONTRIBUTING.md covers the development setup and the commit convention (Conventional Commits, enforced by commitlint).' },
    ],
  },
  {
    title: 'Docs',
    rows: [
      { cmd: 'docs/cli.md', text: 'every command, in full' },
      { cmd: 'docs/architecture.md', text: 'how the pieces fit, including team mode' },
      { cmd: 'docs/data-sources.md', text: 'what is read from each assistant, and what is not' },
      { cmd: 'docs/metrics.md', text: 'how each number is computed' },
      { cmd: 'docs/github-actions.md', text: 'pushing CI runs to a central' },
      { cmd: 'docs/mcp.md', text: 'the MCP server and its tools' },
      { cmd: 'docs/opentelemetry.md', text: 'exporting metrics over OTLP' },
    ],
  },
]

const CONTRIBUTE_PT: ContentSection[] = [
  {
    title: 'Repositório',
    rows: [
      { cmd: REPO_URL, text: '' },
      { text: 'Licença MIT, © 2026 blpsoares — veja o LICENSE na raiz do repositório.' },
    ],
  },
  {
    title: 'Rodar a partir de um checkout',
    rows: [
      { cmd: `git clone ${REPO_URL}.git`, text: '' },
      { cmd: 'bun install', text: 'instala o workspace (só Bun — Node não é necessário)' },
      { cmd: 'bun run dev', text: 'api na 47291 + a UI do Vite na 47292, com hot reload' },
      { cmd: 'bun run watch:cli', text: 'o dashboard de terminal com os seus próprios dados' },
      { cmd: 'bun test', text: 'os testes unitários das funções puras' },
      { cmd: 'bun run bin', text: 'compila o binário e o instala em ~/.local/bin' },
    ],
  },
  {
    title: 'Issues e pull requests',
    rows: [
      { cmd: ISSUES_URL, text: 'bugs, dúvidas e pedidos de funcionalidade' },
      { cmd: BUG_TEMPLATE_URL, text: 'o template de bug — informe a forma de instalação e a versão' },
      { text: 'O CONTRIBUTING.md cobre o ambiente de desenvolvimento e a convenção de commits (Conventional Commits, validada pelo commitlint).' },
    ],
  },
  {
    title: 'Documentação',
    rows: [
      { cmd: 'docs/cli.md', text: 'todos os comandos, por extenso' },
      { cmd: 'docs/architecture.md', text: 'como as peças se encaixam, inclusive o modo time' },
      { cmd: 'docs/data-sources.md', text: 'o que é lido de cada assistente, e o que não é' },
      { cmd: 'docs/metrics.md', text: 'como cada número é calculado' },
      { cmd: 'docs/github-actions.md', text: 'enviar execuções de CI para uma central' },
      { cmd: 'docs/mcp.md', text: 'o servidor MCP e suas ferramentas' },
      { cmd: 'docs/opentelemetry.md', text: 'exportar métricas via OTLP' },
    ],
  },
]

const pick = <T,>(lang: CliLang, en: T, pt: T): T => (lang === 'pt' ? pt : en)

export function helpContent(lang: CliLang): ContentSection[] {
  return pick(lang, HELP_EN, HELP_PT)
}

export function cheatContent(lang: CliLang): ContentSection[] {
  return pick(lang, CHEAT_EN, CHEAT_PT)
}

export function contributeContent(lang: CliLang): ContentSection[] {
  return pick(lang, CONTRIBUTE_EN, CONTRIBUTE_PT)
}
