import { keptSegments } from "./editList.ts"
import type { CameraSegment, Cut, Recording } from "./schema.ts"

/**
 * How the camera file lines up with the screen recording. A camera recorded
 * with the screen is shifted by cameraOffsetMs. A camera re-recorded in the
 * editor is a list of segments, because the video skipped the cut parts while
 * it was being recorded.
 */
export interface CameraTiming {
  readonly cameraOffsetMs: number
  readonly cameraSegments: ReadonlyArray<CameraSegment>
}

/** The camera file time to show at a source time, or null where the camera has nothing. */
export const cameraTimeAt = (timing: CameraTiming, sourceMs: number): number | null => {
  const segs = timing.cameraSegments
  if (segs.length === 0) return Math.max(0, sourceMs - timing.cameraOffsetMs)
  for (const s of segs) {
    if (sourceMs >= s.startMs && sourceMs < s.endMs) return s.cameraMs + (sourceMs - s.startMs)
  }
  return null
}

/** The camera timing as segments, for a recording of the given length. */
export const effectiveSegments = (timing: CameraTiming, durationMs: number): ReadonlyArray<CameraSegment> =>
  timing.cameraSegments.length > 0
    ? timing.cameraSegments
    : [{ startMs: Math.max(0, timing.cameraOffsetMs), endMs: durationMs, cameraMs: Math.max(0, -timing.cameraOffsetMs) }]

/** Whether a recording has any sound to play, transcribe or export. */
export const isAudible = (r: Pick<Recording, "hasAudio" | "screenAudioMuted" | "cameraAudio">): boolean =>
  (r.hasAudio && !r.screenAudioMuted) || r.cameraAudio

/** A stretch of a media file and where it lands in the edited output. */
export interface FileRange {
  readonly fromMs: number
  readonly toMs: number
  readonly outMs: number
}

/** The parts of the screen file that are kept, and where each starts in the edited output. */
export const screenRanges = (cuts: ReadonlyArray<Cut>, durationMs: number): Array<FileRange> => {
  let out = 0
  return keptSegments(cuts, durationMs).map((k) => {
    const r = { fromMs: k.startMs, toMs: k.endMs, outMs: out }
    out += k.endMs - k.startMs
    return r
  })
}

/** The parts of the camera file that are kept, and where each starts in the edited output. */
export const cameraRanges = (cuts: ReadonlyArray<Cut>, durationMs: number, timing: CameraTiming): Array<FileRange> => {
  const segs = effectiveSegments(timing, durationMs)
  const out: Array<FileRange> = []
  for (const k of screenRanges(cuts, durationMs)) {
    for (const s of segs) {
      const a = Math.max(k.fromMs, s.startMs)
      const b = Math.min(k.toMs, s.endMs)
      if (b <= a) continue
      out.push({ fromMs: s.cameraMs + (a - s.startMs), toMs: s.cameraMs + (b - s.startMs), outMs: k.outMs + (a - k.fromMs) })
    }
  }
  return out.sort((x, y) => x.outMs - y.outMs)
}

/**
 * Makes segments not overlap. Where two overlap, the one recorded later wins,
 * since it is what the person was looking at last for that part.
 */
export const resolveSegments = (segs: ReadonlyArray<CameraSegment>): Array<CameraSegment> => {
  let out: Array<CameraSegment> = []
  for (const s of segs) {
    const next: Array<CameraSegment> = []
    for (const p of out) {
      if (p.endMs <= s.startMs || p.startMs >= s.endMs) {
        next.push(p)
        continue
      }
      if (p.startMs < s.startMs) next.push({ ...p, endMs: s.startMs })
      if (p.endMs > s.endMs) next.push({ startMs: s.endMs, endMs: p.endMs, cameraMs: p.cameraMs + (s.endMs - p.startMs) })
    }
    next.push({ ...s })
    out = next
  }
  return out.filter((s) => s.endMs - s.startMs >= 1).sort((a, b) => a.startMs - b.startMs)
}

/**
 * Builds camera segments while a take records. Call observe with the video's
 * source time and the camera's recorded time, many times a second. A jump over
 * a cut, or the video stalling, starts a new segment.
 */
export const makeSegmentTracker = (toleranceMs = 80) => {
  const segs: Array<{ startMs: number; endMs: number; cameraMs: number }> = []
  return {
    observe(sourceMs: number, cameraMs: number) {
      const last = segs[segs.length - 1]
      if (last) {
        const expected = last.startMs + (cameraMs - last.cameraMs)
        if (Math.abs(sourceMs - expected) <= toleranceMs) {
          last.endMs = Math.max(last.endMs, sourceMs)
          return
        }
        // A jump ahead (over a cut): the segment ran right up to the jump.
        if (sourceMs > expected) last.endMs = Math.max(last.endMs, expected)
      }
      segs.push({ startMs: sourceMs, endMs: sourceMs, cameraMs })
    },
    finish(): Array<CameraSegment> {
      return resolveSegments(segs.map((s) => ({ startMs: Math.round(s.startMs), endMs: Math.round(s.endMs), cameraMs: Math.round(s.cameraMs) })))
    }
  }
}

/**
 * Places camera audio on the source timeline. Both arrays are mono at the
 * same sample rate; the result is as long as the source.
 */
export const cameraAudioOnSource = (
  camera: Float32Array,
  timing: CameraTiming,
  durationMs: number,
  sampleRate: number
): Float32Array => {
  const out = new Float32Array(Math.ceil((durationMs / 1000) * sampleRate))
  for (const s of effectiveSegments(timing, durationMs)) {
    const dst = Math.round((s.startMs / 1000) * sampleRate)
    const src = Math.round((s.cameraMs / 1000) * sampleRate)
    const len = Math.round(((s.endMs - s.startMs) / 1000) * sampleRate)
    for (let i = 0; i < len && dst + i < out.length && src + i < camera.length; i++) out[dst + i] = camera[src + i]!
  }
  return out
}
