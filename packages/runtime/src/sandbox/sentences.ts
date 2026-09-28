/**
 * sandbox/sentences.ts — the four states in plain words, EN and PT (D-T5).
 *
 * The owner decided that the WORDING is part of the deliverable: "a green shield that is not backed
 * by a mechanism is the confident zero of security" (spec §7). So each sentence says what IS
 * contained and what is NOT, and none of them reassures beyond the mechanism behind it. The `none`
 * sentence is the honest floor the owner accepted consciously: with no sandbox the agent reads
 * anything this account can read, reaches the network and runs arbitrary code — one under-caught
 * approval is enough, no malice required — while every write and every shell still goes through the
 * policy (D-T3).
 *
 * `filesystem-only` is in the table although no v1 path produces it: it is reserved for Landlock /
 * bubblewrap (later, per D-T5), and a host that renders the four states must already have its words.
 *
 * Details (which limits apply, why a sandbox is unavailable, whether the network is on) are separate
 * sentences the launcher appends; the table is the part a host can localise by `state` alone.
 */

import type { SandboxState } from '../tools/contract'

export type SandboxLang = 'en' | 'pt'

export const SANDBOX_SENTENCES: Record<SandboxState, { en: string; pt: string }> = {
  none: {
    en:
      'No sandbox. The agent can read anything this account can read, reach the network and run ' +
      'arbitrary code — one approval that slips through is enough, no malice required. Every write and ' +
      'every shell command still goes through the policy.',
    pt:
      'Sem sandbox. O agente pode ler tudo o que esta conta lê, acessar a rede e executar código ' +
      'arbitrário — basta uma aprovação que passe despercebida, sem precisar de má-fé. Toda escrita e ' +
      'todo comando de shell continuam passando pela política.',
  },
  'filesystem-only': {
    en:
      'Filesystem only. Reads and writes are confined to the paths the sandbox allows; the network is ' +
      'NOT restricted, so anything the agent can read can still be sent out. Every write and every shell ' +
      'command still goes through the policy.',
    pt:
      'Só o sistema de arquivos. Leituras e escritas ficam restritas aos caminhos que o sandbox permite; ' +
      'a rede NÃO é restrita, então tudo o que o agente consegue ler ainda pode ser enviado para fora. ' +
      'Toda escrita e todo comando de shell continuam passando pela política.',
  },
  container: {
    en:
      'Full container. Commands run in a Docker container that sees only the workspace, with every ' +
      'capability dropped. The workspace itself is NOT protected: anything in it can be read, changed or ' +
      'deleted. A container shares this machine\'s kernel; it is not a virtual machine. Every write and ' +
      'every shell command still goes through the policy.',
    pt:
      'Contêiner completo. Os comandos rodam num contêiner Docker que só enxerga o workspace, sem ' +
      'nenhuma capability. O workspace em si NÃO fica protegido: tudo nele pode ser lido, alterado ou ' +
      'apagado. Um contêiner compartilha o kernel desta máquina; não é uma máquina virtual. Toda escrita ' +
      'e todo comando de shell continuam passando pela política.',
  },
  unavailable: {
    en: 'A sandbox was requested but is not available on this machine, so it is not in force.',
    pt: 'Um sandbox foi pedido, mas não está disponível nesta máquina, então não está em vigor.',
  },
}
