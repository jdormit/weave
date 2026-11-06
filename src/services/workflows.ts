import { Effect, Option } from "effect"
import { StorageFailed } from "../domain/errors.ts"
import { cameraAudioOnSource, cameraToSource } from "../domain/camera.ts"
import type { CameraSegment, Recording, Transcript, Word } from "../domain/schema.ts"
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

interface DecodedSound {
  readonly rec: Recording
  /** The screen's sound on the source timeline, unless muted. */
  readonly screen: Float32Array | null
  /** The voiceover recorded in the editor, in the camera file's own time. */
  readonly camera: Float32Array | null
  /** The recording's sound mixed on the source timeline. */
  readonly mixed: Float32Array | null
}

/** Decoded 16 kHz audio per recording, kept for transcription, silence detection and the waveform. */
const audioCache = new Map<string, { key: string; sound: Promise<DecodedSound> }>()

const recordingSound = Effect.fn("recordingSound")(function*(id: string) {
  const store = yield* RecordingStore
  const rec = yield* store.get(id)
  const key = JSON.stringify([rec.hasAudio, rec.screenAudioMuted, rec.cameraAudio, rec.cameraOffsetMs, rec.cameraSegments])
  const cached = audioCache.get(id)
  if (cached && cached.key === key) return yield* Effect.promise(() => cached.sound)
  const screenFile = rec.hasAudio && !rec.screenAudioMuted ? Option.getOrNull(yield* store.readFile(id, "screen.webm")) : null
  const cameraFile = rec.cameraAudio ? Option.getOrNull(yield* store.readFile(id, "camera.webm")) : null
  const p = (async (): Promise<DecodedSound> => {
    const screen = screenFile ? await decodeAudio16k(screenFile).catch(() => null) : null
    const camera = cameraFile ? await decodeAudio16k(cameraFile).catch(() => null) : null
    const parts: Array<Float32Array> = []
    if (screen) parts.push(screen)
    if (camera) parts.push(cameraAudioOnSource(camera, rec, rec.durationMs, TRANSCRIBE_RATE))
    let mixed: Float32Array | null = null
    if (parts.length === 1) mixed = parts[0]!
    else if (parts.length > 1) {
      mixed = new Float32Array(Math.max(...parts.map((x) => x.length)))
      for (const part of parts) for (let i = 0; i < part.length; i++) mixed[i]! += part[i]!
    }
    return { rec, screen, camera, mixed }
  })()
  audioCache.set(id, { key, sound: p })
  return yield* Effect.promise(() => p)
})

/**
 * The recording's sound as 16 kHz mono on the source timeline: the screen's
 * sound (unless muted) mixed with a voiceover recorded in the editor.
 */
export const recordingAudio = Effect.fn("recordingAudio")(function*(id: string) {
  return (yield* recordingSound(id)).mixed
})

/** Silence between the parts of the transcription input, so no word spans two parts. */
const PART_GAP_SAMPLES = TRANSCRIBE_RATE

/**
 * What to transcribe, and how to turn its times into source times. A
 * voiceover recorded over sped-up parts is transcribed at the pace it was
 * spoken, not squeezed onto the source timeline, so the model hears natural
 * speech. Then it goes after the screen's sound, and its word times are
 * mapped back through the camera segments.
 */
export const transcriptionInput = (sound: DecodedSound): { audio: Float32Array | null; toSource: (ms: number) => number | null } => {
  const { rec, screen, camera } = sound
  const sped = rec.cameraSegments.some((s) => s.rate !== 1)
  if (!camera || !sped) return { audio: sound.mixed, toSource: (ms) => ms }
  const offset = screen ? screen.length + PART_GAP_SAMPLES : 0
  const audio = new Float32Array(offset + camera.length)
  if (screen) audio.set(screen)
  audio.set(camera, offset)
  const offsetMs = (offset / TRANSCRIBE_RATE) * 1000
  const screenEndMs = screen ? (screen.length / TRANSCRIBE_RATE) * 1000 : 0
  return {
    audio,
    toSource: (ms) => {
      if (screen && ms < screenEndMs) return ms
      if (ms < offsetMs) return null
      return cameraToSource(rec, ms - offsetMs, rec.durationMs)
    }
  }
}

/** Maps raw word times to source times, dropping words that land outside the video. */
const mapWords = (raw: ReadonlyArray<RawWord>, toSource: (ms: number) => number | null): Array<RawWord> =>
  raw.flatMap((w) => {
    const start = toSource(w.startMs)
    if (start === null) return []
    // A word can end exactly where its camera segment ends.
    const end = toSource(w.endMs) ?? toSource(Math.max(w.startMs, w.endMs - 1)) ?? start
    return [{ ...w, startMs: start, endMs: Math.max(start, end) }]
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
  const { audio, toSource } = transcriptionInput(yield* recordingSound(id))
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
        words.push(...toWords(mapWords(raw, toSource), recording.durationMs))
        // A voiceover is transcribed after the screen's sound, so keep words in time order.
        words.sort((a, b) => a.startMs - b.startMs)
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

/** A camera and voice take recorded in the editor, to replace the recording's camera file. */
export interface CameraTake {
  readonly segments: ReadonlyArray<CameraSegment>
  readonly hasVideo: boolean
  readonly hasAudio: boolean
  readonly keepScreenAudio: boolean
}

/**
 * Turns the chunks of a take into the recording's new camera file, and saves
 * how it lines up with the screen. The old camera file is replaced.
 */
export const saveCameraTake = Effect.fn("saveCameraTake")(function*(id: string, take: CameraTake) {
  const store = yield* RecordingStore
  const raw = yield* store.assembleChunks(id, "camera")
  if (Option.isNone(raw) || take.segments.length === 0) {
    yield* store.clearChunks(id)
    return yield* new StorageFailed({ message: "Nothing was recorded." })
  }
  const fixed = yield* Effect.tryPromise({
    try: () => remuxWebm(raw.value),
    catch: (e) => new StorageFailed({ message: `The camera recording couldn't be read: ${String(e)}` })
  })
  yield* store.writeFile(id, "camera.webm", fixed.blob)
  const updated = yield* store.update(id, (r) => ({
    ...r,
    hasCamera: take.hasVideo,
    cameraAudio: take.hasAudio,
    cameraOffsetMs: 0,
    cameraSegments: take.segments,
    screenAudioMuted: r.hasAudio && !take.keepScreenAudio,
    overlay: take.hasVideo ? { ...r.overlay, visible: true } : r.overlay
  }))
  yield* store.clearChunks(id)
  return updated
})
