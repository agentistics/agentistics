/**
 * What a harness card says about setup, in plain words. The server's `setup.note` is English prose
 * written for a terminal reader ("run gh auth login"); people here are not asked to type anything —
 * Install / Sign in are buttons — so the card says that instead, in both languages.
 */
type Lang = 'pt' | 'en'

const NOTES: Record<string, Record<Lang, string>> = {
  copilot: {
    pt: 'Precisa de uma assinatura do GitHub Copilot. Depois de instalar, use o botão Entrar.',
    en: 'Requires a GitHub Copilot subscription. After installing, use the Sign in button.',
  },
  gemini: {
    pt: 'O acesso gratuito foi encerrado para algumas contas e migrou para o Antigravity. Se aparecer um aviso de elegibilidade, confira sua conta pelo link abaixo.',
    en: 'Free-tier access has been discontinued for some accounts and migrated to Antigravity. If you see an eligibility warning, check your account with the link below.',
  },
}

/** The card's note for a harness, or `undefined` when there is nothing worth saying. */
export function harnessSetupNote(id: string, lang: Lang): string | undefined {
  return NOTES[id]?.[lang]
}

/** One sentence pointing at the action itself, for any place that used to print a command. */
export function harnessActionHint(installed: boolean, lang: Lang): string {
  return installed
    ? (lang === 'pt' ? 'Use o botão Entrar em Configurações → Harnesses.' : 'Use the Sign in button in Settings → Harnesses.')
    : (lang === 'pt' ? 'Use o botão Instalar em Configurações → Harnesses.' : 'Use the Install button in Settings → Harnesses.')
}
