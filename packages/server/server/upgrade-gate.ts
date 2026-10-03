/**
 * upgrade-gate.ts — PURE. Who may press "update now" in the dashboard, and the sentence each
 * refusal gets.
 *
 * The modal has always PRINTED the command and left the person to open a terminal. Running it from
 * the page is a different kind of act: it downloads a release binary, EXECUTES it, and restarts the
 * service serving the very page that asked. There is nothing more powerful in this product, so the
 * decision is its own module with its own test rather than three conditions inside a route.
 *
 * THE ORDER MATTERS. The capability is checked before anything else, so a central published on the
 * internet answers "this profile has no host power" and never "I am a central" — the refusal that
 * discloses least is the one that goes out first, the same rule `machineOwnedBy` follows when it
 * answers `not-owner` for a machine that does not exist.
 *
 * A CENTRAL IS REFUSED OUTRIGHT, whatever its profile. Its upgrade is a compose rebuild of several
 * minutes against an image, not a binary swap; a button for it on a reachable host is a remote
 * rebuild trigger. The page offers nothing there at all (owner rule: in the UI, updating is the button only).
 *
 * And a machine already on the latest version has NOTHING TO RUN. Without that, the button is a
 * "download a release again" trigger anybody can hold down.
 */

export type UpgradeRefusal = 'no-capability' | 'central' | 'container' | 'up-to-date' | 'busy' | 'not-a-binary'

export type UpgradeDecision =
  | { ok: true; version: string }
  | { ok: false; reason: UpgradeRefusal }

/** Every refusal, in words, in both languages. A code the UI would have to word itself is a code
 *  two surfaces will word differently. */
export const UPGRADE_REFUSALS: Record<UpgradeRefusal, { pt: string; en: string }> = {
  'no-capability': {
    pt: 'Este perfil de exposição não permite que a página rode a atualização nesta máquina.',
    en: 'This exposure profile does not allow the page to run the update on this machine.',
  },
  central: {
    pt: 'Um central se atualiza reconstruindo a imagem no host dele, não trocando um binário pela página.',
    en: 'A central upgrades by rebuilding its image on its host, not by swapping a binary from the page.',
  },
  // A machine run from the published image (docker/machine.yml) runs the compiled `agentop`, so the
  // binary check below would PASS and the upgrade would swap the binary inside the container: gone
  // on the next recreate, and a container quietly running a version its image does not say.
  container: {
    pt: 'Este agentistics roda num contêiner, que se atualiza baixando ou reconstruindo a imagem — não trocando o binário lá dentro.',
    en: 'This agentistics runs in a container, which upgrades by pulling or rebuilding its image — not by swapping the binary inside it.',
  },
  'up-to-date': {
    pt: 'Esta máquina já está na versão mais recente; não há nada para atualizar.',
    en: 'This machine is already on the latest version; there is nothing to upgrade.',
  },
  busy: {
    pt: 'Já existe uma atualização em andamento nesta máquina. Espere ela terminar.',
    en: 'An upgrade is already running on this machine. Wait for it to finish.',
  },
  // DELIBERADAMENTE separada de `no-capability`: num checkout de desenvolvimento o perfil permite
  // rodar comandos, e reusar aquela frase mandaria a pessoa mexer na exposição por um motivo que
  // não existe. Aqui a atualização é `git pull`, não a troca de um binário.
  'not-a-binary': {
    pt: 'Este servidor está rodando a partir do código-fonte, não de um binário instalado, então a página não tem um binário para trocar.',
    en: 'This server is running from source rather than from an installed binary, so the page has no binary to swap.',
  },
}

export function upgradeFromUiDecision(o: {
  /** `CAPS.localShell` — the same gate the shell and the fleet ride. */
  capable: boolean
  central: boolean
  /** `IN_CONTAINER` — the image's runtime stage sets it. */
  container?: boolean
  hasUpdate: boolean
  /** The version `getVersionInfo` named. Blank or absent means nobody could say. */
  latest: string | null | undefined
}): UpgradeDecision {
  if (!o.capable) return { ok: false, reason: 'no-capability' }
  if (o.central) return { ok: false, reason: 'central' }
  if (o.container) return { ok: false, reason: 'container' }
  // A version nobody could name is not an update: running the CLI blind would re-download whatever
  // GitHub calls latest at that instant, which is not what the person read on screen.
  if (!o.hasUpdate || !o.latest) return { ok: false, reason: 'up-to-date' }
  return { ok: true, version: o.latest }
}
