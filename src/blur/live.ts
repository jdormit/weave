/**
 * Live background blur for a playing <video>: segments frames in the blur
 * worker and draws the blurred result onto a canvas laid over the video.
 */
import { createCompositor } from "./compose.ts"
import type { BlurStrength } from "./mask.ts"

export interface BlurRequest {
  readonly id: number
  readonly pixels: ArrayBuffer
}
export type BlurResponse =
  | { readonly id: number; readonly mask: ArrayBuffer }
  | { readonly id: number; readonly error: string }

let worker: Worker | null = null
let nextId = 0
const pending = new Map<number, (r: BlurResponse) => void>()

const getWorker = () => {
  if (!worker) {
    worker = new Worker("/workers/blur.js", { type: "module" })
    worker.onmessage = (e: MessageEvent<BlurResponse>) => {
      pending.get(e.data.id)?.(e.data)
      pending.delete(e.data.id)
    }
  }
  return worker
}

const segment = (pixels: Uint8ClampedArray<ArrayBuffer>) =>
  new Promise<BlurResponse>((resolve) => {
    const id = nextId++
    pending.set(id, resolve)
    getWorker().postMessage({ id, pixels: pixels.buffer } satisfies BlurRequest, [pixels.buffer])
  })

/** Largest canvas width for previews; bubbles are small, so more is wasted work. */
const MAX_WIDTH = 960

/** requestVideoFrameCallback is in every current browser; requestAnimationFrame covers older ones. */
const hasFrameCallback = typeof HTMLVideoElement !== "undefined" && "requestVideoFrameCallback" in HTMLVideoElement.prototype

/**
 * Keeps canvas showing video's frames with the background blurred, until the
 * returned function is called. Sets data-ready="true" on the canvas once a
 * masked frame is drawn.
 */
export const attachBlur = (video: HTMLVideoElement, canvas: HTMLCanvasElement, strength: BlurStrength): (() => void) => {
  const v = video
  const ctx = canvas.getContext("2d")
  if (!ctx) return () => {}
  const compositor = createCompositor()
  let mask: Uint8ClampedArray<ArrayBuffer> | null = null
  let busy = false
  let stopped = false
  let handle = 0
  let failed = false

  const paint = () => {
    if (stopped || v.videoWidth === 0 || v.readyState < 2) return
    const w = Math.min(MAX_WIDTH, v.videoWidth)
    const h = Math.round((w * v.videoHeight) / v.videoWidth)
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w
      canvas.height = h
    }
    compositor.draw(v, mask, ctx, w, h, strength)
    if (mask) canvas.dataset["ready"] = "true"
  }

  const request = () => {
    if (busy || failed || stopped || v.videoWidth === 0 || v.readyState < 2) return
    busy = true
    void segment(compositor.sample(v)).then((r) => {
      busy = false
      if (stopped) return
      if ("error" in r) {
        // Without a mask the canvas keeps showing the whole frame blurred.
        failed = true
        console.warn("Background blur failed:", r.error)
        return
      }
      mask = new Uint8ClampedArray(r.mask)
      // A paused video draws no new frames, so show the fresh mask now.
      if (v.paused) paint()
      else request()
    })
  }

  const onFrame = () => {
    paint()
    request()
    schedule()
  }
  const schedule = () => {
    if (stopped) return
    if (hasFrameCallback) handle = v.requestVideoFrameCallback(onFrame)
    else handle = requestAnimationFrame(onFrame)
  }
  const onReady = () => {
    paint()
    request()
  }
  v.addEventListener("loadeddata", onReady)
  v.addEventListener("seeked", onReady)
  onReady()
  schedule()
  return () => {
    stopped = true
    v.removeEventListener("loadeddata", onReady)
    v.removeEventListener("seeked", onReady)
    if (hasFrameCallback) v.cancelVideoFrameCallback(handle)
    else cancelAnimationFrame(handle)
    delete canvas.dataset["ready"]
  }
}
