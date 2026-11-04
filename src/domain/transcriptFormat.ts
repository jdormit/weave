import { isWordCut, sourceToEdited, editedDuration, normalizeCuts } from "./editList.ts"
import type { Cut, TranscriptExport, Word } from "./schema.ts"

/** A pause longer than this starts a new paragraph. */
export const PARAGRAPH_GAP_MS = 1500

export interface Paragraph {
  readonly startMs: number
  /** Index of the first word in the transcript's word list. */
  readonly firstIndex: number
  readonly words: ReadonlyArray<Word>
}

export const paragraphs = (words: ReadonlyArray<Word>, gapMs = PARAGRAPH_GAP_MS): Array<Paragraph> => {
  const out: Array<{ startMs: number; firstIndex: number; words: Array<Word> }> = []
  words.forEach((w, i) => {
    const prev = words[i - 1]
    const last = out[out.length - 1]
    if (!last || !prev || w.startMs - prev.endMs > gapMs) {
      out.push({ startMs: w.startMs, firstIndex: i, words: [w] })
    } else {
      last.words.push(w)
    }
  })
  return out
}

/** Joins word tokens into readable text. Whisper words carry their own leading spaces. */
export const joinWords = (words: ReadonlyArray<Word>): string =>
  words.map((w) => w.text).join("").replace(/\s+/g, " ").trim()

export const keptWords = (words: ReadonlyArray<Word>, cuts: ReadonlyArray<Cut>): Array<Word> =>
  words.filter((w) => !isWordCut(cuts, w))

/** Kept words in paragraphs, as plain text. */
export const toTxt = (words: ReadonlyArray<Word>, cuts: ReadonlyArray<Cut>): string => {
  const kept = keptWords(words, cuts)
  // Paragraph gaps are measured in edited time, so a cut pause joins paragraphs.
  const edited = kept.map((w) => ({
    ...w,
    startMs: sourceToEdited(cuts, w.startMs),
    endMs: sourceToEdited(cuts, w.endMs)
  }))
  return paragraphs(edited).map((p) => joinWords(p.words)).join("\n\n") + "\n"
}

export interface Cue {
  readonly startMs: number
  readonly endMs: number
  readonly text: string
}

export const MAX_LINE_CHARS = 42
export const MAX_CUE_MS = 7000

/**
 * Groups kept words into subtitle cues of at most 42 characters and 7 seconds,
 * with times in edited time. A cue also ends at a paragraph break.
 */
export const toCues = (words: ReadonlyArray<Word>, cuts: ReadonlyArray<Cut>): Array<Cue> => {
  const kept = keptWords(words, cuts).map((w) => ({
    text: w.text.trim(),
    startMs: sourceToEdited(cuts, w.startMs),
    endMs: Math.max(sourceToEdited(cuts, w.startMs), sourceToEdited(cuts, w.endMs))
  })).filter((w) => w.text.length > 0)
  const cues: Array<Cue> = []
  let cur: { startMs: number; endMs: number; parts: Array<string> } | undefined
  const flush = () => {
    if (cur) cues.push({ startMs: cur.startMs, endMs: cur.endMs, text: cur.parts.join(" ") })
    cur = undefined
  }
  for (const w of kept) {
    if (cur) {
      const text = [...cur.parts, w.text].join(" ")
      const tooLong = text.length > MAX_LINE_CHARS
      const tooSlow = w.endMs - cur.startMs > MAX_CUE_MS
      const pause = w.startMs - cur.endMs > PARAGRAPH_GAP_MS
      if (tooLong || tooSlow || pause) flush()
    }
    if (!cur) cur = { startMs: w.startMs, endMs: w.endMs, parts: [w.text] }
    else {
      cur.parts.push(w.text)
      cur.endMs = w.endMs
    }
  }
  flush()
  // A cue never overlaps the next one.
  return cues.map((c, i) => {
    const next = cues[i + 1]
    return next && c.endMs > next.startMs ? { ...c, endMs: next.startMs } : c
  })
}

const pad = (n: number, width = 2) => String(Math.floor(n)).padStart(width, "0")

export const formatTimestamp = (ms: number, sep: "," | "."): string => {
  const t = Math.max(0, Math.round(ms))
  const h = Math.floor(t / 3_600_000)
  const m = Math.floor((t % 3_600_000) / 60_000)
  const s = Math.floor((t % 60_000) / 1000)
  return `${pad(h)}:${pad(m)}:${pad(s)}${sep}${pad(t % 1000, 3)}`
}

export const toSrt = (words: ReadonlyArray<Word>, cuts: ReadonlyArray<Cut>): string =>
  toCues(words, cuts)
    .map((c, i) => `${i + 1}\n${formatTimestamp(c.startMs, ",")} --> ${formatTimestamp(c.endMs, ",")}\n${c.text}\n`)
    .join("\n")

export const toVtt = (words: ReadonlyArray<Word>, cuts: ReadonlyArray<Cut>): string =>
  "WEBVTT\n\n" +
  toCues(words, cuts)
    .map((c) => `${formatTimestamp(c.startMs, ".")} --> ${formatTimestamp(c.endMs, ".")}\n${c.text}\n`)
    .join("\n")

export const toJson = (input: {
  readonly title: string
  readonly modelId: string
  readonly language: string
  readonly durationMs: number
  readonly words: ReadonlyArray<Word>
  readonly cuts: ReadonlyArray<Cut>
}): TranscriptExport => {
  const cuts = normalizeCuts(input.cuts, input.durationMs)
  return {
    version: 1,
    title: input.title,
    modelId: input.modelId,
    language: input.language,
    durationMs: input.durationMs,
    editedDurationMs: editedDuration(cuts, input.durationMs),
    words: input.words.map((w) => ({ ...w, cut: isWordCut(cuts, w) })),
    cuts
  }
}

/** Formats a duration as m:ss, or h:mm:ss for an hour or more. */
export const formatClock = (ms: number): string => {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

/** Formats a time as mm:ss with tenths, for the player. */
export const formatPrecise = (ms: number): string => {
  const total = Math.max(0, ms)
  const m = Math.floor(total / 60_000)
  const s = Math.floor((total % 60_000) / 1000)
  return `${pad(m)}:${pad(s)}`
}
