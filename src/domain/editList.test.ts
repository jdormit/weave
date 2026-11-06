import { describe, expect, test } from "bun:test"
import { setSpeed } from "./speed.ts"
import {
  addCut,
  addSplit,
  clips,
  commit,
  editedDuration,
  editedToSource,
  emptyEditList,
  isWordCut,
  keptSegments,
  normalizeCuts,
  redo,
  removeCut,
  sourceToEdited,
  toggleWords,
  trimClip,
  undo,
  wordRangeCut
} from "./editList.ts"
import type { Word } from "./schema.ts"

const w = (id: string, startMs: number, endMs: number): Word => ({ id, text: ` ${id}`, startMs, endMs })

describe("normalizeCuts", () => {
  test("sorts, merges overlapping and touching cuts, and clamps", () => {
    expect(
      normalizeCuts(
        [
          { startMs: 500, endMs: 700 },
          { startMs: 100, endMs: 200 },
          { startMs: 150, endMs: 300 },
          { startMs: 300, endMs: 350 },
          { startMs: 900, endMs: 2000 }
        ],
        1000
      )
    ).toEqual([
      { startMs: 100, endMs: 350 },
      { startMs: 500, endMs: 700 },
      { startMs: 900, endMs: 1000 }
    ])
  })
  test("drops empty cuts and fixes reversed ranges", () => {
    expect(normalizeCuts([{ startMs: 10, endMs: 10 }, { startMs: 40, endMs: 20 }])).toEqual([{ startMs: 20, endMs: 40 }])
  })
})

describe("removeCut", () => {
  test("restores the middle of a cut, leaving two pieces", () => {
    expect(removeCut([{ startMs: 0, endMs: 1000 }], 400, 600)).toEqual([
      { startMs: 0, endMs: 400 },
      { startMs: 600, endMs: 1000 }
    ])
  })
  test("restores across several cuts", () => {
    expect(removeCut([{ startMs: 0, endMs: 100 }, { startMs: 200, endMs: 300 }, { startMs: 400, endMs: 500 }], 50, 450)).toEqual([
      { startMs: 0, endMs: 50 },
      { startMs: 450, endMs: 500 }
    ])
  })
})

describe("time mapping", () => {
  const cuts = [{ startMs: 1000, endMs: 2000 }, { startMs: 3000, endMs: 3500 }]
  test("source to edited", () => {
    expect(sourceToEdited(cuts, 500)).toBe(500)
    expect(sourceToEdited(cuts, 1000)).toBe(1000)
    expect(sourceToEdited(cuts, 1500)).toBe(1000)
    expect(sourceToEdited(cuts, 2000)).toBe(1000)
    expect(sourceToEdited(cuts, 2500)).toBe(1500)
    expect(sourceToEdited(cuts, 4000)).toBe(2500)
  })
  test("edited to source", () => {
    expect(editedToSource(cuts, 500)).toBe(500)
    expect(editedToSource(cuts, 1000)).toBe(2000)
    expect(editedToSource(cuts, 1500)).toBe(2500)
    expect(editedToSource(cuts, 2000)).toBe(3500)
    expect(editedToSource(cuts, 2500)).toBe(4000)
  })
  test("round trip for every kept time", () => {
    for (let t = 0; t < 5000; t += 50) {
      const inCut = cuts.some((c) => t >= c.startMs && t < c.endMs)
      if (!inCut) expect(editedToSource(cuts, sourceToEdited(cuts, t))).toBe(t)
    }
  })
  test("edited duration", () => {
    expect(editedDuration(cuts, 5000)).toBe(3500)
  })
})

