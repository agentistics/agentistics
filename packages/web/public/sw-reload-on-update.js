// Pulled into the generated service worker (workbox `importScripts`).
//
// A page controlled by an OLDER worker is served that worker's precached shell, so the first
// navigation after an upgrade lands on the OLD bundle — and an old bundle cannot heal itself (it has
// no such code). The new worker installs behind it and, with skipWaiting + clientsClaim, takes over —
// but nothing reloads the page that is already open. The page's update state machine owns that
// navigation: it keeps its overlay up, verifies /api/version and the new shell, then swaps once.
// Navigating here as well created the visible blink and raced the overlay.
let replacedAnotherWorker = false
self.addEventListener('install', () => { replacedAnotherWorker = !!self.registration.active })
self.addEventListener('activate', (event) => {
  if (!replacedAnotherWorker) return
  event.waitUntil(
    self.clients.claim(),
  )
})
