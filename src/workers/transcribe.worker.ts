/// <reference lib="webworker" />
import { env, pipeline, Tensor, type AutomaticSpeechRecognitionPipeline } from "@huggingface/transformers"
import type { TranscribeRequest, TranscribeResponse, RawWord } from "./transcribeProtocol.ts"
import { modelRepo, modelDtype, planChunks } from "./transcribeProtocol.ts"

declare const self: DedicatedWorkerGlobalScope

// The ONNX Runtime files are served by Weave itself, not a CDN.
const ortBase = new URL("/ort/", self.location.origin).href
const onnx = env.backends.onnx as { wasm?: { wasmPaths?: unknown; numThreads?: number } }
/** The JSPI build adds WebGPU support; the plain build runs on the CPU only. */
const useOrtBuild = (device: "webgpu" | "wasm") => {
  if (!onnx.wasm) return
  const suffix = device === "webgpu" ? ".jspi" : ""
  onnx.wasm.wasmPaths = {
    mjs: `${ortBase}ort-wasm-simd-threaded${suffix}.mjs`,
    wasm: `${ortBase}ort-wasm-simd-threaded${suffix}.wasm`
  }
  onnx.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1
}
env.allowLocalModels = false
env.useBrowserCache = true

let loaded: { key: string; asr: AutomaticSpeechRecognitionPipeline } | null = null

const post = (msg: TranscribeResponse) => self.postMessage(msg)

const load = async (model: TranscribeRequest["model"], device: "webgpu" | "wasm") => {
  const key = `${model}:${device}`
  if (loaded?.key === key) return loaded.asr
  if (loaded) {
    await loaded.asr.dispose().catch(() => {})
    loaded = null
  }
  useOrtBuild(device)
  const asr = (await pipeline("automatic-speech-recognition", modelRepo(model), {
    device,
    dtype: modelDtype(model, device),
    progress_callback: (p: { status: string; loaded?: number; total?: number; file?: string }) => {
      if (p.status === "progress_total") post({ type: "download", loaded: p.loaded ?? 0, total: p.total ?? 0 })
    }
  })) as AutomaticSpeechRecognitionPipeline
  loaded = { key, asr }
  return asr
}

/**
 * Detects the spoken language from the first 30 seconds, the way Whisper does:
 * one decoder step after the start token, then the most likely language token.
 * Transformers.js doesn't do this itself; it assumes English.
 */
const detectLanguage = async (asr: AutomaticSpeechRecognitionPipeline, audio: Float32Array): Promise<string | null> => {
  try {
    const a = asr as unknown as {
      processor: (x: Float32Array) => Promise<{ input_features: unknown }>
      model: ((inputs: Record<string, unknown>) => Promise<{ logits: { data: ArrayLike<number> } }>) & {
        generation_config: { decoder_start_token_id: number; lang_to_id?: Record<string, number> }
      }
    }
    const langs = a.model.generation_config.lang_to_id
    if (!langs) return null
    const { input_features } = await a.processor(audio)
    const sot = a.model.generation_config.decoder_start_token_id
    const decoder_input_ids = new Tensor("int64", BigInt64Array.from([BigInt(sot)]), [1, 1])
    const { logits } = await a.model({ input_features, decoder_input_ids })
    let best: string | null = null
    let bestScore = -Infinity
    for (const [token, id] of Object.entries(langs)) {
      const v = Number(logits.data[id])
      if (v > bestScore) {
        bestScore = v
        best = token.replace(/^<\|/, "").replace(/\|>$/, "")
      }
    }
    return best
  } catch (e) {
    console.warn("Language detection failed; using English.", e)
    return null
  }
}

self.onmessage = async (e: MessageEvent<TranscribeRequest>) => {
  const req = e.data
  let stage: "download" | "transcribe" = "download"
  try {
    const asr = await load(req.model, req.device)
    post({ type: "ready" })
    if (req.type === "load") return
    stage = "transcribe"
    const audio = req.audio
    const chunks = planChunks(audio, req.sampleRate)
    post({ type: "progress", done: 0, total: chunks.length })
    let language = req.language
    if (language === "auto") {
      const first = chunks[0]
      language = (first ? await detectLanguage(asr, audio.subarray(first.start, first.end)) : null) ?? "en"
    }
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i]!
      const slice = audio.subarray(c.start, c.end)
      const out = (await asr(slice, {
        return_timestamps: "word",
        task: "transcribe",
        language
      })) as { text: string; chunks?: Array<{ text: string; timestamp: [number, number | null] }> }
      const offsetSec = c.start / req.sampleRate
      const chunkEndSec = (c.end - c.start) / req.sampleRate
      const words: Array<RawWord> = (out.chunks ?? [])
        .filter((w) => w.text.trim().length > 0)
        // Whisper pads audio to 30 seconds, and small models sometimes place
        // words in the padding. Those words can't be lined up with the video.
        .filter((w) => (w.timestamp[0] ?? 0) < chunkEndSec - 0.02)
        .map((w) => {
          const start = w.timestamp[0] ?? 0
          const end = w.timestamp[1] ?? Math.min(chunkEndSec, start + 0.3)
          return {
            text: w.text,
            startMs: Math.round((offsetSec + Math.min(start, chunkEndSec)) * 1000),
            endMs: Math.round((offsetSec + Math.min(Math.max(end, start), chunkEndSec)) * 1000)
          }
        })
      post({ type: "chunk", index: i, total: chunks.length, words })
    }
    post({ type: "done", language })
  } catch (err) {
    post({ type: "error", stage, message: err instanceof Error ? err.message : String(err) })
  }
}