describe("segments and clips", () => {
  test("kept segments are the complement of the cuts", () => {
    expect(keptSegments([{ startMs: 0, endMs: 100 }, { startMs: 500, endMs: 600 }], 1000)).toEqual([
      { startMs: 100, endMs: 500 },
      { startMs: 600, endMs: 1000 }
    ])
  })
  test("splits divide kept segments into clips", () => {
    const c = clips([{ startMs: 500, endMs: 600 }], [200, 550, 800], 1000)
    expect(c.map((x) => [x.startMs, x.endMs])).toEqual([
      [0, 200],
      [200, 500],
      [600, 800],
      [800, 1000]
    ])
  })
  test("addSplit ignores duplicates", () => {
    expect(addSplit([100], 100.5)).toEqual([100])
    expect(addSplit([300], 100)).toEqual([100, 300])
  })
})

describe("history", () => {
  test("undo and redo", () => {
    let list = emptyEditList("r")
    list = commit(list, { cuts: [{ startMs: 0, endMs: 10 }], splits: [], speeds: [], speed: 1 })
    list = commit(list, { cuts: [{ startMs: 0, endMs: 20 }], splits: [5], speeds: [], speed: 1 })
    expect(list.past.length).toBe(2)
    list = undo(list)
    expect(list.cuts).toEqual([{ startMs: 0, endMs: 10 }])
    expect(list.splits).toEqual([])
    list = undo(list)
    expect(list.cuts).toEqual([])
    list = undo(list)
    expect(list.cuts).toEqual([])
    list = redo(list)
    list = redo(list)
    expect(list.cuts).toEqual([{ startMs: 0, endMs: 20 }])
    expect(list.future.length).toBe(0)
  })
  test("a change that alters nothing adds no step", () => {
    const list = emptyEditList("r")
    expect(commit(list, { cuts: [], splits: [], speeds: [], speed: 1 }).past.length).toBe(0)
  })
  test("a new change clears redo", () => {
    let list = commit(emptyEditList("r"), { cuts: [{ startMs: 0, endMs: 10 }], splits: [], speeds: [], speed: 1 })
    list = undo(list)
    list = commit(list, { cuts: [], splits: [3], speeds: [], speed: 1 })
    expect(list.future).toEqual([])
  })
})

describe("word cuts", () => {
  const words = [w("a", 0, 400), w("b", 500, 900), w("c", 1500, 1900), w("d", 2000, 2300)]
  test("cut padding keeps at most 150 ms of the pause before the next word", () => {
    expect(wordRangeCut(words, [], 1, 1)).toEqual({ startMs: 500, endMs: 1350 })
  })
  test("a short pause is fully kept", () => {
    expect(wordRangeCut(words, [], 2, 2)).toEqual({ startMs: 1500, endMs: 1900 })
  })
  test("the last word is cut to its end", () => {
    expect(wordRangeCut(words, [], 3, 3)).toEqual({ startMs: 2000, endMs: 2300 })
  })
  test("cut skips to the next kept word", () => {
    const cuts = [{ startMs: 1500, endMs: 1950 }]
    expect(wordRangeCut(words, cuts, 1, 1)).toEqual({ startMs: 500, endMs: 1850 })
  })
  test("toggle cuts, then restores", () => {
    const cut = toggleWords(words, [], 1, 2, 3000)
    expect(words.map((x) => isWordCut(cut, x))).toEqual([false, true, true, false])
    const restored = toggleWords(words, cut, 2, 1, 3000)
    expect(restored).toEqual([])
  })
  test("a word covered by a timeline cut counts as cut", () => {
    expect(isWordCut([{ startMs: 0, endMs: 300 }], words[0]!)).toBe(true)
    expect(isWordCut([{ startMs: 0, endMs: 100 }], words[0]!)).toBe(false)
  })
})

