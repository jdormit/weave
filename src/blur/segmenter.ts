/**
 * Runs the selfie segmentation model with ONNX Runtime Web on the CPU. Used in
 * workers only: the blur worker for live previews, and the export worker.
 * The model and the runtime are served by Weave itself, so nothing about the
 * camera leaves the device.
 */
import * as ort from "onnxruntime-web/wasm"
import { confidenceToMask, MASK_HEIGHT, MASK_PIXELS, MASK_WIDTH, rgbaToInput } from "./mask.ts"

export const MODEL_PATH = "/models/selfie_segmenter_landscape_fp16.onnx"

export interface Segmenter {
  /** Takes MASK_WIDTH x MASK_HEIGHT RGBA bytes and returns RGBA bytes whose alpha is the person mask. */
  segment(rgba: Uint8ClampedArray): Promise<Uint8ClampedArray<ArrayBuffer>>
}

export const createSegmenter = async (origin: string): Promise<Segmenter> => {
  // The same plain (CPU) ONNX Runtime build that transcription uses.
  ort.env.wasm.wasmPaths = {
    mjs: new URL("/ort/ort-wasm-simd-threaded.mjs", origin).href,
    wasm: new URL("/ort/ort-wasm-simd-threaded.wasm", origin).href
  }
  // The model is small: one thread runs it in a few milliseconds.
  ort.env.wasm.numThreads = 1
  const session = await ort.InferenceSession.create(new URL(MODEL_PATH, origin).href, { executionProviders: ["wasm"] })
  const input = new Float32Array(3 * MASK_PIXELS)
  return {
    segment: async (rgba) => {
      rgbaToInput(rgba, input)
      const tensor = new ort.Tensor("float32", input, [1, 3, MASK_HEIGHT, MASK_WIDTH])
      const result = await session.run({ pixel_values: tensor })
      const alphas = result["alphas"]
      if (!alphas) throw new Error("The segmentation model returned no mask.")
      const mask = confidenceToMask(alphas.data as Float32Array)
      alphas.dispose()
      return mask
    }
  }
}
