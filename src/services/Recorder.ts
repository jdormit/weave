import { Context, Effect, Layer } from "effect"
import { RecorderFailed } from "../domain/errors.ts"
import type { StoreError } from "./RecordingStore.ts"
import { RecordingStore } from "./RecordingStore.ts"
import type { CaptureSession } from "./Capture.ts"

export type RecorderPhase = "idle" | "recording" | "paused" | "stopped"

export interface TakeResult {
  /** Camera recorder start time minus screen recorder start time. */
  readonly cameraOffsetMs: number
  readonly elapsedMs: number
  readonly screenMimeType: string
}

/** Controls for one recording. One handle can record several takes (restart), but saves only the last. */
export interface RecorderHandle {
  readonly recordingId: string
  /** Starts a take. Both recorders start in the same tick. */
  readonly start: Effect.Effect<void, RecorderFailed>
  readonly pause: Effect.Effect<void>
  readonly resume: Effect.Effect<void>
  /** Throws away the current take. Call start again for a new one. */
  readonly discardTake: Effect.Effect<void, StoreError>
  /** Ends the take and waits until every chunk is written. */
  readonly stop: Effect.Effect<TakeResult, StoreError>
  readonly phase: () => RecorderPhase
  /** Recorded time, not counting pauses. */
  readonly elapsedMs: () => number
  /** Called when a chunk fails to save, such as when storage runs out. */
  onError: ((error: StoreError | RecorderFailed) => void) | undefined
}

export const pickMimeType = (kind: "screen" | "camera", withAudio: boolean): string => {
  const candidates = kind === "screen" && withAudio
    ? ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"]
    : ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"]
  return candidates.find((m) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(m)) ?? "video/webm"
}

const CHUNK_MS = 1000

/**
 * Runs the screen and camera MediaRecorders. Each recorder sends a chunk every
 * second, and each chunk is written to OPFS right away, so a crash loses at
 * most a second.
 */
export class Recorder extends Context.Service<Recorder, {
  create(session: CaptureSession, recordingId: string): Effect.Effect<RecorderHandle>
}>()("weave/Recorder") {
  static readonly layer = Layer.effect(
    Recorder,
    Effect.gen(function*() {
      const store = yield* RecordingStore
      return Recorder.of({
        create: (session, recordingId) => Effect.sync(() => makeHandle(store, session, recordingId))
      })
    })
  )
}

const makeHandle = (store: RecordingStore["Service"], session: CaptureSession, recordingId: string): RecorderHandle => {
  let phase: RecorderPhase = "idle"
  let take = 0
  let screenRec: MediaRecorder | null = null
  let cameraRec: MediaRecorder | null = null
  let screenStart = 0
  let cameraStart = 0
  let accumulated = 0
  let runningSince = 0
  let writes: Promise<void> = Promise.resolve()
  const screenMime = pickMimeType("screen", session.hasAudio)
  const cameraMime = pickMimeType("camera", false)

  const handle: RecorderHandle = {
    recordingId,
    onError: undefined,
    phase: () => phase,
    elapsedMs: () => accumulated + (phase === "recording" ? performance.now() - runningSince : 0),
    start: Effect.try({
      try: () => {
        take++
        const thisTake = take
        let screenIndex = 0
        let cameraIndex = 0
        const enqueue = (kind: "screen" | "camera", index: number, data: Blob) => {
          if (data.size === 0) return
          writes = writes.then(async () => {
            if (thisTake !== take) return
            await Effect.runPromise(
              store.appendChunk(recordingId, kind, index, data).pipe(
                Effect.tapError((e) => Effect.sync(() => handle.onError?.(e))),
                Effect.ignore
              )
            )
          })
        }
        screenRec = new MediaRecorder(session.screen, { mimeType: screenMime, videoBitsPerSecond: 6_000_000 })
        screenRec.ondataavailable = (e) => enqueue("screen", screenIndex++, e.data)
        screenRec.onstart = () => {
          screenStart = performance.now()
        }
        screenRec.onerror = () => handle.onError?.(new RecorderFailed({ message: "The screen recorder stopped." }))
        if (session.camera) {
          cameraRec = new MediaRecorder(session.camera, { mimeType: cameraMime, videoBitsPerSecond: 2_000_000 })
          cameraRec.ondataavailable = (e) => enqueue("camera", cameraIndex++, e.data)
          cameraRec.onstart = () => {
            cameraStart = performance.now()
          }
        }
        // Start both in the same tick so they line up. The small remaining gap is measured and saved.
        screenStart = cameraStart = performance.now()
        screenRec.start(CHUNK_MS)
        cameraRec?.start(CHUNK_MS)
        phase = "recording"
        accumulated = 0
        runningSince = performance.now()
      },
      catch: (e) => new RecorderFailed({ message: e instanceof Error ? e.message : String(e) })
    }),
    pause: Effect.sync(() => {
      if (phase !== "recording") return
      screenRec?.pause()
      cameraRec?.pause()
      accumulated += performance.now() - runningSince
      phase = "paused"
    }),
    resume: Effect.sync(() => {
      if (phase !== "paused") return
      screenRec?.resume()
      cameraRec?.resume()
      runningSince = performance.now()
      phase = "recording"
    }),
    discardTake: Effect.gen(function*() {
      take++
      yield* Effect.promise(() => stopRecorders(screenRec, cameraRec))
      yield* Effect.promise(() => writes)
      screenRec = null
      cameraRec = null
      phase = "idle"
      accumulated = 0
      yield* store.clearChunks(recordingId)
    }),
    stop: Effect.gen(function*() {
      if (phase === "recording") accumulated += performance.now() - runningSince
      phase = "stopped"
      yield* Effect.promise(() => stopRecorders(screenRec, cameraRec))
      // Wait for the last chunks to reach storage.
      yield* Effect.promise(() => writes)
      return {
        cameraOffsetMs: cameraRec ? cameraStart - screenStart : 0,
        elapsedMs: accumulated,
        screenMimeType: screenMime
      }
    })
  }
  return handle
}

const stopRecorders = (...recs: Array<MediaRecorder | null>) =>
  Promise.all(
    recs.map((rec) =>
      rec && rec.state !== "inactive"
        ? new Promise<void>((resolve) => {
          // The final dataavailable event fires before stop.
          rec.addEventListener("stop", () => resolve(), { once: true })
          rec.stop()
        })
        : Promise.resolve()
    )
  ).then(() => undefined)
