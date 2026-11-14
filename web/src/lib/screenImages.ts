// Ordered, reliable WebRTC messages carry one bounded PNG at a time.
// Pictures never travel over the control WebSocket, including on HTTP.
const MAX_IMAGE = 16 * 1024 * 1024
const MAX_PIXELS = 3840 * 2160

export class ScreenImageAssembler {
  private buffer: Uint8Array<ArrayBuffer> | null = null
  private sequence = 0
  private offset = 0

  reset() { this.buffer = null; this.offset = 0 }

  push(message: ArrayBuffer): Uint8Array<ArrayBuffer> | null {
    if (message.byteLength < 17 || message.byteLength > 16 * 1024) throw new Error('Invalid HD picture chunk')
    const bytes = new Uint8Array(message)
    if (bytes[0] !== 67 || bytes[1] !== 80 || bytes[2] !== 78 || bytes[3] !== 71) throw new Error('Invalid HD picture header')
    const header = new DataView(message)
    const sequence = header.getUint32(4, true)
    const total = header.getUint32(8, true)
    const offset = header.getUint32(12, true)
    if (total < 33 || total > MAX_IMAGE || offset + bytes.length - 16 > total) throw new Error('HD picture is too large')
    if (offset === 0) {
      if (this.buffer) throw new Error('HD pictures were interleaved')
      this.buffer = new Uint8Array(total)
      this.sequence = sequence
    }
    if (!this.buffer || sequence !== this.sequence || total !== this.buffer.length || offset !== this.offset) throw new Error('HD picture is incomplete')
    this.buffer.set(bytes.subarray(16), offset)
    this.offset += bytes.length - 16
    if (this.offset !== total) return null
    const png = this.buffer
    this.reset()
    const view = new DataView(png.buffer)
    if (view.getUint32(0) !== 0x89504e47 || view.getUint32(4) !== 0x0d0a1a0a || view.getUint32(8) !== 13 || view.getUint32(12) !== 0x49484452) throw new Error('HD picture is not a PNG')
    const width = view.getUint32(16)
    const height = view.getUint32(20)
    if (!width || !height || width > 3840 || height > 3840 || width * height > MAX_PIXELS) throw new Error('HD picture exceeds the pixel limit')
    return png
  }
}
