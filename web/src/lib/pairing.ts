// The one-time code from a pairing QR link (…/#pair=CODE). Read once at
// startup, before anything connects, and dropped from the address bar and
// history so a reload or a shared link can't reuse it.

function read(): string | null {
  if (typeof location === 'undefined') return null
  const match = /[#&]pair=([\w-]+)/.exec(location.hash)
  if (!match) return null
  history.replaceState(null, '', location.pathname + location.search)
  return match[1]!
}

let code = read()

/** Whether the page was opened from a pairing link. */
export const pairingLink = code !== null

/** The pairing code, the first time it is asked for; null afterwards. */
export function takePairingCode(): string | null {
  const value = code
  code = null
  return value
}
