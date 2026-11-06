/**
 * Changes the speed of audio without changing its pitch, using WSOLA (waveform
 * similarity overlap-add). Each output block is a Hann-windowed slice of the
 * input, taken near where the speed says it should come from, at the offset
 * that best continues the previous slice, so the waveform stays smooth.
 *
 * It streams: push input as it's decoded and take output as it's ready, so a
 * long recording never has to be held in memory at once.
 */
export class TimeStretcher {
  private readonly hop: number
  private readonly win: number
  private readonly search: number
  private readonly window: Float32Array
  private readonly channels: number
  /** Input not yet consumed, per channel, starting at input sample `inBase`. */
  private input: Array<Float32Array>
  private inBase = 0
  private inEnd = 0
  /** Overlap-add buffer, per channel, starting at output sample `outBase`. */
  private ola: Array<Float32Array>
  private outBase = 0
  /** Index of the next output block. */
  private block = 0
  /** Input position of the previous block, or -1 before the first. */
  private prevPos = -1
  private totalIn = 0
  private emitted = 0

  /**
   * @param ratio input samples per output sample: 2 plays twice as fast.
   */
  constructor(channels: number, sampleRate: number, readonly ratio: number) {
    this.channels = channels
    this.hop = Math.max(16, Math.round(sampleRate * 0.015))
    this.win = this.hop * 2
    this.search = Math.max(4, Math.round(sampleRate * 0.006))
    this.window = new Float32Array(this.win)
    // A periodic Hann window: copies a hop apart add up to exactly 1.
    for (let i = 0; i < this.win; i++) this.window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / this.win)
    this.input = Array.from({ length: channels }, () => new Float32Array(this.win * 8))
    this.ola = Array.from({ length: channels }, () => new Float32Array(this.win * 2))
  }

  /** Adds input. Every plane must have the same length; missing planes repeat the first. */
  push(planes: ReadonlyArray<Float32Array>): void {
    const n = planes[0]?.length ?? 0
    if (n === 0) return
    this.reserveInput(this.inEnd - this.inBase + n)
    const at = this.inEnd - this.inBase
    for (let c = 0; c < this.channels; c++) this.input[c]!.set(planes[c] ?? planes[0]!, at)
    this.inEnd += n
    this.totalIn += n
  }

  /** Output that is final so far. */
  pull(): Array<Float32Array> {
    // A block needs its search area and a full window of input after it.
    while (this.nominal(this.block) + this.search + this.win <= this.inEnd) this.addBlock()
    return this.take(this.finalUpTo())
  }

  /** The rest of the output, after the last input. The total is the input length divided by the ratio. */
  flush(): Array<Float32Array> {
    const total = Math.round(this.totalIn / this.ratio)
    while (this.block * this.hop < total) this.addBlock()
    return this.take(total)
  }

  private nominal(k: number): number {
    return Math.round(k * this.hop * this.ratio)
  }

  private reserveInput(len: number) {
    if (this.input[0]!.length >= len) return
    const size = Math.max(len, this.input[0]!.length * 2)
    this.input = this.input.map((buf) => {
      const next = new Float32Array(size)
      next.set(buf.subarray(0, this.inEnd - this.inBase))
      return next
    })
  }

  /** An input sample, or 0 outside what has been pushed. */
  private sampleAt(c: number, i: number): number {
    if (i < this.inBase || i >= this.inEnd) return 0
    return this.input[c]![i - this.inBase]!
  }

  /** The mono input sample at i, for matching waveforms. */
  private mono(i: number): number {
    if (this.channels === 1) return this.sampleAt(0, i)
    let s = 0
    for (let c = 0; c < this.channels; c++) s += this.sampleAt(c, i)
    return s / this.channels
  }

  /** Finds where to take the next block from, so it continues the previous one smoothly. */
  private bestPosition(k: number): number {
    const target = this.nominal(k)
    if (this.prevPos < 0) return target
    // The previous block's natural continuation, one hop later.
    const ref = this.prevPos + this.hop
    const lo = Math.max(this.inBase, target - this.search)
    const hi = Math.min(this.inEnd - this.win, target + this.search)
    if (hi <= lo) return Math.max(this.inBase, Math.min(target, this.inEnd - 1))
    let best = target < lo || target > hi ? lo : target
    let bestScore = -Infinity
    // Coarse pass over every other offset, comparing every fourth sample of the overlap.
    const score = (p: number, stride: number) => {
      let s = 0
      for (let i = 0; i < this.hop; i += stride) s += this.mono(ref + i) * this.mono(p + i)
      return s
    }
    for (let p = lo; p <= hi; p += 2) {
      const s = score(p, 4)
      if (s > bestScore) {
        bestScore = s
        best = p
      }
    }
    // Fine pass around the best coarse offset.
    const center = best
    bestScore = -Infinity
    for (let p = Math.max(lo, center - 2); p <= Math.min(hi, center + 2); p++) {
      const s = score(p, 2)
      if (s > bestScore) {
        bestScore = s
        best = p
      }
    }
    return best
  }

  private addBlock() {
    const k = this.block++
    const pos = this.bestPosition(k)
    this.prevPos = pos
    const outAt = k * this.hop - this.outBase
    if (outAt + this.win > this.ola[0]!.length) {
      const size = Math.max(outAt + this.win, this.ola[0]!.length * 2)
      this.ola = this.ola.map((buf) => {
        const next = new Float32Array(size)
        next.set(buf)
        return next
      })
    }
    for (let c = 0; c < this.channels; c++) {
      const o = this.ola[c]!
      for (let i = 0; i < this.win; i++) o[outAt + i]! += this.sampleAt(c, pos + i) * this.window[i]!
    }
    // Input before what the next block can use is no longer needed.
    const keepFrom = Math.min(pos + this.hop, this.nominal(this.block) - this.search)
    this.dropInputBefore(keepFrom)
  }

  private dropInputBefore(i: number) {
    const drop = Math.min(i, this.inEnd) - this.inBase
    if (drop <= 0) return
    const len = this.inEnd - this.inBase - drop
    for (const buf of this.input) buf.copyWithin(0, drop, drop + len)
    this.inBase += drop
  }

  /** Output samples before the next block's start are complete. */
  private finalUpTo(): number {
    return this.block * this.hop
  }

  private take(upTo: number): Array<Float32Array> {
    const n = Math.max(0, upTo - this.emitted)
    const from = this.emitted - this.outBase
    const out = this.ola.map((buf) => {
      const o = new Float32Array(n)
      o.set(buf.subarray(from, Math.min(buf.length, from + n)))
      return o
    })
    this.emitted += n
    // Shift the overlap-add buffer so it only holds what isn't emitted yet.
    const shift = this.emitted - this.outBase
    if (shift > 0) {
      for (const buf of this.ola) {
        buf.copyWithin(0, shift)
        buf.fill(0, buf.length - shift)
      }
      this.outBase = this.emitted
    }
    return out
  }
}

/** Stretches a whole buffer at once. Handy for tests. */
export const stretch = (planes: ReadonlyArray<Float32Array>, sampleRate: number, ratio: number): Array<Float32Array> => {
  const s = new TimeStretcher(planes.length, sampleRate, ratio)
  s.push(planes)
  const a = s.pull()
  const b = s.flush()
  return a.map((x, c) => {
    const out = new Float32Array(x.length + b[c]!.length)
    out.set(x)
    out.set(b[c]!, x.length)
    return out
  })
}
