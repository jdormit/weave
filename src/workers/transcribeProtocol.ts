import type { ModelSize } from "../domain/schema.ts"

export type Device = "webgpu" | "wasm"

export type TranscribeRequest =
  | { readonly type: "load"; readonly model: ModelSize; readonly device: Device }
  | {
    readonly type: "transcribe"
    readonly model: ModelSize
    readonly device: Device
    readonly audio: Float32Array
    readonly sampleRate: number
    readonly language: string
  }

export interface RawWord {
  readonly text: string
  readonly startMs: number
  readonly endMs: number
}

export type TranscribeResponse =
  | { readonly type: "download"; readonly loaded: number; readonly total: number }
  | { readonly type: "ready" }
  | { readonly type: "progress"; readonly done: number; readonly total: number }
  | { readonly type: "chunk"; readonly index: number; readonly total: number; readonly words: ReadonlyArray<RawWord> }
  | { readonly type: "done"; readonly language: string }
  | { readonly type: "error"; readonly stage: "download" | "transcribe"; readonly message: string }

export const modelRepo = (model: ModelSize) => `onnx-community/whisper-${model}_timestamped`

/**
 * fp16 on WebGPU, 8-bit on WASM. Large v3 Turbo uses 4-bit weights with fp16
 * math, and only runs on WebGPU.
 */
export const modelDtype = (model: ModelSize, device: Device) => {
  const d = model === "large-v3-turbo" ? "q4f16" : device === "webgpu" ? "fp16" : "q8"
  return { encoder_model: d, decoder_model_merged: d } as const
}

export interface ModelInfo {
  readonly size: ModelSize
  readonly name: string
  readonly best: string
  /** Download size in MB for WebGPU and WASM. */
  readonly webgpuMb: number
  readonly wasmMb: number | null
}

export const MODELS: ReadonlyArray<ModelInfo> = [
  { size: "tiny", name: "Tiny", best: "Fastest. For older laptops without a graphics chip.", webgpuMb: 76, wasmMb: 41 },
  { size: "base", name: "Base", best: "Good accuracy on most laptops.", webgpuMb: 146, wasmMb: 77 },
  { size: "small", name: "Small", best: "Better accuracy. Needs a recent graphics chip to be quick.", webgpuMb: 485, wasmMb: 249 },
  { size: "large-v3-turbo", name: "Large v3 Turbo", best: "Best accuracy. Needs about 1 GB of graphics memory.", webgpuMb: 564, wasmMb: null }
]

export const modelInfo = (size: ModelSize): ModelInfo => MODELS.find((m) => m.size === size) ?? MODELS[1]!

/** Whisper works on 30-second windows. */
const MAX_CHUNK_SEC = 30
/** Look for a quiet place to split in the last few seconds before the limit. */
const SEARCH_SEC = 6
const WINDOW_SEC = 0.1

/**
 * Splits audio into pieces of at most 30 seconds, each ending at the quietest
 * moment in its last 6 seconds, so no word is cut in half. Returns sample ranges.
 */
export const planChunks = (audio: Float32Array, sampleRate: number): Array<{ start: number; end: number }> => {
  const out: Array<{ start: number; end: number }> = []
  const max = Math.floor(MAX_CHUNK_SEC * sampleRate) - 1
  const win = Math.max(1, Math.floor(WINDOW_SEC * sampleRate))
  let start = 0
  while (start < audio.length) {
    if (audio.length - start <= max) {
      out.push({ start, end: audio.length })
      break
    }
    const searchFrom = start + max - Math.floor(SEARCH_SEC * sampleRate)
    let best = start + max
    let bestEnergy = Infinity
    for (let w = searchFrom; w + win <= start + max; w += win) {
      let e = 0
      for (let i = w; i < w + win; i++) e += audio[i]! * audio[i]!
      if (e < bestEnergy) {
        bestEnergy = e
        best = w + Math.floor(win / 2)
      }
    }
    out.push({ start, end: best })
    start = best
  }
  return out
}
