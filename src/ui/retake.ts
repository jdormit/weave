import { Effect } from "effect"
import { makeSegmentTracker } from "../domain/camera.ts"
import { Capture } from "../services/Capture.ts"
import { pickMimeType } from "../services/Recorder.ts"
import { RecordingStore } from "../services/RecordingStore.ts"
import { run } from "../services/runtime.ts"
import { saveCameraTake } from "../services/workflows.ts"
import { mediaVersionAtom, takeAtom, type EditorContextValue, type Take } from "./editorState.ts"
import { cancelTranscription, recordingAtom, registry, startTranscription, toast, toastError, transcriptAtom } from "./state.ts"
import { moveTo } from "./transport.ts"

export interface TakeOptions {
  /** A camera stream that is already open (from the dialog's preview), or null for no camera. */
  readonly camera: MediaStream | null
  /** "none" to record no voice. */
  readonly micId: string
  readonly keepScreenAudio: boolean
}

const CHUNK_MS = 1000
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Ends the take in progress: true saves it, false throws it away. */
const finishers = new Map<string, (save: boolean) => Promise<void>>()

export const stopTake = (id: string) => finishers.get(id)?.(true)
export const cancelTake = (id: string) => finishers.get(id)?.(false)

/**
 * Records a new camera and voice for a recording that is already saved. The
 * video plays from the beginning, skipping the cut parts, while the camera
 * and microphone record. Stopping, or reaching the end, saves the take as the
 * recording's camera, and the new sound is transcribed again.
 */
export const startTake = async (c: EditorContextValue, options: TakeOptions) => {
  const id = c.id
  if (finishers.has(id)) return
  let mic: MediaStream | null = null
  const stopDevices = () => {
    options.camera?.getTracks().forEach((t) => t.stop())
    mic?.getTracks().forEach((t) => t.stop())
  }
  try {
    if (options.micId !== "none") {
      mic = await run(Effect.gen(function*() { return yield* (yield* Capture).openMic(options.micId) }))
    }
    await run(Effect.gen(function*() { yield* (yield* RecordingStore).clearChunks(id) }))
  } catch (e) {
    stopDevices()
    toastError(e)
    return
  }
  const videoTracks = options.camera?.getVideoTracks() ?? []
  const audioTracks = mic?.getAudioTracks() ?? []
  const hasVideo = videoTracks.length > 0
  const hasAudio = audioTracks.length > 0
  if (!hasVideo && !hasAudio) {
    stopDevices()
    return
  }

  let take: Take = { phase: "countdown", count: 3, camera: options.camera, keepScreenAudio: options.keepScreenAudio, startedAt: 0 }
  const set = (t: Partial<Take> | null) => {
    take = t === null ? take : { ...take, ...t }
    registry.set(takeAtom(id), t === null ? null : take)
  }
  set(take)

  let finished = false
  let recorder: MediaRecorder | null = null
  let writes: Promise<void> = Promise.resolve()
  let raf = 0
  let offPlaying: (() => void) | null = null
  const tracker = makeSegmentTracker()

  const finish = async (save: boolean) => {
    if (finished) return
    finished = true
    cancelAnimationFrame(raf)
    offPlaying?.()
    const player = c.player.current
    if (player?.playing()) player.pause()
    const rec = recorder
    if (rec && rec.state !== "inactive") {
      await new Promise<void>((resolve) => {
        rec.addEventListener("stop", () => resolve(), { once: true })
        rec.stop()
      })
    }
    await writes
    stopDevices()
    const segments = tracker.finish()
    if (!save || !rec || segments.length === 0) {
      await run(Effect.gen(function*() { yield* (yield* RecordingStore).clearChunks(id) })).catch(() => {})
      finishers.delete(id)
      set(null)
      return
    }
    set({ phase: "saving" })
    try {
      const updated = await run(saveCameraTake(id, { segments, hasVideo, hasAudio, keepScreenAudio: options.keepScreenAudio }))
      registry.set(recordingAtom(id), updated)
      registry.update(mediaVersionAtom(id), (v) => v + 1)
      // The sound changed, so the old transcript no longer matches it. Cuts are kept, since they are times.
      await cancelTranscription(id)
      registry.set(transcriptAtom(id), null)
      startTranscription(id)
      toast(hasVideo ? "Saved the new camera. Transcribing the new sound." : "Saved the new voiceover. Transcribing it now.")
    } catch (e) {
      toastError(e)
    } finally {
      finishers.delete(id)
      set(null)
    }
  }
  finishers.set(id, finish)

  // Count down while the preview switches to the live camera.
  for (let n = 3; n > 0; n--) {
    set({ count: n })
    await sleep(1000)
    if (finished) return
  }
  const player = c.player.current
  if (!player) {
    toastError(new Error("The video isn't ready to play."))
    await finish(false)
    return
  }

  const stream = new MediaStream([...videoTracks, ...audioTracks])
  const mimeType = hasVideo ? pickMimeType(hasAudio ? "screen" : "camera", hasAudio) : "audio/webm;codecs=opus"
  try {
    recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 2_000_000 })
  } catch (e) {
    toastError(e)
    await finish(false)
    return
  }
  let index = 0
  recorder.ondataavailable = (e) => {
    if (e.data.size === 0) return
    const n = index++
    const data = e.data
    writes = writes.then(() =>
      run(Effect.gen(function*() { yield* (yield* RecordingStore).appendChunk(id, "camera", n, data) })).catch((err) => {
        toastError(err)
        void finish(false)
      })
    )
  }

  // Start from the beginning; the start marker goes there too, so stopping returns to it.
  moveTo(c, 0)
  let started = false
  offPlaying = player.onPlayingChange((playing) => {
    if (playing) started = true
    // The video reached its end, or someone stopped it.
    else if (started) void finish(true)
  })
  recorder.start(CHUNK_MS)
  const startedAt = performance.now()
  player.play()
  set({ phase: "recording", startedAt })

  const tick = () => {
    if (finished) return
    if (player.playing()) tracker.observe(player.currentMs(), performance.now() - startedAt, player.currentRate())
    raf = requestAnimationFrame(tick)
  }
  raf = requestAnimationFrame(tick)
}
