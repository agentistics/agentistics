export type MobilePushState = { enabled: boolean; supported: boolean; error?: string }

export function isMobileDevice(userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent): boolean {
  return /Android|iPhone|iPad|iPod|Windows Phone|Mobile/i.test(userAgent)
}

export async function getMobilePushState(): Promise<MobilePushState> {
  if (!isMobileDevice() || !('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return { enabled: false, supported: false }
  const registration = await navigator.serviceWorker.ready
  return { enabled: Boolean(await registration.pushManager.getSubscription()), supported: true }
}

export async function setMobilePushEnabled(enabled: boolean): Promise<MobilePushState> {
  if (!isMobileDevice() || !('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return { enabled: false, supported: false }
  const registration = await navigator.serviceWorker.ready
  if (!enabled) {
    const current = await registration.pushManager.getSubscription()
    if (current) {
      await fetch('/api/mobile-push/subscription', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint: current.endpoint }) })
      await current.unsubscribe()
    }
    return { enabled: false, supported: true }
  }
  const permission = await Notification.requestPermission()
  if (permission !== 'granted') throw new Error('Notification permission was not granted')
  const keyResponse = await fetch('/api/mobile-push/vapid')
  if (!keyResponse.ok) throw new Error('Mobile notifications are not configured')
  const { publicKey } = await keyResponse.json() as { publicKey: string }
  const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: decodeKey(publicKey) })
  const json = subscription.toJSON()
  const response = await fetch('/api/mobile-push/subscription', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint: json.endpoint, keys: json.keys, kind: 'mobile', enabled: true }),
  })
  if (!response.ok) throw new Error('Could not save this device')
  return { enabled: true, supported: true }
}

function decodeKey(value: string): ArrayBuffer {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((value.length + 3) % 4)
  const binary = atob(padded)
  return Uint8Array.from(binary, c => c.charCodeAt(0)).buffer as ArrayBuffer
}
