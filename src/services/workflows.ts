import { Effect, Option } from "effect"
import { StorageFailed } from "../domain/errors.ts"
import type { Recording, Transcript, Word } from "../domain/schema.ts"
import { RecordingStore } from "./RecordingStore.ts"
import { Settings } from "./Settings.ts"
import { Transcriber } from "./Transcriber.ts"
import { decodeAudio16k, makeThumbnail, probe, remuxWebm, TRANSCRIBE_RATE } from "./media.ts"
import type { RawWord } from "../workers/transcribeProtocol.ts"

/**
 * Turns the saved chunks of a recording into its final files: joins the
 * chunks, rewrites each file with a duration and seek index, and makes a
 * thumbnail. Used after Stop and to recover a recording after a crash.
 */
export const finalizeRecording = Effect.fn("finalizeRecording")(function*(id: string, cameraOffsetMs?: number) {
  const store = yield* RecordingStore
  const rec = yield* store.get(id)
  const screenRaw = yield* store.assembleChunks(id, "screen")
  if (Option.isNone(screenRaw)) {
    return yield* new StorageFailed({ message: "Nothing was recorded." })
  }
  const fixScreen = yield* Effect.tryPromise({
    try: () => remuxWebm(screenRaw.value),
    catch: (e) => new StorageFailed({ message: `The screen recording couldn't be read: ${String(e)}` })
  })
  yield* store.writeFile(id, "screen.webm", fixScreen.blob)

  let hasCamera = false
  const cameraRaw = yield* store.assembleChunks(id, "camera")
  if (Option.isSome(cameraRaw)) {
    const fixed = yield* Effect.tryPromise(() => remuxWebm(cameraRaw.value)).pipe(Effect.option)
    if (Option.isSome(fixed)) {
      yield* store.writeFile(id, "camera.webm", fixed.value.blob)
      hasCamera = true
    }
  }

  const thumb = yield* Effect.tryPromise(() => makeThumbnail(fixScreen.blob, fixScreen.durationMs)).pipe(
    Effect.orElseSucceed(() => null)
  )
  if (thumb) yield* store.writeFile(id, "thumb.webp", thumb)

  const updated: Recording = {
    ...rec,
    status: "ready",
    durationMs: fixScreen.durationMs,
    screen: { width: fixScreen.width, height: fixScreen.height, mimeType: "video/webm" },
    hasCamera,
    cameraOffsetMs: cameraOffsetMs ?? rec.cameraOffsetMs
  }
  yield* store.put(updated)
  yield* store.clearChunks(id)
  return updated
})

/** Recordings whose saving never finished, such as after a crash. */
export const unfinishedRecordings = Effect.gen(function*() {
  const store = yield* RecordingStore
  const all = yield* store.list
  return all.filter((r) => r.status === "recording")
})

/** How much of an unfinished recording can be recovered. */
export const recoverableMs = Effect.fn("recoverableMs")(function*(id: string) {
  const store = yield* RecordingStore
  const raw = yield* store.assembleChunks(id, "screen")
  if (Option.isNone(raw)) return 0
  return yield* Effect.tryPromise(() => probe(raw.value)).pipe(
    Effect.map((p) => p.durationMs),
    Effect.orElseSucceed(() => 0)
  )
})

let wordCounter = 0
const newWordId = () => `w${Date.now().toString(36)}${(wordCounter++).toString(36)}`

/**
 * Gives words ids, and keeps their times inside the video. The audio track can
 * run a few milliseconds past the video, and words there could never be cut.
 */
export const toWords = (raw: ReadonlyArray<RawWord>, durationMs = Infinity): Array<Word> =>
  raw.map((w) => ({
    id: newWordId(),
    text: w.text,
    startMs: Math.min(w.startMs, durationMs),
    endMs: Math.min(w.endMs, durationMs)
  }))

/** Decoded 16 kHz audio per recording, kept for silence detection and the waveform. */
const audioCache = new Map<string, Promise<Float32Array | null>>()

export const recordingAudio = Effect.fn("recordingAudio")(function*(id: string) {
  const store = yield* RecordingStore
  const cached = audioCache.get(id)
  if (cached) return yield* Effect.promise(() => cached)
  const file = yield* store.readFile(id, "screen.webm")
  if (Option.isNone(file)) return null
  const p = decodeAudio16k(file.value).catch(() => null)
  audioCache.set(id, p)
  return yield* Effect.promise(() => p)
})

export const forgetAudio = (id: string) => audioCache.delete(id)

/**
 * Transcribes a recording with the model chosen in Settings. Each finished
 * piece is passed to onPartial as soon as it's ready. Cuts are kept, because
 * they are stored as times rather than word ids.
 */
export const transcribeRecording = Effect.fn("transcribeRecording")(function*(
  id: string,
  handlers: {
    onDownload?: (loaded: number, total: number) => void
    onProgress?: (done: number, total: number) => void
    onPartial?: (words: ReadonlyArray<Word>) => void
  }
) {
  const store = yield* RecordingStore
  const settings = yield* (yield* Settings).get
  const transcriber = yield* Transcriber
  const recording = yield* store.update(id, (r) => ({ ...r, transcriptStatus: "running" }))
  const audio = yield* recordingAudio(id)
  const words: Array<Word> = []
  const result = yield* Effect.gen(function*() {
    if (!audio || audio.length === 0) return { language: settings.language }
    return yield* transcriber.transcribe({
      audio,
      sampleRate: TRANSCRIBE_RATE,
      model: settings.model,
      language: settings.language,
      onDownload: handlers.onDownload,
      onProgress: handlers.onProgress,
      onChunk: (raw) => {
        words.push(...toWords(raw, recording.durationMs))
        handlers.onPartial?.([...words])
      }
    })
  }).pipe(
    Effect.tapError(() => store.update(id, (r) => ({ ...r, transcriptStatus: "error" })).pipe(Effect.ignore)),
    Effect.onInterrupt(() => store.update(id, (r) => ({ ...r, transcriptStatus: "none" })).pipe(Effect.ignore))
  )
  const transcript: Transcript = {
    recordingId: id,
    modelId: settings.model,
    language: result.language,
    words
  }
  yield* store.putTranscript(transcript)
  yield* store.update(id, (r) => ({ ...r, transcriptStatus: "done" }))
  return transcript
})
