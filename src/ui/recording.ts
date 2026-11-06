import { Effect } from "effect"
import * as Atom from "effect/reactivity/Atom"
import { defaultOverlay, type Recording, type Settings as SettingsType } from "../domain/schema.ts"
import { Capture, type CaptureSession } from "../services/Capture.ts"
import { Recorder, type RecorderHandle } from "../services/Recorder.ts"
import { RecordingStore } from "../services/RecordingStore.ts"
import { run } from "../services/runtime.ts"
import { finalizeRecording } from "../services/workflows.ts"
import { defaultTitle } from "./format.ts"
import { navigate } from "./router.ts"
import { refreshRecordings, registry, startTranscription, toastError } from "./state.ts"

export type Phase =
  | "setup"
  | "starting"
  | "countdown"
  | "recording"
  | "paused"
  | "confirmRestart"
  | "confirmCancel"
  | "saving"

export interface SessionState {
  readonly phase: Phase
  /** The phase to go back to when a confirmation is dismissed. */
  readonly before: Phase
  readonly count: number
  readonly surfaceLabel: string
  readonly surfaceType: string
  readonly cameraStream: MediaStream | null
  /** Show the camera with its background blurred. */
  readonly blur: boolean
  readonly pip: boolean
}

const initial: SessionState = {
  phase: "setup",
  before: "setup",
  count: 3,
  surfaceLabel: "",
  surfaceType: "browser",
  cameraStream: null,
  blur: false,
  pip: false
}

export const sessionAtom = Atom.make<SessionState>(initial).pipe(Atom.keepAlive)
export const elapsedAtom = Atom.make(0).pipe(Atom.keepAlive)

const set = (patch: Partial<SessionState>) => registry.update(sessionAtom, (s) => ({ ...s, ...patch }))
const get = () => registry.get(sessionAtom)

let capture: CaptureSession | null = null
let handle: RecorderHandle | null = null
let countdownTimer: ReturnType<typeof setInterval> | undefined
let elapsedTimer: ReturnType<typeof setInterval> | undefined
let pipWindow: Window | null = null
/** Set by the Record screen; renders the floating controls into a Picture-in-Picture window. */
export let mountPip: ((win: Window) => () => void) | null = null
export const setPipMounter = (f: typeof mountPip) => {
  mountPip = f
}
let unmountPip: (() => void) | null = null

const COUNTDOWN = 3

const openPip = async () => {
  const dpip = (window as Window & {
    documentPictureInPicture?: { requestWindow(o: { width: number; height: number }): Promise<Window> }
  }).documentPictureInPicture
  if (!dpip || !mountPip) return
  try {
    const win = await dpip.requestWindow({ width: 300, height: 340 })
    // Copy Weave's styles into the floating window.
    for (const node of document.querySelectorAll("link[rel=stylesheet], style")) {
      win.document.head.appendChild(node.cloneNode(true))
    }
    win.document.documentElement.dataset.theme = document.documentElement.dataset.theme ?? ""
    win.document.title = "Weave"
    pipWindow = win
    unmountPip = mountPip(win)
    set({ pip: true })
    win.addEventListener("pagehide", () => {
      unmountPip?.()
      unmountPip = null
      pipWindow = null
      set({ pip: false })
    })
  } catch {
    // Without a user gesture or support, the controls stay in Weave's tab.
  }
}

const closePip = () => {
  unmountPip?.()
  unmountPip = null
  pipWindow?.close()
  pipWindow = null
}

const startElapsed = () => {
  clearInterval(elapsedTimer)
  elapsedTimer = setInterval(() => registry.set(elapsedAtom, handle?.elapsedMs() ?? 0), 200)
}

const runCountdown = () =>
  new Promise<boolean>((resolve) => {
    set({ phase: "countdown", count: COUNTDOWN })
    let n = COUNTDOWN
    clearInterval(countdownTimer)
    countdownTimer = setInterval(() => {
      if (get().phase !== "countdown") {
        clearInterval(countdownTimer)
        resolve(false)
        return
      }
      n--
      if (n <= 0) {
        clearInterval(countdownTimer)
        resolve(true)
      } else {
        set({ count: n })
      }
    }, 1000)
  })

const beginTake = async () => {
  const go = await runCountdown()
  if (!go || !handle) return
  await run(handle.start)
  registry.set(elapsedAtom, 0)
  set({ phase: "recording" })
  startElapsed()
}

const reset = () => {
  clearInterval(countdownTimer)
  clearInterval(elapsedTimer)
  capture?.stop()
  capture = null
  handle = null
  closePip()
  registry.set(elapsedAtom, 0)
  registry.set(sessionAtom, initial)
}

