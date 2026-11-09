export class FakeSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  static all: FakeSocket[] = []

  readyState = FakeSocket.CONNECTING
  binaryType = ''
  bufferedAmount = 0
  sent: Record<string, unknown>[] = []
  binary: ArrayBuffer[] = []
  acceptDeckSaves = false
  deckRevision = 0
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onerror: (() => void) | null = null

  constructor(readonly url: string) {
    FakeSocket.all.push(this)
  }
  send(data: unknown) {
    if (typeof data === 'string') {
      const message = JSON.parse(data)
      this.sent.push(message)
      if (this.acceptDeckSaves && message.t === 'deckSave') {
        const revision = ++this.deckRevision
        this.receive({ t: 'deck', deck: message.deck, revision })
        this.receive({ t: 'deckSaved', id: message.id, ok: true, revision })
      }
    }
    else if (data instanceof ArrayBuffer) this.binary.push(data)
  }
  close() {
    this.readyState = FakeSocket.CLOSING
  }
  open() {
    this.readyState = FakeSocket.OPEN
    this.onopen?.()
  }
  receive(message: object) {
    this.onmessage?.({ data: JSON.stringify(message) })
  }
  drop() {
    this.readyState = FakeSocket.CLOSED
    this.onclose?.()
  }
}

export const welcome = {
  t: 'welcome',
  v: 1,
  host: { name: 'Mac', version: '1.0', os: 'macOS' },
  sessionKey: 'k',
  features: { voice: false, shell: false, secure: false, permission: true },
  deck: { version: 1, pages: [] },
  paused: false,
}

export const lastSocket = () => FakeSocket.all.at(-1)!
