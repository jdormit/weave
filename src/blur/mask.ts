/**
 * Pure helpers for the selfie segmentation model: turning camera pixels into
 * the model's input, and the model's output into an alpha mask.
 *
 * The model is MediaPipe's landscape selfie segmenter (Apache-2.0), in the
 * ONNX form published at huggingface.co/onnx-community/mediapipe_selfie_segmentation_landscape.
 * It takes a 256x144 RGB image scaled to [0, 1] in NCHW order and returns, for
 * each pixel, how likely it is to belong to a person.
 */

export const MASK_WIDTH = 256
export const MASK_HEIGHT = 144
export const MASK_PIXELS = MASK_WIDTH * MASK_HEIGHT

/** Below this confidence a pixel is background, above HIGH it is the person; in between it fades. */
const LOW = 0.25
const HIGH = 0.75

/** Converts RGBA bytes (MASK_WIDTH x MASK_HEIGHT) to the model's planar RGB input. */
export const rgbaToInput = (rgba: Uint8ClampedArray, out: Float32Array = new Float32Array(3 * MASK_PIXELS)): Float32Array => {
  if (rgba.length !== 4 * MASK_PIXELS) throw new Error(`Expected ${4 * MASK_PIXELS} bytes, got ${rgba.length}`)
  for (let i = 0; i < MASK_PIXELS; i++) {
    out[i] = rgba[4 * i]! / 255
    out[MASK_PIXELS + i] = rgba[4 * i + 1]! / 255
    out[2 * MASK_PIXELS + i] = rgba[4 * i + 2]! / 255
  }
  return out
}

/**
 * Converts person confidences to RGBA bytes for an ImageData whose alpha is
 * the mask. A smoothstep between LOW and HIGH firms up the edge without making
 * it jagged.
 */
export const confidenceToMask = (
  confidence: Float32Array,
  out: Uint8ClampedArray<ArrayBuffer> = new Uint8ClampedArray(4 * MASK_PIXELS)
): Uint8ClampedArray<ArrayBuffer> => {
  if (confidence.length !== MASK_PIXELS) throw new Error(`Expected ${MASK_PIXELS} values, got ${confidence.length}`)
  for (let i = 0; i < MASK_PIXELS; i++) {
    const t = Math.min(1, Math.max(0, (confidence[i]! - LOW) / (HIGH - LOW)))
    out[4 * i] = 255
    out[4 * i + 1] = 255
    out[4 * i + 2] = 255
    out[4 * i + 3] = Math.round(t * t * (3 - 2 * t) * 255)
  }
  return out
}

export type BlurStrength = "light" | "strong"

/** Blur radius, in pixels of a frame this wide. Light keeps the background recognizable and the edge around the person softer. */
export const blurRadius = (width: number, strength: BlurStrength = "light") =>
  strength === "light" ? Math.max(2, Math.round(width / 200)) : Math.max(4, Math.round(width / 60))