/** Starts sharing, opens the floating controls, and counts down. Call from a click. */
export const startSession = async (prefs: SettingsType) => {
  if (get().phase !== "setup") return
  set({ phase: "starting" })
  try {
    capture = await run(
      Effect.gen(function*() {
        return yield* (yield* Capture).start({
          source: prefs.source,
          cameraId: prefs.cameraId,
          micId: prefs.micId,
          includeSystemAudio: prefs.includeSystemAudio && prefs.source !== "window"
        })
      })
    )
  } catch (e) {
    set({ phase: "setup" })
    toastError(e)
    return
  }
  const session = capture
  const now = Date.now()
  const recording: Recording = {
    id: crypto.randomUUID(),
    title: defaultTitle(now),
    createdAt: now,
    durationMs: 0,
    status: "recording",
    screen: { width: 0, height: 0, mimeType: "video/webm" },
    hasCamera: session.camera !== null,
    hasAudio: session.hasAudio,
    cameraOffsetMs: 0,
    overlay: { ...defaultOverlay, blur: session.camera !== null && prefs.blurBackground },
    transcriptStatus: "none"
  }
  try {
    handle = await run(
      Effect.gen(function*() {
        const store = yield* RecordingStore
        yield* store.put(recording)
        void Effect.runPromise(store.requestPersist)
        return yield* (yield* Recorder).create(session, recording.id)
      })
    )
  } catch (e) {
    reset()
    toastError(e)
    return
  }
  handle.onError = (e) => {
    toastError(e)
    void stopSession()
  }
  // Ending the share from the browser's own bar counts as Stop.
  session.display.getVideoTracks()[0]?.addEventListener("ended", () => {
    const p = get().phase
    if (p === "recording" || p === "paused" || p === "confirmRestart" || p === "confirmCancel") void stopSession()
    else if (p === "countdown") void cancelSession()
  })
  set({
    surfaceLabel: session.surfaceLabel,
    surfaceType: session.surfaceType,
    cameraStream: session.camera,
    blur: recording.overlay.blur
  })
  await openPip()
  await beginTake()
}

export const pauseSession = async () => {
  if (!handle || get().phase !== "recording") return
  await run(handle.pause)
  set({ phase: "paused" })
}

export const resumeSession = async () => {
  if (!handle || get().phase !== "paused") return
  await run(handle.resume)
  set({ phase: "recording" })
}

/** Asks before restarting or canceling. Pauses while asking, so nothing extra is recorded. */
export const askRestart = async () => {
  const p = get().phase
  if (p !== "recording" && p !== "paused") return
  if (p === "recording") await run(handle!.pause)
  set({ phase: "confirmRestart", before: p })
}

export const askCancel = async () => {
  const p = get().phase
  if (p === "countdown") return cancelSession()
  if (p !== "recording" && p !== "paused") return
  if (p === "recording") await run(handle!.pause)
  set({ phase: "confirmCancel", before: p })
}

export const dismissConfirm = async () => {
  const s = get()
  if (s.phase !== "confirmRestart" && s.phase !== "confirmCancel") return
  if (s.before === "recording") await run(handle!.resume)
  set({ phase: s.before })
}

/** Throws away the current take and starts again with the countdown, keeping the same screen share. */
export const restartSession = async () => {
  if (!handle) return
  clearInterval(elapsedTimer)
  try {
    await run(handle.discardTake)
  } catch (e) {
    toastError(e)
  }
  registry.set(elapsedAtom, 0)
  await beginTake()
}

/** Throws the recording away. Nothing is saved. */
export const cancelSession = async () => {
  const h = handle
  clearInterval(countdownTimer)
  set({ phase: "saving" })
  if (h) {
    await run(h.discardTake).catch(() => {})
    await run(Effect.gen(function*() { yield* (yield* RecordingStore).remove(h.recordingId) })).catch(toastError)
  }
  reset()
}

export const stopSession = async () => {
  const h = handle
  if (!h || get().phase === "saving") return
  set({ phase: "saving" })
  clearInterval(elapsedTimer)
  clearInterval(countdownTimer)
  try {
    const take = await run(h.stop)
    capture?.stop()
    closePip()
    await run(finalizeRecording(h.recordingId, take.cameraOffsetMs))
    reset()
    await refreshRecordings()
    navigate(`/r/${encodeURIComponent(h.recordingId)}`)
    startTranscription(h.recordingId)
  } catch (e) {
    toastError(e)
    reset()
    await refreshRecordings()
  }
}
