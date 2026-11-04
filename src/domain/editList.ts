import type { Cut, EditList, EditState, Word } from "./schema.ts"

/**
 * Pure functions over the edit list. A cut is a source time range that the
 * edited video skips. Cuts are always kept sorted and merged. Splits divide the
 * timeline into clips and don't change the output on their own.
 */

/** Cuts shorter than this are dropped, so rounding never leaves slivers. */
const MIN_CUT_MS = 1
const HISTORY_LIMIT = 200

export const emptyEditList = (recordingId: string): EditList => ({
  recordingId,
  cuts: [],
  splits: [],
  past: [],
  future: []
})

/** Sorts cuts, clamps them to the recording, and merges overlapping or touching ones. */
export const normalizeCuts = (cuts: ReadonlyArray<Cut>, durationMs = Infinity): Array<Cut> => {
  const sorted = cuts
    .map((c) => ({
      startMs: Math.max(0, Math.min(c.startMs, c.endMs)),
      endMs: Math.min(durationMs, Math.max(c.startMs, c.endMs))
    }))
    .filter((c) => c.endMs - c.startMs >= MIN_CUT_MS)
    .sort((a, b) => a.startMs - b.startMs)
  const out: Array<{ startMs: number; endMs: number }> = []
  for (const c of sorted) {
    const last = out[out.length - 1]
    if (last && c.startMs <= last.endMs) {
      last.endMs = Math.max(last.endMs, c.endMs)
    } else {
      out.push({ ...c })
    }
  }
  return out
}

/** Adds the range [startMs, endMs) to the cuts. */
export const addCut = (cuts: ReadonlyArray<Cut>, startMs: number, endMs: number, durationMs = Infinity): Array<Cut> =>
  normalizeCuts([...cuts, { startMs, endMs }], durationMs)

/** Removes the range [startMs, endMs) from the cuts, which restores that part of the video. */
export const removeCut = (cuts: ReadonlyArray<Cut>, startMs: number, endMs: number): Array<Cut> => {
  const lo = Math.min(startMs, endMs)
  const hi = Math.max(startMs, endMs)
  const out: Array<Cut> = []
  for (const c of cuts) {
    if (c.endMs <= lo || c.startMs >= hi) {
      out.push({ ...c })
      continue
    }
    if (c.startMs < lo) out.push({ startMs: c.startMs, endMs: lo })
    if (c.endMs > hi) out.push({ startMs: hi, endMs: c.endMs })
  }
  return normalizeCuts(out)
}

export const isInCut = (cuts: ReadonlyArray<Cut>, t: number): boolean =>
  cuts.some((c) => t >= c.startMs && t < c.endMs)

/** The cut containing source time t, if any. */
export const cutAt = (cuts: ReadonlyArray<Cut>, t: number): Cut | undefined =>
  cuts.find((c) => t >= c.startMs && t < c.endMs)

export const totalCutMs = (cuts: ReadonlyArray<Cut>): number =>
  cuts.reduce((sum, c) => sum + (c.endMs - c.startMs), 0)

export const editedDuration = (cuts: ReadonlyArray<Cut>, durationMs: number): number =>
  Math.max(0, durationMs - totalCutMs(normalizeCuts(cuts, durationMs)))

/** Maps a source time to edited time. A time inside a cut maps to where the cut starts in edited time. */
export const sourceToEdited = (cuts: ReadonlyArray<Cut>, sourceMs: number): number => {
  let removed = 0
  for (const c of cuts) {
    if (sourceMs <= c.startMs) break
    if (sourceMs < c.endMs) return c.startMs - removed
    removed += c.endMs - c.startMs
  }
  return sourceMs - removed
}

/**
 * Maps an edited time back to a source time. At a cut boundary this returns the
 * time just after the cut, which is the frame the viewer actually sees.
 */
export const editedToSource = (cuts: ReadonlyArray<Cut>, editedMs: number): number => {
  let source = editedMs
  for (const c of cuts) {
    if (source < c.startMs) break
    source += c.endMs - c.startMs
  }
  return source
}

export interface Segment {
  readonly startMs: number
  readonly endMs: number
}

/** The kept parts of the source, in order. */
export const keptSegments = (cuts: ReadonlyArray<Cut>, durationMs: number): Array<Segment> => {
  const out: Array<Segment> = []
  let cursor = 0
  for (const c of normalizeCuts(cuts, durationMs)) {
    if (c.startMs > cursor) out.push({ startMs: cursor, endMs: c.startMs })
    cursor = Math.max(cursor, c.endMs)
  }
  if (cursor < durationMs) out.push({ startMs: cursor, endMs: durationMs })
  return out
}

export interface Clip extends Segment {
  /** Stable index of the clip in source order, counting only kept clips. */
  readonly index: number
}

/** Kept segments further divided at the splits. These are the clips on the timeline. */
export const clips = (cuts: ReadonlyArray<Cut>, splits: ReadonlyArray<number>, durationMs: number): Array<Clip> => {
  const sortedSplits = [...splits].sort((a, b) => a - b)
  const out: Array<Clip> = []
  for (const seg of keptSegments(cuts, durationMs)) {
    let start = seg.startMs
    for (const s of sortedSplits) {
      if (s > start && s < seg.endMs) {
        out.push({ startMs: start, endMs: s, index: out.length })
        start = s
      }
    }
    out.push({ startMs: start, endMs: seg.endMs, index: out.length })
  }
  return out
}

