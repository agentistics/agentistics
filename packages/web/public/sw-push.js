/* Agentistics mobile notifications. */
self.addEventListener('push', event => {
  let data = {}
  try { data = event.data ? event.data.json() : {} } catch { data = {} }
  const title = typeof data.title === 'string' ? data.title : 'Agentistics'
  const options = {
    body: typeof data.body === 'string' ? data.body : 'Uma sessão precisa de você.',
    vibrate: [200, 100, 200], silent: false, tag: `agentistics-session-${data.sessionId || 'event'}`,
    renotify: true, requireInteraction: true,
    data: { sessionId: typeof data.sessionId === 'string' ? data.sessionId : '' },
  }
  event.waitUntil(self.registration.showNotification(title, options))
})

self.addEventListener('notificationclick', event => {
  event.notification.close()
  const sessionId = event.notification.data?.sessionId
  const target = sessionId ? `/sessions/${encodeURIComponent(sessionId)}` : '/sessions'
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
    const existing = clients.find(client => 'focus' in client)
    if (existing) return existing.navigate(target).then(client => client?.focus())
    return self.clients.openWindow(target)
  }))
})
