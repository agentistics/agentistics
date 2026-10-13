export type MobilePushState = { enabled: boolean; supported: boolean; error?: string }

export function mobilePushFailureMessage(status: number, detail: string | undefined, pt: boolean): string {
  const locked = /vault|cofre|unlock|desbloque/i.test(detail ?? '')
  if (locked) return pt
    ? 'As notificações do celular estão temporariamente indisponíveis porque o cofre está bloqueado. Tente novamente.'
    : 'Mobile notifications are temporarily unavailable because the vault is locked. Try again.'
  if (status >= 500) return pt
    ? 'O servidor não conseguiu preparar as notificações do celular. Tente novamente.'
    : 'The server could not prepare mobile notifications. Try again.'
  return pt
    ? 'Não foi possível ativar as notificações neste aparelho. Verifique a conexão e tente novamente.'
    : 'Could not enable notifications on this device. Check the connection and try again.'
}

export class MobilePushError extends Error {
  constructor(readonly status: number, readonly detail?: string) { super('mobile-push-failed') }
}

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
  if (!keyResponse.ok) {
    let detail: string | undefined
    try { detail = (await keyResponse.json() as { error?: unknown }).error as string | undefined } catch { /* non-JSON response */ }
    throw new MobilePushError(keyResponse.status, detail)
  }
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
