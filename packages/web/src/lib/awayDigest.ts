export async function answerAwayDigest(answer: 'yes' | 'no', bucket: unknown, since: unknown, lang: 'pt' | 'en'): Promise<{ ok: boolean; conversationId?: string; status: number }> {
  const response = await fetch('/api/away/digest/answer', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ answer, bucket, since, lang }),
  })
  const body = await response.json().catch(() => ({})) as { conversationId?: string }
  return { conversationId: body.conversationId, ok: response.ok, status: response.status }
}
