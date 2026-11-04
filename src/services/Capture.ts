import { Context, Effect, Layer } from "effect"
import { CaptureFailed, PermissionDenied } from "../domain/errors.ts"
import type { SourceType } from "../domain/schema.ts"

export interface DeviceOption {
  readonly id: string
  readonly label: string
}

export interface Devices {
  readonly cameras: ReadonlyArray<DeviceOption>
  readonly mics: ReadonlyArray<DeviceOption>
}

export interface CaptureRequest {
  readonly source: SourceType
  /** "none" to record without a camera. */
  readonly cameraId: string
  /** "none" to record without a microphone. */
  readonly micId: string
  readonly includeSystemAudio: boolean
}

/** The live streams for one recording session. */
export interface CaptureSession {
  readonly display: MediaStream
  /** Display video plus the mixed audio track, if there is any audio. */
  readonly screen: MediaStream
  readonly camera: MediaStream | null
  readonly hasAudio: boolean
  readonly surfaceLabel: string
  readonly surfaceType: string
  /** Stops every track and closes the audio mixer. */
  readonly stop: () => void
}

const isPermissionError = (e: unknown) =>
  e instanceof DOMException && (e.name === "NotAllowedError" || e.name === "SecurityError" || e.name === "AbortError")

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

/**
 * Wraps getDisplayMedia, getUserMedia and device lists. Mixes the microphone
 * with tab or system audio into one track with Web Audio.
 */
export class Capture extends Context.Service<Capture, {
  readonly devices: Effect.Effect<Devices>
  /** Opens the camera (for the preview on the Record screen). */
  openCamera(cameraId: string): Effect.Effect<MediaStream, PermissionDenied | CaptureFailed>
  openMic(micId: string): Effect.Effect<MediaStream, PermissionDenied | CaptureFailed>
  start(request: CaptureRequest): Effect.Effect<CaptureSession, PermissionDenied | CaptureFailed>
}>()("weave/Capture") {
  static readonly layer = Layer.succeed(Capture, Capture.of({
    devices: Effect.promise(async () => {
      const all = await navigator.mediaDevices.enumerateDevices().catch(() => [] as Array<MediaDeviceInfo>)
      const pick = (kind: MediaDeviceKind, fallback: string) =>
        all
          .filter((d) => d.kind === kind && d.deviceId !== "")
          .map((d, i) => ({ id: d.deviceId, label: d.label || `${fallback} ${i + 1}` }))
      return { cameras: pick("videoinput", "Camera"), mics: pick("audioinput", "Microphone") }
    }),
    openCamera: (cameraId) => openCamera(cameraId),
    openMic: (micId) => openMic(micId),
    start: (request) =>
      Effect.gen(function*() {
        const display = yield* Effect.tryPromise({
          try: () =>
            navigator.mediaDevices.getDisplayMedia({
              video: { displaySurface: request.source, frameRate: { ideal: 30 } },
              audio: request.includeSystemAudio,
              // Chromium-only options. They're ignored where unsupported.
              selfBrowserSurface: "exclude",
              surfaceSwitching: "include",
              systemAudio: request.includeSystemAudio ? "include" : "exclude",
              preferCurrentTab: false
            } as DisplayMediaStreamOptions),
          catch: (e) => (isPermissionError(e) ? new PermissionDenied({ device: "screen" }) : new CaptureFailed({ message: message(e) }))
        })
        const stopDisplay = () => display.getTracks().forEach((t) => t.stop())
        const camera = request.cameraId === "none"
          ? null
          : yield* openCamera(request.cameraId).pipe(Effect.tapError(() => Effect.sync(stopDisplay)))
        const mic = request.micId === "none"
          ? null
          : yield* openMic(request.micId).pipe(
            Effect.tapError(() =>
              Effect.sync(() => {
                stopDisplay()
                camera?.getTracks().forEach((t) => t.stop())
              })
            )
          )
        const videoTrack = display.getVideoTracks()[0]
        if (!videoTrack) return yield* new CaptureFailed({ message: "The shared surface has no video." })
        const audioSources = [...display.getAudioTracks(), ...(mic?.getAudioTracks() ?? [])]
        let mixer: AudioContext | null = null
        const screen = new MediaStream([videoTrack])
        if (audioSources.length > 0) {
          mixer = new AudioContext({ sampleRate: 48000 })
          const dest = mixer.createMediaStreamDestination()
          for (const track of audioSources) {
            mixer.createMediaStreamSource(new MediaStream([track])).connect(dest)
          }
          const mixed = dest.stream.getAudioTracks()[0]
          if (mixed) screen.addTrack(mixed)
        }
        const settings = videoTrack.getSettings() as MediaTrackSettings & { displaySurface?: string }
        return {
          display,
          screen,
          camera,
          hasAudio: audioSources.length > 0,
          // Chrome labels tabs and screens with internal ids; only window titles are worth showing.
          surfaceLabel: /^(web-contents-media-stream|screen|window):/.test(videoTrack.label) ? "" : videoTrack.label,
          surfaceType: settings.displaySurface ?? request.source,
          stop: () => {
            stopDisplay()
            camera?.getTracks().forEach((t) => t.stop())
            mic?.getTracks().forEach((t) => t.stop())
            screen.getTracks().forEach((t) => t.stop())
            void mixer?.close().catch(() => {})
          }
        }
      })
  }))
}

const openCamera = (cameraId: string) =>
  Effect.tryPromise({
    try: () =>
      navigator.mediaDevices.getUserMedia({
        video: {
          ...(cameraId === "default" ? {} : { deviceId: { exact: cameraId } }),
          width: { ideal: 1280, max: 1280 },
          height: { ideal: 720, max: 720 },
          frameRate: { ideal: 30 }
        },
        audio: false
      }),
    catch: (e) => (isPermissionError(e) ? new PermissionDenied({ device: "camera" }) : new CaptureFailed({ message: message(e) }))
  })

const openMic = (micId: string) =>
  Effect.tryPromise({
    try: () =>
      navigator.mediaDevices.getUserMedia({
        audio: {
          ...(micId === "default" ? {} : { deviceId: { exact: micId } }),
          echoCancellation: true,
          noiseSuppression: true
        },
        video: false
      }),
    catch: (e) => (isPermissionError(e) ? new PermissionDenied({ device: "microphone" }) : new CaptureFailed({ message: message(e) }))
  })
