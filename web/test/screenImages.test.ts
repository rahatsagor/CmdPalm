import { describe, expect, it } from 'vitest'
import { ScreenImageAssembler } from '../src/lib/screenImages'

function picture(width = 1920, height = 1080, size = 40_000) {
  const data = new Uint8Array(size)
  const view = new DataView(data.buffer)
  view.setUint32(0, 0x89504e47); view.setUint32(4, 0x0d0a1a0a)
  view.setUint32(8, 13); view.setUint32(12, 0x49484452)
  view.setUint32(16, width); view.setUint32(20, height)
  return data
}
function chunk(png: Uint8Array, offset: number, length: number, sequence = 1) {
  const result = new Uint8Array(16 + length)
  result.set([67, 80, 78, 71])
  const header = new DataView(result.buffer)
  header.setUint32(4, sequence, true); header.setUint32(8, png.length, true); header.setUint32(12, offset, true)
  result.set(png.subarray(offset, offset + length), 16)
  return result.buffer
}

describe('lossless screen pictures', () => {
  it('reassembles exact bytes across bounded messages and releases its old frame', () => {
    const assembler = new ScreenImageAssembler()
    const png = picture()
    for (let offset = 0; offset < png.length; offset += 10_000) {
      const result = assembler.push(chunk(png, offset, 10_000))
      if (offset === 30_000) expect(result).toEqual(png)
      else expect(result).toBeNull()
    }
    expect(assembler.push(chunk(picture(1280, 720, 33), 0, 33, 2))).toHaveLength(33)
  })
  it('does not accept an oversized allocation', () => {
    const bytes = chunk(picture(), 0, 100)
    new DataView(bytes).setUint32(8, 16 * 1024 * 1024 + 1, true)
    expect(() => new ScreenImageAssembler().push(bytes)).toThrow('too large')
  })
  it('rejects reordered, missing, and interleaved chunks', () => {
    const png = picture()
    expect(() => new ScreenImageAssembler().push(chunk(png, 100, 100))).toThrow('incomplete')
    const assembler = new ScreenImageAssembler()
    assembler.push(chunk(png, 0, 100))
    expect(() => assembler.push(chunk(png, 0, 100, 2))).toThrow('interleaved')
  })
  it('clears an incomplete picture when the viewer stops', () => {
    const assembler = new ScreenImageAssembler(); const png = picture()
    assembler.push(chunk(png, 0, 100)); assembler.reset()
    expect(() => assembler.push(chunk(png, 100, 100))).toThrow('incomplete')
  })
  it.each([[5000, 100], [3840, 3840], [0, 1080]])('bounds decoded dimensions %s × %s', (width, height) => {
    const png = picture(width, height, 33)
    expect(() => new ScreenImageAssembler().push(chunk(png, 0, png.length))).toThrow('pixel limit')
  })
  it('rejects another format masquerading as a picture', () => {
    const png = picture(100, 100, 33); png[0] = 0
    expect(() => new ScreenImageAssembler().push(chunk(png, 0, png.length))).toThrow('not a PNG')
  })

  it('reassembles dirty-rect lossless patches and rejects out-of-bounds patches', () => {
    const patchPng = picture(200, 120, 64)
    const payload = new Uint8Array(8 + patchPng.length)
    const header = new DataView(payload.buffer)
    header.setUint16(0, 100, true); header.setUint16(2, 50, true)
    header.setUint16(4, 1920, true); header.setUint16(6, 1080, true)
    payload.set(patchPng, 8)
    const message = new Uint8Array(16 + payload.length)
    message.set([67, 80, 65, 84]) // CPAT
    const outer = new DataView(message.buffer)
    outer.setUint32(4, 3, true); outer.setUint32(8, payload.length, true); outer.setUint32(12, 0, true)
    message.set(payload, 16)

    const frame = new ScreenImageAssembler().pushFrame(message.buffer)
    expect(frame).toEqual({ kind: 'patch', png: patchPng, x: 100, y: 50, width: 200, height: 120, fullWidth: 1920, fullHeight: 1080 })

    // Out-of-bounds patch (x + width > fullWidth)
    new DataView(message.buffer, 16, 8).setUint16(0, 1800, true)
    expect(() => new ScreenImageAssembler().pushFrame(message.buffer)).toThrow('out of bounds')
  })
})
