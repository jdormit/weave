import { describe, expect, test } from "bun:test"
import { ModelRegistry } from "@huggingface/transformers"
import { MODELS, modelDtype, modelRepo } from "./transcribeProtocol.ts"

// The parts of a Whisper config.json that decide which files load. Passing it
// in keeps the test offline.
const config = (externalEncoder: boolean) => ({
  model_type: "whisper",
  architectures: ["WhisperForConditionalGeneration"],
  is_encoder_decoder: true,
  "transformers.js_config": externalEncoder ? { use_external_data_format: { "encoder_model.onnx": true } } : {}
})

const suffix = { fp16: "_fp16", q8: "_quantized", q4f16: "_q4f16" } as const

describe("modelDtype", () => {
  for (const m of MODELS) {
    for (const device of m.wasmMb === null ? (["webgpu"] as const) : (["webgpu", "wasm"] as const)) {
      test(`${m.size} on ${device}: the download total counts the files that load`, async () => {
        const dtype = modelDtype(m.size, device)
        const files = await ModelRegistry.get_model_files(modelRepo(m.size), {
          config: config(m.size === "large-v3-turbo") as never,
          dtype,
          device
        })
        const s = suffix[dtype.encoder_model]
        expect(files.filter((f) => f.startsWith("onnx/")).sort()).toEqual(
          [`onnx/decoder_model_merged${s}.onnx`, `onnx/encoder_model${s}.onnx`].sort()
        )
      })
    }
  }
})
