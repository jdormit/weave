/**
 * Draws a camera frame with its background blurred, given a person mask from
 * the segmenter. Uses only 2D canvas calls, so it runs on the page and in
 * workers.
 */
import { blurRadius, MASK_HEIGHT, MASK_WIDTH, type BlurStrength } from "./mask.ts"

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D
/** Anything that can draw itself into a 2D context, like a mediabunny VideoSample. */
export type FrameSource = CanvasImageSource | {
  draw(ctx: OffscreenCanvasRenderingContext2D, dx: number, dy: number, dw: number, dh: number): void
}

const context = (canvas: OffscreenCanvas, opts?: CanvasRenderingContext2DSettings) => {
  const ctx = canvas.getContext("2d", opts)
  if (!ctx) throw new Error("Couldn't create a drawing surface.")
  return ctx
}

const drawFrame = (ctx: OffscreenCanvasRenderingContext2D, src: FrameSource, dx: number, dy: number, dw: number, dh: number) => {
  if ("draw" in src && typeof src.draw === "function") src.draw(ctx, dx, dy, dw, dh)
  else ctx.drawImage(src as CanvasImageSource, dx, dy, dw, dh)
}

export interface Compositor {
  /** Scales a frame down to the model's input size and returns its RGBA bytes. */
  sample(src: FrameSource): Uint8ClampedArray<ArrayBuffer>
  /**
   * Draws the frame into out (width x height) with the background blurred.
   * Without a mask yet, draws the whole frame blurred, so the background never shows sharp.
   */
  draw(
    src: FrameSource,
    mask: Uint8ClampedArray<ArrayBuffer> | null,
    out: Ctx2D,
    width: number,
    height: number,
    strength?: BlurStrength
  ): void
}

export const createCompositor = (): Compositor => {
  const small = new OffscreenCanvas(MASK_WIDTH, MASK_HEIGHT)
  const smallCtx = context(small, { willReadFrequently: true })
  const maskCanvas = new OffscreenCanvas(MASK_WIDTH, MASK_HEIGHT)
  const maskCtx = context(maskCanvas)
  const bg = new OffscreenCanvas(1, 1)
  const bgCtx = context(bg)
  const person = new OffscreenCanvas(1, 1)
  const personCtx = context(person)
  // Safari before 18 has no canvas filters; there, a strong downscale stands in for the blur.
  const hasFilter = "filter" in bgCtx

  return {
    sample: (src) => {
      drawFrame(smallCtx, src, 0, 0, MASK_WIDTH, MASK_HEIGHT)
      return smallCtx.getImageData(0, 0, MASK_WIDTH, MASK_HEIGHT).data
    },
    draw: (src, mask, out, width, height, strength = "strong") => {
      // The background: the frame at reduced size, blurred, then scaled up. It
      // is drawn a little larger than the canvas so the blur has no dark edge.
      // A light blur shrinks the frame less, since shrinking blurs too.
      const light = strength === "light"
      const scale = hasFilter ? (light ? 2 : 4) : (light ? 8 : 24)
      const bw = Math.max(1, Math.round(width / scale))
      const bh = Math.max(1, Math.round(height / scale))
      if (bg.width !== bw || bg.height !== bh) {
        bg.width = bw
        bg.height = bh
      }
      const r = hasFilter ? Math.max(1, Math.round(blurRadius(width, strength) / scale)) : 0
      bgCtx.filter = r > 0 ? `blur(${r}px)` : "none"
      drawFrame(bgCtx, src, -2 * r, -2 * r, bw + 4 * r, bh + 4 * r)
      out.imageSmoothingEnabled = true
      out.imageSmoothingQuality = "high"
      out.drawImage(bg, 0, 0, width, height)
      if (!mask) return

      // The person: the sharp frame, cut out by the mask scaled up with smoothing, which feathers the edge.
      if (person.width !== width || person.height !== height) {
        person.width = width
        person.height = height
      }
      maskCtx.putImageData(new ImageData(mask, MASK_WIDTH, MASK_HEIGHT), 0, 0)
      personCtx.globalCompositeOperation = "copy"
      drawFrame(personCtx, src, 0, 0, width, height)
      personCtx.globalCompositeOperation = "destination-in"
      personCtx.imageSmoothingEnabled = true
      personCtx.drawImage(maskCanvas, 0, 0, width, height)
      personCtx.globalCompositeOperation = "source-over"
      out.drawImage(person, 0, 0, width, height)
    }
  }
}
