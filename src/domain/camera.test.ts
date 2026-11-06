import { describe, expect, test } from "bun:test"
import { cameraAudioOnSource, cameraRanges, cameraTimeAt, cameraToSource, makeSegmentTracker, resolveSegments, screenRanges } from "./camera.ts"

describe("cameraTimeAt", () => {
  test("a camera recorded with the screen is shifted by its offset", () => {
    expect(cameraTimeAt({ cameraOffsetMs: 30, cameraSegments: [] }, 1000)).toBe(970)
    expect(cameraTimeAt({ cameraOffsetMs: 30, cameraSegments: [] }, 10)).toBe(0)
  })
  test("a re-recorded camera follows its segments, with nothing between them", () => {
    const t = { cameraOffsetMs: 0, cameraSegments: [{ startMs: 0, endMs: 1000, cameraMs: 0, rate: 1 }, { startMs: 2000, endMs: 3000, cameraMs: 1000, rate: 1 }] }
    expect(cameraTimeAt(t, 500)).toBe(500)
    expect(cameraTimeAt(t, 1500)).toBeNull()
    expect(cameraTimeAt(t, 2500)).toBe(1500)
    expect(cameraTimeAt(t, 3000)).toBeNull()
  })
})

describe("makeSegmentTracker", () => {
  test("a jump over a cut starts a new segment", () => {
    const tr = makeSegmentTracker()
    // Plays 0..1000, then skips the cut 1000..2000, then plays 2000..3000.
    for (let cam = 0; cam <= 2000; cam += 16) tr.observe(cam < 1000 ? cam : cam + 1000, cam)
    const segs = tr.finish()
    expect(segs).toHaveLength(2)
    expect(segs[0]!.startMs).toBe(0)
    expect(segs[0]!.endMs).toBeGreaterThanOrEqual(992)
    expect(segs[0]!.endMs).toBeLessThanOrEqual(2000)
    expect(segs[1]!.startMs).toBeGreaterThanOrEqual(2000)
    expect(segs[1]!.startMs).toBeLessThan(2020)
    // The camera time of the second segment matches the moment of the jump.
    expect(cameraTimeAt({ cameraOffsetMs: 0, cameraSegments: segs }, 2500)).toBeCloseTo(1500, -1)
  })
  test("a stall leaves no gap, and the camera picks up where the video resumes", () => {
    const tr = makeSegmentTracker()
    // Plays to 1000, stalls there for 500 ms, then plays on.
    for (let cam = 0; cam <= 2500; cam += 16) tr.observe(cam < 1000 ? cam : cam < 1500 ? 1000 : cam - 500, cam)
    const segs = tr.finish()
    const t = { cameraOffsetMs: 0, cameraSegments: segs }
    for (let s = 0; s < 2000; s += 10) expect(cameraTimeAt(t, s)).not.toBeNull()
    expect(cameraTimeAt(t, 1800)! - 1800).toBeGreaterThan(400)
  })
})

describe("resolveSegments", () => {
  test("a later segment wins where two overlap", () => {
    const out = resolveSegments([{ startMs: 0, endMs: 1000, cameraMs: 0, rate: 1 }, { startMs: 400, endMs: 600, cameraMs: 5000, rate: 1 }])
    expect(out).toEqual([
      { startMs: 0, endMs: 400, cameraMs: 0, rate: 1 },
      { startMs: 400, endMs: 600, cameraMs: 5000, rate: 1 },
      { startMs: 600, endMs: 1000, cameraMs: 600, rate: 1 }
    ])
  })
})