export const addSplit = (splits: ReadonlyArray<number>, t: number): Array<number> =>
  splits.some((s) => Math.abs(s - t) < 1) ? [...splits] : [...splits, t].sort((a, b) => a - b)

// ---------------------------------------------------------------------------
// History

const snapshot = (list: EditList): EditState => ({ cuts: list.cuts, splits: list.splits })

/** Applies a change as one undoable step. A change that alters nothing adds no history. */
export const commit = (list: EditList, next: EditState): EditList => {
  if (sameState(snapshot(list), next)) return list
  const past = [...list.past, snapshot(list)]
  return {
    ...list,
    cuts: next.cuts,
    splits: next.splits,
    past: past.length > HISTORY_LIMIT ? past.slice(past.length - HISTORY_LIMIT) : past,
    future: []
  }
}

export const undo = (list: EditList): EditList => {
  const prev = list.past[list.past.length - 1]
  if (!prev) return list
  return {
    ...list,
    cuts: prev.cuts,
    splits: prev.splits,
    past: list.past.slice(0, -1),
    future: [snapshot(list), ...list.future]
  }
}

export const redo = (list: EditList): EditList => {
  const next = list.future[0]
  if (!next) return list
  return {
    ...list,
    cuts: next.cuts,
    splits: next.splits,
    past: [...list.past, snapshot(list)],
    future: list.future.slice(1)
  }
}

const sameState = (a: EditState, b: EditState): boolean =>
  a.cuts.length === b.cuts.length &&
  a.splits.length === b.splits.length &&
  a.cuts.every((c, i) => c.startMs === b.cuts[i]!.startMs && c.endMs === b.cuts[i]!.endMs) &&
  a.splits.every((s, i) => s === b.splits[i])

// ---------------------------------------------------------------------------
// Words and cuts

/** Longest part of a pause kept next to a cut, so edited speech doesn't sound clipped. */
export const PAUSE_KEEP_MS = 150

/** A word counts as cut when its middle falls inside a cut. */
export const isWordCut = (cuts: ReadonlyArray<Cut>, word: Word): boolean =>
  // Whisper sometimes gives the last word no length, at the very end of the
  // recording. Looking just before its end still finds a cut that runs to the end.
  isInCut(cuts, Math.min((word.startMs + word.endMs) / 2, word.endMs - 0.5))

/**
 * The source range to cut for words[first..last]. It runs from the start of the
 * first word to the start of the next kept word, leaving at most 150 ms of the
 * pause before that word.
 */
export const wordRangeCut = (
  words: ReadonlyArray<Word>,
  cuts: ReadonlyArray<Cut>,
  first: number,
  last: number
): Cut => {
  const a = words[Math.min(first, last)]!
  const b = words[Math.max(first, last)]!
  let next: Word | undefined
  for (let i = Math.max(first, last) + 1; i < words.length; i++) {
    const w = words[i]!
    if (!isWordCut(cuts, w)) {
      next = w
      break
    }
  }
  if (!next) return { startMs: a.startMs, endMs: b.endMs }
  const gap = Math.max(0, next.startMs - b.endMs)
  const keep = Math.min(PAUSE_KEEP_MS, gap)
  return { startMs: a.startMs, endMs: Math.max(b.endMs, next.startMs - keep) }
}

/** The source range that restoring words[first..last] brings back. */
export const wordRangeRestore = (words: ReadonlyArray<Word>, first: number, last: number): Cut => {
  const lo = Math.min(first, last)
  const hi = Math.max(first, last)
  const a = words[lo]!
  const b = words[hi]!
  const next = words[hi + 1]
  return {
    startMs: a.startMs,
    endMs: next ? Math.max(b.endMs, next.startMs) : b.endMs
  }
}

/** Cuts words[first..last], or restores them if all of them are already cut. */
export const toggleWords = (
  words: ReadonlyArray<Word>,
  cuts: ReadonlyArray<Cut>,
  first: number,
  last: number,
  durationMs: number
): Array<Cut> => {
  const lo = Math.min(first, last)
  const hi = Math.max(first, last)
  const range = words.slice(lo, hi + 1)
  const allCut = range.length > 0 && range.every((w) => isWordCut(cuts, w))
  if (allCut) {
    const r = wordRangeRestore(words, lo, hi)
    return removeCut(cuts, r.startMs, r.endMs)
  }
  const r = wordRangeCut(words, cuts, lo, hi)
  return addCut(cuts, r.startMs, r.endMs, durationMs)
}

/**
 * Moves one edge of a clip. Moving an edge inward cuts the part it leaves;
 * moving it outward restores part of the neighboring cut.
 */
export const trimClip = (
  cuts: ReadonlyArray<Cut>,
  clip: Segment,
  edge: "start" | "end",
  toMs: number,
  durationMs: number
): Array<Cut> => {
  const t = Math.max(0, Math.min(durationMs, toMs))
  if (edge === "start") {
    if (t > clip.startMs) return addCut(cuts, clip.startMs, Math.min(t, clip.endMs - 1), durationMs)
    if (t < clip.startMs) return removeCut(cuts, t, clip.startMs)
  } else {
    if (t < clip.endMs) return addCut(cuts, Math.max(t, clip.startMs + 1), clip.endMs, durationMs)
    if (t > clip.endMs) return removeCut(cuts, clip.endMs, t)
  }
  return [...cuts]
}
