import { outputPieces } from "./editList.ts"
import type { CameraSegment, Cut, Recording } from "./schema.ts"
import type { SpeedMap } from "./speed.ts"

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
    if (sourceMs >= s.startMs && sourceMs < s.endMs) return s.cameraMs + (sourceMs - s.startMs) / s.rate
  }
  return null
}

/**
 * How many milliseconds of source pass per millisecond of camera at a source
 * time. It's the speed the video played at while the camera recorded there.
 */
export const cameraRateAt = (timing: CameraTiming, sourceMs: number): number => {
  for (const s of timing.cameraSegments) {
    if (sourceMs >= s.startMs && sourceMs < s.endMs) return s.rate
  }
  return 1
}

/** The source time shown with a camera file time, or null where that part of the camera isn't used. */
export const cameraToSource = (timing: CameraTiming, cameraMs: number, durationMs = Infinity): number | null => {
  for (const s of effectiveSegments(timing, durationMs)) {
    const len = (s.endMs - s.startMs) / s.rate
    if (cameraMs >= s.cameraMs && cameraMs < s.cameraMs + len) return s.startMs + (cameraMs - s.cameraMs) * s.rate
  }
  return null
}

/** The camera timing as segments, for a recording of the given length. */
export const effectiveSegments = (timing: CameraTiming, durationMs: number): ReadonlyArray<CameraSegment> =>
  timing.cameraSegments.length > 0
    ? timing.cameraSegments
    : [{ startMs: Math.max(0, timing.cameraOffsetMs), endMs: durationMs, cameraMs: Math.max(0, -timing.cameraOffsetMs), rate: 1 }]

/** Whether a recording has any sound to play, transcribe or export. */
export const isAudible = (r: Pick<Recording, "hasAudio" | "screenAudioMuted" | "cameraAudio">): boolean =>
  (r.hasAudio && !r.screenAudioMuted) || r.cameraAudio

/** A stretch of a media file and where it lands in the edited output. */
export interface FileRange {
  readonly fromMs: number
  readonly toMs: number
  readonly outMs: number
  /** Where it ends in the output. Shorter than toMs - fromMs when sped up. */
  readonly outEndMs: number
}

/** The parts of the screen file that are kept, and where each lands in the edited output. */
export const screenRanges = (cuts: ReadonlyArray<Cut>, durationMs: number, speed?: SpeedMap): Array<FileRange> =>
  outputPieces(cuts, durationMs, speed).map((p) => ({ fromMs: p.startMs, toMs: p.endMs, outMs: p.outMs, outEndMs: p.outMs + p.outLenMs }))

/** The parts of the camera file that are kept, and where each lands in the edited output. */
export const cameraRanges = (cuts: ReadonlyArray<Cut>, durationMs: number, timing: CameraTiming, speed?: SpeedMap): Array<FileRange> => {
  const segs = effectiveSegments(timing, durationMs)
  const out: Array<FileRange> = []
  for (const p of outputPieces(cuts, durationMs, speed)) {
    for (const s of segs) {
      const a = Math.max(p.startMs, s.startMs)
      const b = Math.min(p.endMs, s.endMs)
      if (b <= a) continue
      out.push({
        fromMs: s.cameraMs + (a - s.startMs) / s.rate,
        toMs: s.cameraMs + (b - s.startMs) / s.rate,
        outMs: p.outMs + (a - p.startMs) / p.rate,
        outEndMs: p.outMs + (b - p.startMs) / p.rate
      })
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
      if (p.endMs > s.endMs) next.push({ ...p, startMs: s.endMs, cameraMs: p.cameraMs + (s.endMs - p.startMs) / p.rate })
    }
    next.push({ ...s })
    out = next
  }
  return out.filter((s) => s.endMs - s.startMs >= 1).sort((a, b) => a.startMs - b.startMs)
}

/**
 * Builds camera segments while a take records. Call observe with the video's
 * source time, the camera's recorded time, and the speed the video is playing
 * at, many times a second. A jump over a cut, a change of speed, or the video
 * stalling starts a new segment.
 */
export const makeSegmentTracker = (toleranceMs = 80) => {
  const segs: Array<{ startMs: number; endMs: number; cameraMs: number; rate: number }> = []
  return {
    observe(sourceMs: number, cameraMs: number, rate = 1) {
      const last = segs[segs.length - 1]
      if (last) {
        const expected = last.startMs + (cameraMs - last.cameraMs) * last.rate
        if (rate === last.rate && Math.abs(sourceMs - expected) <= toleranceMs * Math.max(1, rate)) {
          last.endMs = Math.max(last.endMs, sourceMs)
          return
        }
        // A change of speed: the old segment ran up to here.
        if (rate !== last.rate && Math.abs(sourceMs - expected) <= toleranceMs * Math.max(1, rate, last.rate)) {
          last.endMs = Math.max(last.endMs, sourceMs)
        } else if (sourceMs > expected) {
          // A jump ahead (over a cut): the segment ran right up to the jump.
          last.endMs = Math.max(last.endMs, expected)
        }
      }
      segs.push({ startMs: sourceMs, endMs: sourceMs, cameraMs, rate })
    },
    finish(): Array<CameraSegment> {
      return resolveSegments(segs.map((s) => ({ startMs: Math.round(s.startMs), endMs: Math.round(s.endMs), cameraMs: s.cameraMs, rate: s.rate })))
    }
  }
}

/**
 * Places camera audio on the source timeline. Both arrays are mono at the
 * same sample rate; the result is as long as the source. Used for the
 * waveform and pause detection, not for transcription.
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
    // Sped-up parts are squeezed by picking samples, which is fine for a waveform and for finding pauses.
    for (let i = 0; i < len && dst + i < out.length; i++) {
      const j = src + (s.rate === 1 ? i : Math.floor(i / s.rate))
      if (j >= camera.length) break
      out[dst + i] = camera[j]!
    }
  }
  return out
}
