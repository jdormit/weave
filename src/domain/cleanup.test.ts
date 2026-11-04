import { describe, expect, test } from "bun:test"
import { applyCleanup, fillerCounts, findFillers, findPauses, isFiller, savedMs } from "./cleanup.ts"
import type { Word } from "./schema.ts"

const words: Array<Word> = [
  { id: "1", text: " So", startMs: 200, endMs: 500 },
  { id: "2", text: " um,", startMs: 600, endMs: 800 },
  { id: "3", text: " here", startMs: 3800, endMs: 4100 },
  { id: "4", text: " it", startMs: 4200, endMs: 4400 },
  { id: "5", text: " Uhh.", startMs: 4500, endMs: 4700 }
]

describe("fillers", () => {
  test("matches filler words with punctuation and stretched spellings", () => {
    expect(["um", "Um,", "uhh", "Er.", "ah", "Hmm?", "mm", "mmm"].every(isFiller)).toBe(true)
    expect(["us", "erase", "a", "m", "umbrella"].some(isFiller)).toBe(false)
  })
  test("finds fillers that aren't cut yet", () => {
    const f = findFillers(words, [])
    expect(f.map((x) => x.word)).toEqual(["um", "uhh"])
    expect(findFillers(words, [{ startMs: 550, endMs: 900 }]).length).toBe(1)
    expect(fillerCounts(f)).toEqual([["um", 1], ["uhh", 1]])
  })
})

describe("pauses", () => {
  test("shortens long gaps to 0.5 s", () => {
    const p = findPauses(words, [], 5000, 1000)
    expect(p).toEqual([{ startMs: 1050, endMs: 3550 }])
    expect(savedMs([], p, 5000)).toBe(2500)
  })
  test("respects the minimum pause length", () => {
    expect(findPauses(words, [], 5000, 4000)).toEqual([])
  })
  test("skips gaps that aren't quiet", () => {
    const sampleRate = 1000
    const samples = new Float32Array(5000)
    for (let i = 0; i < 5000; i++) samples[i] = 0.5 * Math.sin(i)
    expect(findPauses(words, [], 5000, 1000, { sampleRate, samples })).toEqual([])
    for (let i = 900; i < 3700; i++) samples[i] = 0
    expect(findPauses(words, [], 5000, 1000, { sampleRate, samples })).toEqual([{ startMs: 1050, endMs: 3550 }])
  })
  test("includes long silence at the start and end", () => {
    const p = findPauses([{ id: "1", text: " hi", startMs: 3000, endMs: 3200 }], [], 6000, 1000)
    expect(p).toEqual([{ startMs: 0, endMs: 2500 }, { startMs: 3700, endMs: 6000 }])
  })
  test("applies as cuts", () => {
    expect(applyCleanup([{ startMs: 0, endMs: 100 }], [{ startMs: 50, endMs: 300 }], 1000)).toEqual([{ startMs: 0, endMs: 300 }])
  })
})
