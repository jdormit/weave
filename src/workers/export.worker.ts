/// <reference lib="webworker" />
import {
  ALL_FORMATS,
  AudioSampleSink,
  AudioSampleSource,
  BlobSource,
  BufferTarget,
  CanvasSource,
  Input,
  Mp4OutputFormat,
  Output,
  QUALITY_HIGH,
  VideoSampleSink,
  WebMOutputFormat,
  canEncodeAudio,
  canEncodeVideo,
  type AudioCodec,
  type VideoCodec
} from "mediabunny"
import { createCompositor, type Compositor } from "../blur/compose.ts"
import { createSegmenter, type Segmenter } from "../blur/segmenter.ts"
import { keptSegments } from "../domain/editList.ts"
import type { ExportJob, ExportRequest, ExportResponse } from "./exportProtocol.ts"
import { outputSize, overlayRect } from "./exportProtocol.ts"

declare const self: DedicatedWorkerGlobalScope

const FPS = 30
let canceled = false
let currentOutput: Output | null = null
let segmenter: Promise<Segmenter> | null = null

const post = (msg: ExportResponse, transfer: Array<Transferable> = []) => self.postMessage(msg, transfer)

class Unsupported extends Error {}
class Canceled extends Error {}

interface Plan {
  readonly container: "mp4" | "webm"
  readonly video: VideoCodec
  readonly audio: AudioCodec | null
}

/** Tries H.264 with AAC, then H.264 with Opus in MP4, then VP9 with Opus in WebM. */
const choosePlan = async (width: number, height: number, withAudio: boolean): Promise<Plan> => {
  const avc = await canEncodeVideo("avc", { width, height })
  const aac = withAudio && (await canEncodeAudio("aac", { numberOfChannels: 2, sampleRate: 48000 }))
  const opus = withAudio && (await canEncodeAudio("opus", { numberOfChannels: 2, sampleRate: 48000 }))
  if (avc && (!withAudio || aac)) return { container: "mp4", video: "avc", audio: withAudio ? "aac" : null }
  if (avc && opus) return { container: "mp4", video: "avc", audio: "opus" }
  if ((await canEncodeVideo("vp9", { width, height })) && (!withAudio || opus)) {
    return { container: "webm", video: "vp9", audio: withAudio ? "opus" : null }
  }
  throw new Unsupported("No supported video encoder")
}

const checkCanceled = () => {
  if (canceled) throw new Canceled()
}

const run = async (job: ExportJob) => {
  canceled = false
  const screenInput = new Input({ source: new BlobSource(job.screen), formats: ALL_FORMATS })
  const cameraInput = job.camera ? new Input({ source: new BlobSource(job.camera), formats: ALL_FORMATS }) : null
  try {
    const screenTrack = await screenInput.getPrimaryVideoTrack()
    if (!screenTrack) throw new Error("The screen recording has no video.")
    const audioTrack = await screenInput.getPrimaryAudioTrack()
    const cameraTrack = job.overlay.visible && cameraInput ? await cameraInput.getPrimaryVideoTrack() : null

    const { width, height } = outputSize(screenTrack.displayWidth, screenTrack.displayHeight, job.resolution)
    const plan = await choosePlan(width, height, audioTrack !== null)

    const canvas = new OffscreenCanvas(width, height)
    const ctx = canvas.getContext("2d", { alpha: false })
    if (!ctx) throw new Error("Couldn't create a drawing surface.")

    const output = new Output({
      format: plan.container === "mp4" ? new Mp4OutputFormat({ fastStart: "in-memory" }) : new WebMOutputFormat(),
      target: new BufferTarget()
    })
    currentOutput = output
    const videoSource = new CanvasSource(canvas, { codec: plan.video, bitrate: QUALITY_HIGH, keyFrameInterval: 2 })
    output.addVideoTrack(videoSource, { frameRate: FPS })
    const audioSource = plan.audio && audioTrack ? new AudioSampleSource({ codec: plan.audio, bitrate: 128_000 }) : null
    if (audioSource) output.addAudioTrack(audioSource)
    await output.start()

    const segments = keptSegments(job.cuts, job.durationMs)
    const totalMs = segments.reduce((s, x) => s + x.endMs - x.startMs, 0)

    // Source times of every output frame. Frame boundaries are rounded on the
    // running edited time, so the total length stays within one frame.
    const frameTimes: Array<number> = []
    let editedStart = 0
    for (const seg of segments) {
      const editedEnd = editedStart + (seg.endMs - seg.startMs) / 1000
      const first = Math.round(editedStart * FPS)
      const last = Math.round(editedEnd * FPS)
      for (let f = first; f < last; f++) frameTimes.push(seg.startMs / 1000 + (f / FPS - editedStart))
      editedStart = editedEnd
    }

    const bubble = overlayRect(job.overlay, width, height)
    // Background blur: each camera frame is segmented and drawn blurred into camCanvas first.
    const blur = cameraTrack && job.overlay.blur
      ? {
        segmenter: await (segmenter ??= createSegmenter(self.location.origin).catch((e) => {
          segmenter = null
          throw e
        })),
        compositor: createCompositor(),
        canvas: new OffscreenCanvas(cameraTrack.displayWidth, cameraTrack.displayHeight)
      }
      : null

    const videoLoop = async () => {
      const screenSink = new VideoSampleSink(screenTrack)
      const screenFrames = screenSink.samplesAtTimestamps(frameTimes)
      const cameraSink = cameraTrack ? new VideoSampleSink(cameraTrack) : null
      const offsetSec = job.cameraOffsetMs / 1000
      const cameraFrames = cameraSink?.samplesAtTimestamps(frameTimes.map((t) => Math.max(0, t - offsetSec))) ?? null
      let lastProgress = 0
      for (let i = 0; i < frameTimes.length; i++) {
        checkCanceled()
        const screen = (await screenFrames.next()).value ?? null
        const cam = cameraFrames ? (await cameraFrames.next()).value ?? null : null
        ctx.fillStyle = "#000"
        ctx.fillRect(0, 0, width, height)
        if (screen) {
          screen.draw(ctx, 0, 0, width, height)
          screen.close()
        }
        if (cam) {
          if (blur) {
            await drawBlurred(blur, cam)
            cam.close()
            drawBubble(ctx, canvasFrame(blur.canvas), bubble)
          } else {
            drawBubble(ctx, cam, bubble)
            cam.close()
          }
        }
        await videoSource.add(i / FPS, 1 / FPS)
        const doneMs = ((i + 1) / FPS) * 1000
        if (doneMs - lastProgress > 250 || i === frameTimes.length - 1) {
          lastProgress = doneMs
          post({ type: "progress", doneMs: Math.min(doneMs, totalMs), totalMs })
        }
      }
      await screenFrames.return(undefined)
      await cameraFrames?.return(undefined)
    }

    const audioLoop = async () => {
      if (!audioSource || !audioTrack) return
      const sink = new AudioSampleSink(audioTrack)
      let outStart = 0
      for (const seg of segments) {
        const a = seg.startMs / 1000
        const b = seg.endMs / 1000
        for await (const sample of sink.samples(a, b)) {
          checkCanceled()
          const rate = sample.sampleRate
          const from = Math.max(0, Math.round((a - sample.timestamp) * rate))
          const to = Math.min(sample.numberOfFrames, Math.round((b - sample.timestamp) * rate))
          if (to <= from) {
            sample.close()
            continue
          }
          const part = from > 0 || to < sample.numberOfFrames ? sample.trim(from, to) : sample.clone()
          part.setTimestamp(outStart + Math.max(0, sample.timestamp + from / rate - a))
          sample.close()
          await audioSource.add(part)
          part.close()
        }
        outStart += b - a
      }
    }

    await Promise.all([videoLoop(), audioLoop()])
    checkCanceled()
    await output.finalize()
    const buffer = output.target.buffer
    if (!buffer) throw new Error("The encoder produced no data.")
    post(
      {
        type: "done",
        data: buffer,
        mimeType: plan.container === "mp4" ? "video/mp4" : "video/webm",
        extension: plan.container,
        videoCodec: plan.video,
        audioCodec: plan.audio
      },
      [buffer]
    )
  } finally {
    currentOutput = null
    screenInput.dispose()
    cameraInput?.dispose()
  }
}

