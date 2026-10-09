// Downsamples microphone audio to 16-bit mono PCM at the rate the Mac's
// speech recognizer expects and posts it in 100 ms chunks.
class Downsampler extends AudioWorkletProcessor {
  constructor(options) {
    super()
    const rate = options.processorOptions?.rate ?? 16000
    this.ratio = sampleRate / rate
    this.pos = 0
    this.buf = new Int16Array(Math.round(rate / 10))
    this.len = 0
    this.peak = 0
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0]
    if (!ch) return true
    for (; this.pos < ch.length; this.pos += this.ratio) {
      const s = Math.max(-1, Math.min(1, ch[Math.floor(this.pos)]))
      this.peak = Math.max(this.peak, Math.abs(s))
      this.buf[this.len++] = s < 0 ? s * 0x8000 : s * 0x7fff
      if (this.len === this.buf.length) {
        this.port.postMessage({ pcm: this.buf.slice(0), peak: this.peak })
        this.len = 0
        this.peak = 0
      }
    }
    this.pos -= ch.length
    return true
  }
}

registerProcessor('cmdpalm-downsampler', Downsampler)
