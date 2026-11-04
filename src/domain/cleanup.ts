import { addCut, isWordCut, normalizeCuts, totalCutMs, PAUSE_KEEP_MS } from "./editList.ts"
import type { Cut, Word } from "./schema.ts"

export const DEFAULT_MIN_PAUSE_MS = 1000
export const SHORTENED_PAUSE_MS = 500

export const FILLER_WORDS = ["um", "uh", "er", "ah", "hmm", "mm"] as const

/** Lowercases a word and strips punctuation, so "Um," matches "um". */
export const normalizeWord = (text: string): string =>
  text.toLowerCase().replace(/[^\p{L}\p{N}']/gu, "")

/** True for um, uh, er, ah, hmm and mm, including stretched spellings like "ummm". */
export const isFiller = (text: string): boolean => {
  const w = normalizeWord(text)
  return /^(u+m+|u+h+|e+r+|a+h+|h+m+|m{2,})$/.test(w)
}

/** Audio as 16 kHz mono samples, used to confirm that a gap is really quiet. */
export interface AudioLevels {
  readonly sampleRate: number
  readonly samples: Float32Array
}

/** RMS level in dBFS of the audio between two times. */
export const levelDb = (audio: AudioLevels, startMs: number, endMs: number): number => {
  const a = Math.max(0, Math.floor((startMs / 1000) * audio.sampleRate))
  const b = Math.min(audio.samples.length, Math.ceil((endMs / 1000) * audio.sampleRate))
  if (b <= a) return -Infinity
  let sum = 0
  for (let i = a; i < b; i++) {
    const s = audio.samples[i]!
    sum += s * s
  }
  const rms = Math.sqrt(sum / (b - a))
  return rms > 0 ? 20 * Math.log10(rms) : -Infinity
}

/** Gaps quieter than this, relative to the loudest speech, count as silence. */
const QUIET_BELOW_PEAK_DB = 24

const speechPeakDb = (audio: AudioLevels): number => {
  // Loudest 100 ms window, as a reference for speech level.
  const win = Math.floor(audio.sampleRate / 10)
  let peak = -Infinity
  for (let i = 0; i + win <= audio.samples.length; i += win) {
    let sum = 0
    for (let j = i; j < i + win; j++) sum += audio.samples[j]! ** 2
    const db = 10 * Math.log10(sum / win || 1e-12)
    if (db > peak) peak = db
  }
  return peak
}

export interface CleanupPlan {
  readonly pauses: ReadonlyArray<Cut>
  readonly fillers: ReadonlyArray<{ readonly cut: Cut; readonly word: string }>
}

/**
 * Finds pauses longer than minPauseMs between words (and before the first or
 * after the last word) and plans cuts that shorten each to 0.5 s. When audio is
 * given, a pause is only cut where the audio is actually quiet.
 */
export const findPauses = (
  words: ReadonlyArray<Word>,
  cuts: ReadonlyArray<Cut>,
  durationMs: number,
  minPauseMs = DEFAULT_MIN_PAUSE_MS,
  audio?: AudioLevels
): Array<Cut> => {
  const kept = words.filter((w) => !isWordCut(cuts, w))
  const gaps: Array<{ start: number; end: number; edge: "start" | "mid" | "end" }> = []
  if (kept.length === 0) return []
  gaps.push({ start: 0, end: kept[0]!.startMs, edge: "start" })
  for (let i = 1; i < kept.length; i++) gaps.push({ start: kept[i - 1]!.endMs, end: kept[i]!.startMs, edge: "mid" })
  gaps.push({ start: kept[kept.length - 1]!.endMs, end: durationMs, edge: "end" })
  const peak = audio ? speechPeakDb(audio) : 0
  const out: Array<Cut> = []
  for (const g of gaps) {
    // Only the part of the gap not already cut counts as the pause.
    const remaining = g.end - g.start - overlapMs(cuts, g.start, g.end)
    if (remaining <= minPauseMs) continue
    const half = SHORTENED_PAUSE_MS / 2
    const cut =
      g.edge === "start"
        ? { startMs: g.start, endMs: g.end - SHORTENED_PAUSE_MS }
        : g.edge === "end"
          ? { startMs: g.start + SHORTENED_PAUSE_MS, endMs: g.end }
          : { startMs: g.start + half, endMs: g.end - half }
    if (cut.endMs - cut.startMs <= 0) continue
    if (audio && levelDb(audio, cut.startMs, cut.endMs) > peak - QUIET_BELOW_PEAK_DB) continue
    out.push(cut)
  }
  return out
}

/** Plans cuts for filler words that Whisper transcribed. */
export const findFillers = (words: ReadonlyArray<Word>, cuts: ReadonlyArray<Cut>): CleanupPlan["fillers"] => {
  const out: Array<{ cut: Cut; word: string }> = []
  words.forEach((w, i) => {
    if (isWordCut(cuts, w) || !isFiller(w.text)) return
    const next = words[i + 1]
    const end = next ? Math.max(w.endMs, next.startMs - Math.min(PAUSE_KEEP_MS, Math.max(0, next.startMs - w.endMs))) : w.endMs
    out.push({ cut: { startMs: w.startMs, endMs: end }, word: normalizeWord(w.text) })
  })
  return out
}

const overlapMs = (cuts: ReadonlyArray<Cut>, a: number, b: number): number =>
  cuts.reduce((sum, c) => sum + Math.max(0, Math.min(b, c.endMs) - Math.max(a, c.startMs)), 0)

/** Applies the planned cuts, returning the new cut list. */
export const applyCleanup = (cuts: ReadonlyArray<Cut>, planned: ReadonlyArray<Cut>, durationMs: number): Array<Cut> =>
  planned.reduce<Array<Cut>>((acc, c) => addCut(acc, c.startMs, c.endMs, durationMs), [...cuts])

/** Time saved by applying the planned cuts on top of the existing ones. */
export const savedMs = (cuts: ReadonlyArray<Cut>, planned: ReadonlyArray<Cut>, durationMs: number): number =>
  totalCutMs(applyCleanup(cuts, planned, durationMs)) - totalCutMs(normalizeCuts(cuts, durationMs))

/** Counts each filler word, for the "um ×3" chips. */
export const fillerCounts = (fillers: CleanupPlan["fillers"]): Array<[string, number]> => {
  const m = new Map<string, number>()
  for (const f of fillers) m.set(f.word, (m.get(f.word) ?? 0) + 1)
  return [...m.entries()].sort((a, b) => b[1] - a[1])
}
