export async function answerAwayDigest(answer: 'yes' | 'no', bucket: unknown, lang: 'pt' | 'en'): Promise<{ ok: boolean; conversationId?: string }> {
  const response = await fetch('/api/away/digest/answer', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ answer, bucket, lang }),
  })
  return { ok: response.ok, ...(await response.json().catch(() => ({})) as { conversationId?: string }) }
}