describe("ranges", () => {
  test("screen ranges follow the kept parts", () => {
    expect(screenRanges([{ startMs: 1000, endMs: 2000 }], 3000)).toEqual([
      { fromMs: 0, toMs: 1000, outMs: 0, outEndMs: 1000 },
      { fromMs: 2000, toMs: 3000, outMs: 1000, outEndMs: 2000 }
    ])
  })
  test("camera ranges cover the kept parts that have camera", () => {
    const timing = { cameraOffsetMs: 0, cameraSegments: [{ startMs: 0, endMs: 1000, cameraMs: 0, rate: 1 }, { startMs: 2000, endMs: 3000, cameraMs: 1000, rate: 1 }] }
    // A later cut at 2500..2700 removes part of the second segment.
    expect(cameraRanges([{ startMs: 1000, endMs: 2000 }, { startMs: 2500, endMs: 2700 }], 3000, timing)).toEqual([
      { fromMs: 0, toMs: 1000, outMs: 0, outEndMs: 1000 },
      { fromMs: 1000, toMs: 1500, outMs: 1000, outEndMs: 1500 },
      { fromMs: 1700, toMs: 2000, outMs: 1500, outEndMs: 1800 }
    ])
  })
})

test("cameraAudioOnSource places each segment at its source time", () => {
  const cam = new Float32Array([1, 2, 3, 4])
  const out = cameraAudioOnSource(cam, { cameraOffsetMs: 0, cameraSegments: [{ startMs: 0, endMs: 2000, cameraMs: 0, rate: 1 }, { startMs: 4000, endMs: 6000, cameraMs: 2000, rate: 1 }] }, 6000, 1)
  expect(Array.from(out)).toEqual([1, 2, 0, 0, 3, 4])
})

describe("speed", () => {
  test("a take recorded over a 2x clip maps camera time at half the source rate", () => {
    const t = { cameraOffsetMs: 0, cameraSegments: [{ startMs: 0, endMs: 1000, cameraMs: 0, rate: 1 }, { startMs: 1000, endMs: 3000, cameraMs: 1000, rate: 2 }] }
    expect(cameraTimeAt(t, 2000)).toBe(1500)
    expect(cameraToSource(t, 1500)).toBe(2000)
    expect(cameraToSource(t, 2000)).toBeNull()
  })
  test("the tracker starts a new segment where the speed changes, with no gap", () => {
    const tr = makeSegmentTracker()
    // Plays 0..1000 at 1x, then 1000..3000 at 2x.
    for (let cam = 0; cam <= 2000; cam += 16) {
      const src = cam < 1000 ? cam : 1000 + (cam - 1000) * 2
      tr.observe(src, cam, src < 1000 ? 1 : 2)
    }
    const segs = tr.finish()
    expect(segs).toHaveLength(2)
    expect(segs[1]!.rate).toBe(2)
    expect(segs[0]!.endMs).toBe(segs[1]!.startMs)
    const t = { cameraOffsetMs: 0, cameraSegments: segs }
    expect(cameraTimeAt(t, 2500)).toBeCloseTo(1750, -1)
  })
  test("screen and camera ranges shrink in the output where the video is sped up", () => {
    const speed = { ranges: [{ startMs: 1000, endMs: 2000, rate: 2 }], global: 1 }
    expect(screenRanges([], 3000, speed)).toEqual([
      { fromMs: 0, toMs: 1000, outMs: 0, outEndMs: 1000 },
      { fromMs: 1000, toMs: 2000, outMs: 1000, outEndMs: 1500 },
      { fromMs: 2000, toMs: 3000, outMs: 1500, outEndMs: 2500 }
    ])
    // A take recorded over the 2x part keeps its own length in the output.
    const timing = { cameraOffsetMs: 0, cameraSegments: [{ startMs: 1000, endMs: 2000, cameraMs: 0, rate: 2 }] }
    expect(cameraRanges([], 3000, timing, speed)).toEqual([{ fromMs: 0, toMs: 500, outMs: 1000, outEndMs: 1500 }])
    // Doubling the global speed plays the take twice as fast too.
    expect(cameraRanges([], 3000, timing, { ...speed, global: 2 })).toEqual([{ fromMs: 0, toMs: 500, outMs: 500, outEndMs: 750 }])
  })
})
