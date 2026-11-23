import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

type Processor = { process(inputs: Float32Array[][]): boolean; flush(): void }

function resample(source: string, sampleRate: number, tone: (t: number) => number, seconds = 1): Int16Array {
  const chunks: Int16Array[] = []
  class Base {
    port = { postMessage: (message: { pcm: Int16Array }) => chunks.push(message.pcm), onmessage: null as unknown }
  }
  let Worklet!: new (options: unknown) => Processor
  new Function('AudioWorkletProcessor', 'sampleRate', 'registerProcessor', source)(Base, sampleRate, (_: string, cls: typeof Worklet) => (Worklet = cls))
  const node = new Worklet({ processorOptions: { rate: 16000 } })
  const total = Math.round(sampleRate * seconds)
  for (let start = 0; start < total; start += 128) {
    const block = new Float32Array(Math.min(128, total - start))
    for (let i = 0; i < block.length; i++) block[i] = tone((start + i) / sampleRate)
    node.process([[block]])
  }
  node.flush()
  const out = new Int16Array(chunks.reduce((n, c) => n + c.length, 0))
  let at = 0
  for (const chunk of chunks) {
    out.set(chunk, at)
    at += chunk.length
  }
  return out
}

const rms = (pcm: Int16Array, skip = 0) => {
  let sum = 0
  for (let i = skip; i < pcm.length; i++) sum += (pcm[i]! / 0x7fff) ** 2
  return Math.sqrt(sum / (pcm.length - skip))
}
const sine = (hz: number) => (t: number) => 0.5 * Math.sin(2 * Math.PI * hz * t)
const db = (ratio: number) => 20 * Math.log10(ratio)
const worklet = readFileSync('public/voice-worklet.js', 'utf8')
const INPUT_RMS = 0.5 / Math.SQRT2

describe.each([48000, 44100])('voice worklet at %i Hz', (rate) => {
  it('keeps a 1 kHz tone at its level', () => {
    const out = resample(worklet, rate, sine(1000))
    expect(Math.abs(db(rms(out, 160) / INPUT_RMS))).toBeLessThan(0.5)
  })

  it('removes content above the new Nyquist rate', () => {
    const out = resample(worklet, rate, sine(10000))
    expect(db(rms(out, 160) / INPUT_RMS)).toBeLessThan(-40)
  })

  it('produces 16 kHz audio', () => {
    expect(Math.abs(resample(worklet, rate, sine(1000)).length - 16000)).toBeLessThanOrEqual(2)
  })
})

describe('voice worklet filter taps', () => {
  it('evaluates the filter once per output sample at 48 kHz', () => {
    class Base {
      port = { postMessage: () => {}, onmessage: null as unknown }
    }
    let Worklet!: new (options: unknown) => Processor & { filtered(i: number): number }
    new Function('AudioWorkletProcessor', 'sampleRate', 'registerProcessor', worklet)(Base, 48000, (_: string, cls: typeof Worklet) => (Worklet = cls))
    const node = new Worklet({ processorOptions: { rate: 16000 } })
    const filtered = node.filtered.bind(node)
    let calls = 0
    node.filtered = (i) => {
      calls++
      return filtered(i)
    }
    node.process([[new Float32Array(128)]])
    expect(calls).toBe(Math.ceil(127 / 3))
  })
})
