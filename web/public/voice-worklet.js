// Downsamples microphone audio to 16-bit mono PCM at the rate the Mac's
// speech recognizer expects and posts it in 100 ms chunks. A windowed-sinc
// low-pass keeps content above the new Nyquist rate from aliasing.
function lowPass(ratio, cutoff) {
  if (ratio <= 1) return [1]
  const half = Math.ceil(16 * ratio)
  const n = 2 * half + 1
  const taps = new Float32Array(n)
  let sum = 0
  for (let k = 0; k < n; k++) {
    const x = 2 * cutoff * (k - half)
    const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x)
    const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * k) / (n - 1)) + 0.08 * Math.cos((4 * Math.PI * k) / (n - 1))
    taps[k] = 2 * cutoff * sinc * w
    sum += taps[k]
  }
  for (let k = 0; k < n; k++) taps[k] /= sum
  return taps
}

class Downsampler extends AudioWorkletProcessor {
  constructor(options) {
    super()
    const rate = options.processorOptions?.rate ?? 16000
    this.ratio = sampleRate / rate
    this.taps = lowPass(this.ratio, 0.45 * rate / sampleRate)
    this.ext = new Float32Array(this.taps.length)
    this.pos = 0
    this.buf = new Int16Array(Math.round(rate / 10))
    this.len = 0
    this.peak = 0
    this.port.onmessage = (event) => {
      if (event.data?.t === 'flush') this.flush(true)
    }
  }

  flush(flushed = false) {
    const pcm = this.buf.slice(0, this.len)
    this.port.postMessage({ pcm, peak: this.peak, flushed }, [pcm.buffer])
    this.len = 0
    this.peak = 0
  }

  filtered(j) {
    const { taps, ext } = this
    const n = taps.length
    let acc = 0
    for (let k = 0; k < n; k++) acc += taps[k] * ext[n + j - k]
    return acc
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0]
    if (!ch) return true
    const n = this.taps.length
    if (this.ext.length !== n + ch.length) {
      const ext = new Float32Array(n + ch.length)
      ext.set(this.ext.subarray(this.ext.length - n))
      this.ext = ext
    }
    this.ext.set(ch, n)
    for (; this.pos < ch.length - 1; this.pos += this.ratio) {
      const i = Math.floor(this.pos)
      const frac = this.pos - i
      const a = this.filtered(i)
      const v = frac === 0 ? a : a + (this.filtered(i + 1) - a) * frac
      const s = Math.max(-1, Math.min(1, v))
      this.peak = Math.max(this.peak, Math.abs(s))
      this.buf[this.len++] = s < 0 ? s * 0x8000 : s * 0x7fff
      if (this.len === this.buf.length) {
        this.flush()
      }
    }
    this.pos -= ch.length
    this.ext.copyWithin(0, ch.length, n + ch.length)
    return true
  }
}

registerProcessor('cmdpalm-downsampler', Downsampler)
