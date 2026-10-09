import type { DeviceInfo } from './protocol'
import { settings } from './settings'

const ID_KEY = 'cmdpalm.deviceId'
const TOKEN_KEY = 'cmdpalm.token'

function randomId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  // randomUUID needs a secure context; plain HTTP on a LAN address is not one.
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function safeSet(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  } catch {
    // Storage unavailable (private mode); pairing lasts for this session.
  }
}

let memoryId: string | null = null

export function deviceId(): string {
  const stored = safeGet(ID_KEY) ?? memoryId
  if (stored) return stored
  const id = randomId()
  memoryId = id
  safeSet(ID_KEY, id)
  return id
}

export function deviceModel(): string {
  const ua = navigator.userAgent
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'iPad'
  if (/iPhone/.test(ua)) return 'iPhone'
  if (/iPod/.test(ua)) return 'iPod touch'
  if (/Android/.test(ua)) return /Mobile/.test(ua) ? 'Android phone' : 'Android tablet'
  if (/Windows/.test(ua)) return 'Windows PC'
  if (/Macintosh/.test(ua)) return 'Mac'
  return 'Browser'
}

export function deviceInfo(): DeviceInfo {
  const model = deviceModel()
  return { id: deviceId(), name: settings.deviceName.trim() || model, model }
}

export function isTablet(): boolean {
  const model = deviceModel()
  return model === 'iPad' || model === 'Android tablet' || Math.min(screen.width, screen.height) >= 700
}

export const token = {
  get: (): string | null => safeGet(TOKEN_KEY),
  set: (value: string | null) => safeSet(TOKEN_KEY, value),
}
