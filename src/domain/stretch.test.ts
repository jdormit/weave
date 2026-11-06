import { describe, expect, test } from "bun:test"
import { stretch, TimeStretcher } from "./stretch.ts"

const RATE = 16000
const sine = (hz: number, seconds: number) => {
  const out = new Float32Array(Math.round(seconds * RATE))
  for (let i = 0; i < out.length; i++) out[i] = Math.sin((2 * Math.PI * hz * i) / RATE)
  return out
}
/** Frequency from upward zero crossings, ignoring the faded edges. */
const pitch = (x: Float32Array) => {
  const a = Math.floor(x.length * 0.1)
  const b = Math.floor(x.length * 0.9)
  let n = 0
  for (let i = a + 1; i < b; i++) if (x[i - 1]! < 0 && x[i]! >= 0) n++
  return n / ((b - a) / RATE)
}
const rms = (x: Float32Array) => {
  const a = Math.floor(x.length * 0.1)
  const b = Math.floor(x.length * 0.9)
  let s = 0
  for (let i = a; i < b; i++) s += x[i]! * x[i]!
  return Math.sqrt(s / (b - a))
}

describe("TimeStretcher", () => {
  for (const ratio of [2, 1.5, 0.75, 4]) {
    test(`at ${ratio}x the length changes and the pitch doesn't`, () => {
      const input = sine(440, 2)
      const [out] = stretch([input], RATE, ratio)
      expect(out!.length).toBe(Math.round(input.length / ratio))
      expect(pitch(out!)).toBeGreaterThan(430)
      expect(pitch(out!)).toBeLessThan(450)
      // No dropouts or doubling: the level stays like a sine's.
      expect(rms(out!)).toBeGreaterThan(0.6)
      expect(rms(out!)).toBeLessThan(0.8)
    })
  }
  test("streaming in small pieces gives the same result as all at once", () => {
    const input = sine(300, 1)
    const [whole] = stretch([input], RATE, 2)
    const s = new TimeStretcher(1, RATE, 2)
    const parts: Array<Float32Array> = []
    for (let i = 0; i < input.length; i += 320) {
      s.push([input.subarray(i, i + 320)])
      parts.push(s.pull()[0]!)
    }
    parts.push(s.flush()[0]!)
    const joined = new Float32Array(parts.reduce((n, p) => n + p.length, 0))
    let at = 0
    for (const p of parts) {
      joined.set(p, at)
      at += p.length
    }
    expect(joined.length).toBe(whole!.length)
    let maxDiff = 0
    for (let i = 0; i < joined.length; i++) maxDiff = Math.max(maxDiff, Math.abs(joined[i]! - whole![i]!))
    expect(maxDiff).toBeLessThan(1e-5)
  })
  test("keeps both channels", () => {
    const l = sine(440, 1)
    const r = sine(220, 1)
    const [ol, or] = stretch([l, r], RATE, 2)
    expect(pitch(ol!)).toBeGreaterThan(430)
    expect(pitch(or!)).toBeGreaterThan(210)
    expect(pitch(or!)).toBeLessThan(230)
  })
})
