/** The route-level refusal for a persisted own-agent directory that disappeared. */
export function nayWorkingDirConflict(req: Request, folder: unknown, corsHeaders: Record<string, string> = {}): Response {
  const lang = new URL(req.url).searchParams.get('lang') === 'pt' ? 'pt' : 'en'
  const message = lang === 'pt'
    ? `a pasta do agente ${String(folder ?? '')} não existe mais — escolha outra em Configurações → Chat`
    : `the agent folder ${String(folder ?? '')} no longer exists — pick another in Settings → Chat`
  return new Response(JSON.stringify({ ok: false, message }), {
    status: 409,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}
