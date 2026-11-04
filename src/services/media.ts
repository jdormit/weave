import {
  ALL_FORMATS,
  AudioBufferSink,
  BlobSource,
  BufferTarget,
  CanvasSink,
  Conversion,
  Input,
  Output,
  WebMOutputFormat
} from "mediabunny"

/** Helpers that read media files with mediabunny. They run on the main thread or in a worker. */

export interface RemuxResult {
  readonly blob: Blob
  readonly durationMs: number
  readonly width: number
  readonly height: number
}

const openInput = (blob: Blob) => new Input({ source: new BlobSource(blob), formats: ALL_FORMATS })

/**
 * Rewrites a MediaRecorder WebM file without re-encoding. MediaRecorder files
 * have no duration or seek index; the rewritten file has both, so seeking is
 * fast and reliable.
 */
export const remuxWebm = async (blob: Blob): Promise<RemuxResult> => {
  const input = openInput(blob)
  try {
    const output = new Output({ format: new WebMOutputFormat(), target: new BufferTarget() })
    const conversion = await Conversion.init({ input, output })
    if (!conversion.isValid) throw new Error("The recorded file can't be read.")
    await conversion.execute()
    const buffer = output.target.buffer
    if (!buffer) throw new Error("Rewriting the recording produced no data.")
    const fixed = new Blob([buffer], { type: "video/webm" })
    return { blob: fixed, ...(await probe(fixed)) }
  } finally {
    input.dispose()
  }
}

export const probe = async (blob: Blob): Promise<{ durationMs: number; width: number; height: number }> => {
  const input = openInput(blob)
  try {
    const durationMs = Math.round((await input.computeDuration()) * 1000)
    const video = await input.getPrimaryVideoTrack()
    return { durationMs, width: video?.displayWidth ?? 0, height: video?.displayHeight ?? 0 }
  } finally {
    input.dispose()
  }
}

const canvasToBlob = (canvas: HTMLCanvasElement | OffscreenCanvas, type: string, quality?: number): Promise<Blob> =>
  "convertToBlob" in canvas
    ? canvas.convertToBlob({ type, quality })
    : new Promise((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Canvas export failed"))), type, quality)
    )

/** A small WebP still from about a second in, for the library. */
export const makeThumbnail = async (blob: Blob, durationMs: number): Promise<Blob | null> => {
  const input = openInput(blob)
  try {
    const video = await input.getPrimaryVideoTrack()
    if (!video || !(await video.canDecode())) return null
    const sink = new CanvasSink(video, { width: 480, height: 300, fit: "contain" })
    const at = Math.min(1, durationMs / 2000)
    const frame = await sink.getCanvas(at)
    if (!frame) return null
    return await canvasToBlob(frame.canvas, "image/webp", 0.8)
  } finally {
    input.dispose()
  }
}

/** Frames at evenly spaced source times, for the timeline filmstrip. */
export const filmstrip = async (blob: Blob, timesMs: ReadonlyArray<number>, height: number): Promise<Array<string | null>> => {
  const input = openInput(blob)
  try {
    const video = await input.getPrimaryVideoTrack()
    if (!video || !(await video.canDecode())) return timesMs.map(() => null)
    const width = Math.round((height * video.displayWidth) / Math.max(1, video.displayHeight))
    const sink = new CanvasSink(video, { width, height, fit: "fill", poolSize: 1 })
    const out: Array<string | null> = []
    for await (const frame of sink.canvasesAtTimestamps(timesMs.map((t) => t / 1000))) {
      if (!frame) {
        out.push(null)
        continue
      }
      const b = await canvasToBlob(frame.canvas, "image/webp", 0.6)
      out.push(URL.createObjectURL(b))
    }
    return out
  } finally {
    input.dispose()
  }
}

export const TRANSCRIBE_RATE = 16000

/** Decodes a file's audio and converts it to 16 kHz mono, which is what Whisper takes. */
export const decodeAudio16k = async (blob: Blob): Promise<Float32Array | null> => {
  const input = openInput(blob)
  try {
    const track = await input.getPrimaryAudioTrack()
    if (!track || !(await track.canDecode())) return null
    const sink = new AudioBufferSink(track)
    const buffers: Array<{ buffer: AudioBuffer; timestamp: number }> = []
    let sourceRate = 48000
    for await (const { buffer, timestamp } of sink.buffers()) {
      buffers.push({ buffer, timestamp })
      sourceRate = buffer.sampleRate
    }
    if (buffers.length === 0) return new Float32Array(0)
    const first = Math.max(0, buffers[0]!.timestamp)
    const last = buffers[buffers.length - 1]!
    const totalSec = Math.max(0, last.timestamp + last.buffer.duration)
    // Place each buffer at its timestamp, so timing matches the video even if packets are missing.
    const mono = new Float32Array(Math.ceil(totalSec * sourceRate))
    for (const { buffer, timestamp } of buffers) {
      const offset = Math.round(Math.max(0, timestamp) * sourceRate)
      const channels = buffer.numberOfChannels
      for (let c = 0; c < channels; c++) {
        const data = buffer.getChannelData(c)
        for (let i = 0; i < data.length && offset + i < mono.length; i++) mono[offset + i]! += data[i]! / channels
      }
    }
    void first
    return await resample(mono, sourceRate, TRANSCRIBE_RATE)
  } finally {
    input.dispose()
  }
}

const resample = async (samples: Float32Array, from: number, to: number): Promise<Float32Array> => {
  if (from === to || samples.length === 0) return samples
  const length = Math.max(1, Math.round((samples.length * to) / from))
  if (typeof OfflineAudioContext !== "undefined") {
    const ctx = new OfflineAudioContext(1, length, to)
    const buf = ctx.createBuffer(1, samples.length, from)
    buf.copyToChannel(new Float32Array(samples), 0)
    const src = ctx.createBufferSource()
    src.buffer = buf
    src.connect(ctx.destination)
    src.start()
    const out = await ctx.startRendering()
    return out.getChannelData(0).slice()
  }
  // Linear fallback where OfflineAudioContext isn't available.
  const out = new Float32Array(length)
  const ratio = from / to
  for (let i = 0; i < length; i++) {
    const x = i * ratio
    const j = Math.floor(x)
    const f = x - j
    out[i] = (samples[j] ?? 0) * (1 - f) + (samples[j + 1] ?? 0) * f
  }
  return out
}

/** Peak levels in buckets, for drawing the waveform. Values are 0 to 1. */
export const peaks = (samples: Float32Array, buckets: number): Float32Array => {
  const out = new Float32Array(buckets)
  if (samples.length === 0) return out
  const size = samples.length / buckets
  let max = 0
  for (let b = 0; b < buckets; b++) {
    const a = Math.floor(b * size)
    const z = Math.min(samples.length, Math.floor((b + 1) * size))
    let peak = 0
    for (let i = a; i < z; i++) {
      const v = Math.abs(samples[i]!)
      if (v > peak) peak = v
    }
    out[b] = peak
    if (peak > max) max = peak
  }
  if (max > 0) for (let b = 0; b < buckets; b++) out[b] = out[b]! / max
  return out
}
