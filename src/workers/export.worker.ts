/// <reference lib="webworker" />
import {
  ALL_FORMATS,
  AudioSampleSink,
  AudioSample,
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
  type InputAudioTrack,
  canEncodeVideo,
  type AudioCodec,
  type VideoCodec
} from "mediabunny"
import { createCompositor, type Compositor } from "../blur/compose.ts"
import { createSegmenter, type Segmenter } from "../blur/segmenter.ts"
import { cameraRanges, cameraTimeAt, screenRanges, type FileRange } from "../domain/camera.ts"
import { outputPieces } from "../domain/editList.ts"
import { TimeStretcher } from "../domain/stretch.ts"
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
    const screenAudio = job.screenAudioMuted ? null : await screenInput.getPrimaryAudioTrack()
    const cameraAudio = job.cameraAudio && cameraInput ? await cameraInput.getPrimaryAudioTrack() : null
    const cameraTrack = job.overlay.visible && cameraInput ? await cameraInput.getPrimaryVideoTrack() : null
    // The sound tracks to mix, each with the parts of its file that are kept.
    const audioInputs: Array<{ track: InputAudioTrack; ranges: ReadonlyArray<FileRange> }> = []
    if (screenAudio) audioInputs.push({ track: screenAudio, ranges: screenRanges(job.cuts, job.durationMs, job.speed) })
    if (cameraAudio) audioInputs.push({ track: cameraAudio, ranges: cameraRanges(job.cuts, job.durationMs, job, job.speed) })

    const { width, height } = outputSize(screenTrack.displayWidth, screenTrack.displayHeight, job.resolution)
    const plan = await choosePlan(width, height, audioInputs.length > 0)

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
    const audioSource = plan.audio && audioInputs.length > 0 ? new AudioSampleSource({ codec: plan.audio, bitrate: 128_000 }) : null
    if (audioSource) output.addAudioTrack(audioSource)
    await output.start()

    const segments = outputPieces(job.cuts, job.durationMs, job.speed)
    const totalMs = segments.reduce((s, x) => s + x.outLenMs, 0)

    // Source times of every output frame. Frame boundaries are rounded on the
    // running edited time, so the total length stays within one frame.
    const frameTimes: Array<number> = []
    for (const seg of segments) {
      const editedStart = seg.outMs / 1000
      const editedEnd = (seg.outMs + seg.outLenMs) / 1000
      const first = Math.round(editedStart * FPS)
      const last = Math.round(editedEnd * FPS)
      for (let f = first; f < last; f++) frameTimes.push(seg.startMs / 1000 + (f / FPS - editedStart) * seg.rate)
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
      // Camera time for each frame; null where the camera has nothing. Gaps reuse
      // the last time so the decoder never seeks backwards for nothing.
      const cameraTimes = frameTimes.map((t) => cameraTimeAt(job, t * 1000))
      let lastCam = 0
      const cameraFrames = cameraSink?.samplesAtTimestamps(cameraTimes.map((ms) => (lastCam = ms ?? lastCam) / 1000)) ?? null
      let lastProgress = 0
      for (let i = 0; i < frameTimes.length; i++) {
        checkCanceled()
        const screen = (await screenFrames.next()).value ?? null
        let cam = cameraFrames ? (await cameraFrames.next()).value ?? null : null
        if (cam && cameraTimes[i] === null) {
          cam.close()
          cam = null
        }
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
      if (!audioSource) return
      await mixAudio(audioInputs, totalMs, async (sample) => {
        await audioSource.add(sample)
      })
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

const MIX_RATE = 48000
const BLOCK = 4800

interface Piece {
  /** Where the piece starts in the edited output, in seconds. */
  readonly outSec: number
  readonly rate: number
  /** One or two channels. */
  readonly planes: ReadonlyArray<Float32Array>
}

/** The kept parts of one audio track, as pieces placed on the edited timeline. */
async function* pieces(track: InputAudioTrack, ranges: ReadonlyArray<FileRange>): AsyncGenerator<Piece> {
  const sink = new AudioSampleSink(track)
  for (const r of ranges) {
    const a = r.fromMs / 1000
    const b = r.toMs / 1000
    // Sped-up or slowed-down parts change length without changing pitch.
    const ratio = (r.toMs - r.fromMs) / Math.max(1e-6, r.outEndMs - r.outMs)
    const stretched = Math.abs(ratio - 1) > 0.001
    let stretcher: TimeStretcher | null = null
    let stretchRate = 0
    let produced = 0
    let started = false
    const fromStretcher = (planes: Array<Float32Array>): Piece | null => {
      if (planes[0]!.length === 0) return null
      const p = { outSec: r.outMs / 1000 + produced / stretchRate, rate: stretchRate, planes }
      produced += planes[0]!.length
      return p
    }
    for await (const sample of sink.samples(a, b)) {
      checkCanceled()
      const rate = sample.sampleRate
      const from = Math.max(0, Math.round((a - sample.timestamp) * rate))
      const to = Math.min(sample.numberOfFrames, Math.round((b - sample.timestamp) * rate))
      if (to > from) {
        const planes: Array<Float32Array> = []
        for (let c = 0; c < Math.min(2, sample.numberOfChannels); c++) {
          const buf = new Float32Array(to - from)
          sample.copyTo(buf, { planeIndex: c, format: "f32-planar", frameOffset: from, frameCount: to - from })
          planes.push(buf)
        }
        if (!stretched) {
          yield { outSec: r.outMs / 1000 + Math.max(0, sample.timestamp + from / rate - a), rate, planes }
        } else {
          if (!stretcher) {
            stretcher = new TimeStretcher(planes.length, rate, ratio)
            stretchRate = rate
            // A gap at the start of the range (the audio starting late) stays a gap.
            produced = Math.max(0, Math.round(((sample.timestamp + from / rate - a) / ratio) * rate))
          }
          started = true
          stretcher.push(planes)
          const piece = fromStretcher(stretcher.pull())
          if (piece) yield piece
        }
      }
      sample.close()
    }
    if (stretcher && started) {
      const piece = fromStretcher(stretcher.flush())
      if (piece) yield piece
    }
  }
}

/**
 * Mixes the kept parts of several audio tracks into one stereo 48 kHz stream
 * as long as the edited video. Reads the tracks side by side, so only a few
 * blocks are held in memory at a time.
 */
const mixAudio = async (
  inputs: ReadonlyArray<{ track: InputAudioTrack; ranges: ReadonlyArray<FileRange> }>,
  totalMs: number,
  emit: (sample: AudioSample) => Promise<void>
) => {
  const totalFrames = Math.round((totalMs / 1000) * MIX_RATE)
  const blocks = new Map<number, [Float32Array, Float32Array]>()
  const block = (i: number) => {
    let b = blocks.get(i)
    if (!b) blocks.set(i, (b = [new Float32Array(BLOCK), new Float32Array(BLOCK)]))
    return b
  }
  const add = (p: Piece) => {
    const start = Math.round(p.outSec * MIX_RATE)
    const len = p.planes[0]!.length
    const outLen = Math.round((len * MIX_RATE) / p.rate)
    const left = p.planes[0]!
    const right = p.planes[1] ?? left
    for (let k = 0; k < outLen; k++) {
      const f = start + k
      if (f >= totalFrames) break
      const src = p.rate === MIX_RATE ? k : Math.min(len - 1, Math.floor((k * p.rate) / MIX_RATE))
      const [l, r] = block(Math.floor(f / BLOCK))
      const at = f % BLOCK
      l[at]! += left[src]!
      r[at]! += right[src]!
    }
  }
  let flushed = 0
  const flush = async (untilFrame: number) => {
    while (flushed * BLOCK < totalFrames && (flushed + 1) * BLOCK <= untilFrame) {
      const frames = Math.min(BLOCK, totalFrames - flushed * BLOCK)
      const [l, r] = blocks.get(flushed) ?? [new Float32Array(BLOCK), new Float32Array(BLOCK)]
      const data = new Float32Array(frames * 2)
      for (let i = 0; i < frames; i++) {
        data[i] = Math.max(-1, Math.min(1, l[i]!))
        data[frames + i] = Math.max(-1, Math.min(1, r[i]!))
      }
      const sample = new AudioSample({ data, format: "f32-planar", numberOfChannels: 2, sampleRate: MIX_RATE, timestamp: (flushed * BLOCK) / MIX_RATE })
      await emit(sample)
      sample.close()
      blocks.delete(flushed)
      flushed++
    }
  }
  const streams = inputs.map((i) => ({ it: pieces(i.track, i.ranges), pos: 0, done: false }))
  while (streams.some((s) => !s.done)) {
    checkCanceled()
    // Read from whichever track is furthest behind.
    const s = streams.filter((x) => !x.done).reduce((a, b) => (b.pos < a.pos ? b : a))
    const next = await s.it.next()
    if (next.done) s.done = true
    else {
      add(next.value)
      s.pos = next.value.outSec + next.value.planes[0]!.length / next.value.rate
    }
    const open = streams.filter((x) => !x.done)
    // Everything before the slowest open track (less a block, for rounding) is final.
    if (open.length > 0) await flush(Math.floor(Math.min(...open.map((x) => x.pos)) * MIX_RATE) - BLOCK)
  }
  await flush(Infinity)
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
