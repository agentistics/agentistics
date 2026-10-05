// Pulled into the generated service worker (workbox `importScripts`).
//
// A page controlled by an OLDER worker is served that worker's precached shell, so the first
// navigation after an upgrade lands on the OLD bundle — and an old bundle cannot heal itself (it has
// no such code). The new worker installs behind it and, with skipWaiting + clientsClaim, takes over —
// but nothing reloads the page that is already open, so it kept running the old bundle until the next
// manual navigation (reproduced 2026-10-04 with real Chrome and a persistent profile; a timing race
// in Chromium hid it). When a worker activates AFTER replacing another one, it reloads the open
// windows itself. A first-ever install has no previous worker and reloads nothing.
let replacedAnotherWorker = false
self.addEventListener('install', () => { replacedAnotherWorker = !!self.registration.active })
self.addEventListener('activate', (event) => {
  if (!replacedAnotherWorker) return
  event.waitUntil(
    // CLAIM first: `client.navigate()` only works on a window this worker controls, and at activation
    // the open page is still controlled by the OLD worker — navigate() rejected there, silently.
    self.clients.claim()
      .then(() => self.clients.matchAll({ type: 'window', includeUncontrolled: true }))
      // Start the navigations, do NOT wait for them: a navigation's own fetch cannot be handled until
      // this activation has finished, so awaiting it inside waitUntil is a deadlock (measured: the
      // page never reloaded).
      .then((windows) => { for (const w of windows) w.navigate(w.url).catch(() => {}) }),
  )
})
