import type { SpeedRange } from "./schema.ts"

/**
 * Playback speed. Clip speeds are stored as stretches of source time that play
 * faster or slower than normal, so they survive splits and trims. The global
 * speed multiplies every clip's speed, so the differences between clips stay.
 */
export interface SpeedMap {
  readonly ranges: ReadonlyArray<SpeedRange>
  readonly global: number
}

export const normalSpeed: SpeedMap = { ranges: [], global: 1 }

/** Speeds offered for one clip. */
export const CLIP_SPEEDS: ReadonlyArray<number> = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4]
/** Speeds offered for the whole video. */
export const GLOBAL_SPEEDS: ReadonlyArray<number> = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]

export const isNormal = (s: SpeedMap | undefined): boolean => !s || (s.global === 1 && s.ranges.length === 0)

/** Sorts speed ranges, drops normal-speed and empty ones, and merges touching ranges of the same speed. */
export const normalizeSpeeds = (ranges: ReadonlyArray<SpeedRange>): Array<SpeedRange> => {
  const sorted = ranges
    .filter((r) => r.endMs - r.startMs >= 1 && r.rate > 0 && r.rate !== 1)
    .map((r) => ({ ...r }))
    .sort((a, b) => a.startMs - b.startMs)
  const out: Array<{ startMs: number; endMs: number; rate: number }> = []
  for (const r of sorted) {
    const last = out[out.length - 1]
    if (last && last.rate === r.rate && r.startMs <= last.endMs) last.endMs = Math.max(last.endMs, r.endMs)
    else if (last && r.startMs < last.endMs) {
      // Overlap with a different speed: the later range starts where the earlier ends.
      if (r.endMs > last.endMs) out.push({ startMs: last.endMs, endMs: r.endMs, rate: r.rate })
    } else out.push(r)
  }
  return out
}

/** Sets the speed of the source range [startMs, endMs). A speed of 1 clears it. */
export const setSpeed = (ranges: ReadonlyArray<SpeedRange>, startMs: number, endMs: number, rate: number): Array<SpeedRange> => {
  const lo = Math.min(startMs, endMs)
  const hi = Math.max(startMs, endMs)
  const out: Array<SpeedRange> = []
  for (const r of ranges) {
    if (r.endMs <= lo || r.startMs >= hi) {
      out.push(r)
      continue
    }
    if (r.startMs < lo) out.push({ ...r, endMs: lo })
    if (r.endMs > hi) out.push({ ...r, startMs: hi })
  }
  out.push({ startMs: lo, endMs: hi, rate })
  return normalizeSpeeds(out)
}

/** The clip speed at a source time, without the global speed. */
export const clipRateAt = (ranges: ReadonlyArray<SpeedRange>, sourceMs: number): number =>
  ranges.find((r) => sourceMs >= r.startMs && sourceMs < r.endMs)?.rate ?? 1

/** The speed the video plays at, at a source time: the clip speed times the global speed. */
export const rateAt = (speed: SpeedMap | undefined, sourceMs: number): number =>
  speed ? clipRateAt(speed.ranges, sourceMs) * speed.global : 1

export interface RatedSegment {
  readonly startMs: number
  readonly endMs: number
  /** Source milliseconds played per output millisecond. */
  readonly rate: number
}

/** Divides a source segment where the speed changes. */
export const splitBySpeed = (seg: { startMs: number; endMs: number }, speed: SpeedMap | undefined): Array<RatedSegment> => {
  const global = speed?.global ?? 1
  const out: Array<RatedSegment> = []
  let cursor = seg.startMs
  for (const r of speed?.ranges ?? []) {
    if (r.endMs <= cursor) continue
    if (r.startMs >= seg.endMs) break
    if (r.startMs > cursor) out.push({ startMs: cursor, endMs: r.startMs, rate: global })
    const end = Math.min(seg.endMs, r.endMs)
    out.push({ startMs: Math.max(cursor, r.startMs), endMs: end, rate: r.rate * global })
    cursor = end
  }
  if (cursor < seg.endMs) out.push({ startMs: cursor, endMs: seg.endMs, rate: global })
  return out
}

/** "2×", "1.25×". */
export const formatRate = (rate: number): string => `${Number(rate.toFixed(2))}×`
