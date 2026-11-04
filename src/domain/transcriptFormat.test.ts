import { describe, expect, test } from "bun:test"
import { formatClock, formatTimestamp, paragraphs, toCues, toJson, toSrt, toTxt, toVtt } from "./transcriptFormat.ts"
import type { Word } from "./schema.ts"

const words: Array<Word> = [
  { id: "1", text: " Hello", startMs: 0, endMs: 400 },
  { id: "2", text: " there,", startMs: 450, endMs: 800 },
  { id: "3", text: " um,", startMs: 900, endMs: 1100 },
  { id: "4", text: " friends.", startMs: 1200, endMs: 1700 },
  { id: "5", text: " New", startMs: 4000, endMs: 4300 },
  { id: "6", text: " paragraph.", startMs: 4350, endMs: 5000 }
]

describe("paragraphs", () => {
  test("a pause over 1.5 s starts a new paragraph", () => {
    const p = paragraphs(words)
    expect(p.length).toBe(2)
    expect(p[1]!.firstIndex).toBe(4)
    expect(p[1]!.startMs).toBe(4000)
  })
})

describe("timestamps", () => {
  test("SRT and VTT formats", () => {
    expect(formatTimestamp(3_723_045, ",")).toBe("01:02:03,045")
    expect(formatTimestamp(1500, ".")).toBe("00:00:01.500")
  })
  test("clock", () => {
    expect(formatClock(65_000)).toBe("1:05")
    expect(formatClock(3_725_000)).toBe("1:02:05")
  })
})

describe("TXT", () => {
  test("keeps uncut words in paragraphs", () => {
    expect(toTxt(words, [])).toBe("Hello there, um, friends.\n\nNew paragraph.\n")
    expect(toTxt(words, [{ startMs: 900, endMs: 1150 }])).toBe("Hello there, friends.\n\nNew paragraph.\n")
  })
  test("cutting the pause joins paragraphs", () => {
    expect(toTxt(words, [{ startMs: 1800, endMs: 3900 }])).toBe("Hello there, um, friends. New paragraph.\n")
  })
})

describe("cues", () => {
  test("times are in edited time", () => {
    const cues = toCues(words, [{ startMs: 0, endMs: 900 }])
    expect(cues[0]!.startMs).toBe(0)
    expect(cues[0]!.text).toBe("um, friends.")
    expect(cues[1]!.startMs).toBe(4000 - 900)
  })
  test("lines are at most 42 characters", () => {
    const long: Array<Word> = Array.from({ length: 30 }, (_, i) => ({
      id: String(i),
      text: " word" + i,
      startMs: i * 200,
      endMs: i * 200 + 150
    }))
    for (const c of toCues(long, [])) expect(c.text.length).toBeLessThanOrEqual(42)
  })
  test("cues are at most 7 seconds", () => {
    const slow: Array<Word> = Array.from({ length: 10 }, (_, i) => ({
      id: String(i),
      text: " a",
      startMs: i * 1400,
      endMs: i * 1400 + 300
    }))
    for (const c of toCues(slow, [])) expect(c.endMs - c.startMs).toBeLessThanOrEqual(7000)
  })
})

describe("SRT and VTT", () => {
  test("SRT", () => {
    expect(toSrt(words, [])).toBe(
      "1\n00:00:00,000 --> 00:00:01,700\nHello there, um, friends.\n\n2\n00:00:04,000 --> 00:00:05,000\nNew paragraph.\n"
    )
  })
  test("VTT", () => {
    expect(toVtt(words, [{ startMs: 1800, endMs: 3800 }])).toBe(
      "WEBVTT\n\n00:00:00.000 --> 00:00:03.000\nHello there, um, friends. New paragraph.\n"
    )
  })
})

describe("JSON", () => {
  test("includes every word with source times and a cut flag", () => {
    const j = toJson({ title: "T", modelId: "m", language: "en", durationMs: 6000, words, cuts: [{ startMs: 900, endMs: 1150 }] })
    expect(j.words.filter((x) => x.cut).map((x) => x.id)).toEqual(["3"])
    expect(j.editedDurationMs).toBe(6000 - 250)
    expect(j.words[4]!.startMs).toBe(4000)
  })
})