type Drawable = {
  displayWidth: number
  displayHeight: number
  draw: (c: OffscreenCanvasRenderingContext2D, sx: number, sy: number, sw: number, sh: number, dx: number, dy: number, dw: number, dh: number) => void
}

const drawBlurred = async (
  blur: { segmenter: Segmenter; compositor: Compositor; canvas: OffscreenCanvas },
  cam: { displayWidth: number; displayHeight: number; draw: (c: OffscreenCanvasRenderingContext2D, dx: number, dy: number, dw: number, dh: number) => void }
) => {
  const { canvas } = blur
  if (canvas.width !== cam.displayWidth || canvas.height !== cam.displayHeight) {
    canvas.width = cam.displayWidth
    canvas.height = cam.displayHeight
  }
  const camCtx = canvas.getContext("2d")
  if (!camCtx) throw new Error("Couldn't create a drawing surface.")
  const mask = await blur.segmenter.segment(blur.compositor.sample(cam))
  blur.compositor.draw(cam, mask, camCtx, canvas.width, canvas.height)
}

/** Lets drawBubble crop a canvas the way it crops a video frame. */
const canvasFrame = (canvas: OffscreenCanvas): Drawable => ({
  displayWidth: canvas.width,
  displayHeight: canvas.height,
  draw: (c, sx, sy, sw, sh, dx, dy, dw, dh) => c.drawImage(canvas, sx, sy, sw, sh, dx, dy, dw, dh)
})

const drawBubble = (
  ctx: OffscreenCanvasRenderingContext2D,
  cam: Drawable,
  r: ReturnType<typeof overlayRect>
) => {
  // Crop the camera frame to the bubble's shape (cover fit).
  const srcAspect = cam.displayWidth / Math.max(1, cam.displayHeight)
  const dstAspect = r.w / r.h
  let sw = cam.displayWidth
  let sh = cam.displayHeight
  if (srcAspect > dstAspect) sw = sh * dstAspect
  else sh = sw / dstAspect
  const sx = (cam.displayWidth - sw) / 2
  const sy = (cam.displayHeight - sh) / 2
  ctx.save()
  ctx.beginPath()
  ctx.roundRect(r.x, r.y, r.w, r.h, r.radius)
  ctx.clip()
  cam.draw(ctx, sx, sy, sw, sh, r.x, r.y, r.w, r.h)
  ctx.restore()
}

self.onmessage = async (e: MessageEvent<ExportRequest>) => {
  const req = e.data
  if (req.type === "cancel") {
    canceled = true
    await currentOutput?.cancel().catch(() => {})
    return
  }
  try {
    await run(req)
  } catch (err) {
    if (err instanceof Canceled || canceled) post({ type: "canceled" })
    else post({ type: "error", message: err instanceof Error ? err.message : String(err), unsupported: err instanceof Unsupported })
  }
}
