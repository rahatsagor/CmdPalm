// Ordered, reliable WebRTC messages carry one bounded lossless PNG (full frame
// or dirty-rect patch) at a time. Pictures never travel over the control WebSocket.
const MAX_IMAGE = 16 * 1024 * 1024
const MAX_PIXELS = 3840 * 2160

export type ScreenImageFrame =
  | { kind: 'full'; png: Uint8Array<ArrayBuffer>; width: number; height: number }
  | { kind: 'patch'; png: Uint8Array<ArrayBuffer>; x: number; y: number; width: number; height: number; fullWidth: number; fullHeight: number }

function parsePngDimensions(png: Uint8Array<ArrayBuffer>) {
  if (png.byteLength < 33) throw new Error('HD picture is not a PNG')
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength)
  if (view.getUint32(0) !== 0x89504e47 || view.getUint32(4) !== 0x0d0a1a0a || view.getUint32(8) !== 13 || view.getUint32(12) !== 0x49484452) {
    throw new Error('HD picture is not a PNG')
  }
  const width = view.getUint32(16)
  const height = view.getUint32(20)
  if (!width || !height || width > 3840 || height > 3840 || width * height > MAX_PIXELS) {
    throw new Error('HD picture exceeds the pixel limit')
  }
  return { width, height }
}

export class ScreenImageAssembler {
  private buffer: Uint8Array<ArrayBuffer> | null = null
  private kind: 'full' | 'patch' = 'full'
  private sequence = 0
  private offset = 0

  reset() { this.buffer = null; this.offset = 0 }

  push(message: ArrayBuffer): Uint8Array<ArrayBuffer> | null {
    return this.pushFrame(message)?.png ?? null
  }

  pushFrame(message: ArrayBuffer): ScreenImageFrame | null {
    if (message.byteLength < 17 || message.byteLength > 16 * 1024) throw new Error('Invalid HD picture chunk')
    const bytes = new Uint8Array(message)
    const isFull = bytes[0] === 67 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71 // CPNG
    const isPatch = bytes[0] === 67 && bytes[1] === 80 && bytes[2] === 65 && bytes[3] === 84 // CPAT
    if (!isFull && !isPatch) throw new Error('Invalid HD picture header')
    const kind = isFull ? 'full' : 'patch'
    const header = new DataView(message)
    const sequence = header.getUint32(4, true)
    const total = header.getUint32(8, true)
    const offset = header.getUint32(12, true)
    const minimum = isPatch ? 41 : 33
    if (total < minimum || total > MAX_IMAGE || offset + bytes.length - 16 > total) throw new Error('HD picture is too large')
    if (offset === 0) {
      if (this.buffer) throw new Error('HD pictures were interleaved')
      this.buffer = new Uint8Array(total)
      this.kind = kind
      this.sequence = sequence
    }
    if (!this.buffer || kind !== this.kind || sequence !== this.sequence || total !== this.buffer.length || offset !== this.offset) {
      throw new Error('HD picture is incomplete')
    }
    this.buffer.set(bytes.subarray(16), offset)
    this.offset += bytes.length - 16
    if (this.offset !== total) return null
    const payload = this.buffer
    const frameKind = this.kind
    this.reset()
    if (frameKind === 'full') {
      const { width, height } = parsePngDimensions(payload)
      return { kind: 'full', png: payload, width, height }
    }
    const patchHeader = new DataView(payload.buffer, payload.byteOffset, 8)
    const x = patchHeader.getUint16(0, true)
    const y = patchHeader.getUint16(2, true)
    const fullWidth = patchHeader.getUint16(4, true)
    const fullHeight = patchHeader.getUint16(6, true)
    if (!fullWidth || !fullHeight || fullWidth > 3840 || fullHeight > 3840 || fullWidth * fullHeight > MAX_PIXELS) {
      throw new Error('HD picture exceeds the pixel limit')
    }
    const png = payload.slice(8)
    const { width, height } = parsePngDimensions(png)
    if (x + width > fullWidth || y + height > fullHeight) {
      throw new Error('HD picture patch is out of bounds')
    }
    return { kind: 'patch', png, x, y, width, height, fullWidth, fullHeight }
  }
}