describe("trimClip", () => {
  test("moving the start inward cuts", () => {
    expect(trimClip([], { startMs: 0, endMs: 1000 }, "start", 200, 1000)).toEqual([{ startMs: 0, endMs: 200 }])
  })
  test("moving the start outward restores the neighboring cut", () => {
    expect(trimClip([{ startMs: 0, endMs: 500 }], { startMs: 500, endMs: 1000 }, "start", 300, 1000)).toEqual([
      { startMs: 0, endMs: 300 }
    ])
  })
  test("moving the end inward cuts", () => {
    expect(trimClip([], { startMs: 0, endMs: 1000 }, "end", 700, 1000)).toEqual([{ startMs: 700, endMs: 1000 }])
  })
  test("moving the end outward restores", () => {
    expect(trimClip([{ startMs: 500, endMs: 900 }], { startMs: 0, endMs: 500 }, "end", 700, 1000)).toEqual([
      { startMs: 700, endMs: 900 }
    ])
  })
})

describe("addCut", () => {
  test("adds and merges", () => {
    expect(addCut([{ startMs: 0, endMs: 100 }], 50, 200)).toEqual([{ startMs: 0, endMs: 200 }])
  })
})

test("a zero-length word at the very end is cut by a cut that runs to the end", () => {
  const cuts = [{ startMs: 1000, endMs: 2000 }]
  expect(isWordCut(cuts, { id: "a", text: "end", startMs: 2000, endMs: 2000 })).toBe(true)
  expect(isWordCut(cuts, { id: "b", text: "after", startMs: 2000, endMs: 2300 })).toBe(false)
})

describe("speed", () => {
  const speed = { ranges: [{ startMs: 1000, endMs: 3000, rate: 2 }], global: 1 }
  test("a sped-up clip is shorter in the edited video", () => {
    expect(editedDuration([], 4000, speed)).toBe(3000)
    expect(editedDuration([{ startMs: 2000, endMs: 3000 }], 4000, speed)).toBe(2500)
    // The global speed scales every clip.
    expect(editedDuration([], 4000, { ...speed, global: 2 })).toBe(1500)
  })
  test("source and edited times map both ways through cuts and speeds", () => {
    const cuts = [{ startMs: 3500, endMs: 3600 }]
    expect(sourceToEdited(cuts, 500, speed)).toBe(500)
    expect(sourceToEdited(cuts, 2000, speed)).toBe(1500)
    expect(sourceToEdited(cuts, 3200, speed)).toBe(2200)
    expect(sourceToEdited(cuts, 3550, speed)).toBe(2500)
    expect(sourceToEdited(cuts, 3700, speed)).toBe(2600)
    for (const t of [0, 500, 1000, 1999, 2500, 3200, 3700]) expect(editedToSource(cuts, sourceToEdited(cuts, t, speed), speed)).toBeCloseTo(t, 6)
    // At the cut, the frame after it is shown.
    expect(editedToSource(cuts, 2500, speed)).toBe(3600)
  })
  test("clips divide where the clip speed changes and carry their speed", () => {
    const out = clips([], [], 4000, speed.ranges)
    expect(out.map((c) => [c.startMs, c.endMs, c.rate])).toEqual([[0, 1000, 1], [1000, 3000, 2], [3000, 4000, 1]])
  })
  test("setSpeed replaces the speed of a range and merges equal neighbors", () => {
    let r = setSpeed([], 1000, 2000, 2)
    r = setSpeed(r, 2000, 3000, 2)
    expect(r).toEqual([{ startMs: 1000, endMs: 3000, rate: 2 }])
    r = setSpeed(r, 1500, 2500, 1)
    expect(r).toEqual([{ startMs: 1000, endMs: 1500, rate: 2 }, { startMs: 2500, endMs: 3000, rate: 2 }])
  })
  test("speed changes are undoable", () => {
    let list = emptyEditList("r")
    list = commit(list, { cuts: [], splits: [], speeds: [{ startMs: 0, endMs: 10, rate: 2 }], speed: 1 })
    list = commit(list, { ...list, speed: 1.5 })
    list = undo(list)
    expect(list.speed).toBe(1)
    expect(list.speeds).toHaveLength(1)
    list = undo(list)
    expect(list.speeds).toEqual([])
  })
})
