import { Context, Effect, Layer, Semaphore } from "effect"
import { ModelDownloadFailed, TranscriptionFailed } from "../domain/errors.ts"
import type { ModelSize } from "../domain/schema.ts"
import type { Device, RawWord, TranscribeRequest, TranscribeResponse } from "../workers/transcribeProtocol.ts"
import { MODELS, modelRepo } from "../workers/transcribeProtocol.ts"

export interface TranscribeOptions {
  readonly audio: Float32Array
  readonly sampleRate: number
  readonly model: ModelSize
  readonly language: string
  readonly onDownload?: (loaded: number, total: number) => void
  readonly onProgress?: (done: number, total: number) => void
  readonly onChunk?: (words: ReadonlyArray<RawWord>, index: number, total: number) => void
}

export interface CachedModel {
  readonly size: ModelSize
  readonly bytes: number
}

const CACHE_NAME = "transformers-cache"

/** Client for the transcription worker. Handles model choice, progress, and the cache of downloaded models. */
export class Transcriber extends Context.Service<Transcriber, {
  /** WebGPU when the browser has a usable adapter, otherwise WASM. */
  readonly device: Effect.Effect<Device>
  transcribe(options: TranscribeOptions): Effect.Effect<{ language: string }, ModelDownloadFailed | TranscriptionFailed>
  download(model: ModelSize, onDownload?: (loaded: number, total: number) => void): Effect.Effect<void, ModelDownloadFailed>
  readonly cachedModels: Effect.Effect<ReadonlyArray<CachedModel>>
  deleteModel(model: ModelSize): Effect.Effect<void>
}>()("weave/Transcriber") {
  static readonly layer = Layer.effect(
    Transcriber,
    Effect.gen(function*() {
      const lock = yield* Semaphore.make(1)
      let worker: Worker | null = null
      const getWorker = () => (worker ??= new Worker("/workers/transcribe.js", { type: "module" }))
      const kill = () => {
        worker?.terminate()
        worker = null
      }

      let deviceCache: Device | undefined
      const device = Effect.promise(async (): Promise<Device> => {
        if (deviceCache) return deviceCache
        try {
          const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu
          const adapter = gpu ? await gpu.requestAdapter() : null
          // Software adapters (like headless Chromium's) are slower than WASM.
          const info = (adapter as { info?: { isFallbackAdapter?: boolean } } | null)?.info
          // WebGPU inference uses ONNX Runtime's JSPI build, so it also needs WebAssembly JSPI.
          const jspi = typeof WebAssembly !== "undefined" && "Suspending" in WebAssembly
          deviceCache = adapter && jspi && !info?.isFallbackAdapter && !isForcedWasm() ? "webgpu" : "wasm"
        } catch {
          deviceCache = "wasm"
        }
        return deviceCache
      })

      const run = (
        req: TranscribeRequest,
        handlers: Pick<TranscribeOptions, "onDownload" | "onProgress" | "onChunk">
      ) =>
        Effect.callback<{ language: string }, ModelDownloadFailed | TranscriptionFailed>((resume) => {
          const w = getWorker()
          w.onmessage = (e: MessageEvent<TranscribeResponse>) => {
            const msg = e.data
            switch (msg.type) {
              case "download":
                handlers.onDownload?.(msg.loaded, msg.total)
                break
              case "ready":
                if (req.type === "load") resume(Effect.succeed({ language: "" }))
                break
              case "progress":
                handlers.onProgress?.(msg.done, msg.total)
                break
              case "chunk":
                handlers.onChunk?.(msg.words, msg.index, msg.total)
                handlers.onProgress?.(msg.index + 1, msg.total)
                break
              case "done":
                resume(Effect.succeed({ language: msg.language }))
                break
              case "error":
                resume(
                  Effect.fail(
                    msg.stage === "download"
                      ? new ModelDownloadFailed({ model: req.model, message: msg.message })
                      : new TranscriptionFailed({ message: msg.message })
                  )
                )
                break
            }
          }
          w.onerror = (e) => {
            kill()
            resume(Effect.fail(new TranscriptionFailed({ message: e.message || "The transcription worker crashed." })))
          }
          w.postMessage(req)
          // Interrupting (leaving the editor, canceling a download) stops the worker.
          return Effect.sync(kill)
        })

      return Transcriber.of({
        device,
        transcribe: (o) =>
          lock.withPermits(1)(
            Effect.gen(function*() {
              const d = yield* device
              const model = d === "wasm" && o.model === "large-v3-turbo" ? "small" : o.model
              return yield* run(
                { type: "transcribe", model, device: d, audio: o.audio, sampleRate: o.sampleRate, language: o.language },
                o
              )
            })
          ),
        download: (model, onDownload) =>
          lock.withPermits(1)(
            Effect.gen(function*() {
              const d = yield* device
              yield* run({ type: "load", model, device: d }, { onDownload }).pipe(
                Effect.mapError((e) =>
                  e._tag === "ModelDownloadFailed" ? e : new ModelDownloadFailed({ model, message: e.message })
                )
              )
            })
          ),
        cachedModels: Effect.promise(async () => {
          if (typeof caches === "undefined") return []
          const cache = await caches.open(CACHE_NAME)
          const keys = await cache.keys()
          const out: Array<CachedModel> = []
          for (const m of MODELS) {
            const repo = modelRepo(m.size)
            const mine = keys.filter((k) => k.url.includes(`/${repo}/`))
            if (!mine.some((k) => k.url.endsWith(".onnx") || k.url.includes(".onnx_data"))) continue
            let bytes = 0
            for (const k of mine) {
              const res = await cache.match(k)
              const len = Number(res?.headers.get("content-length") ?? NaN)
              bytes += Number.isFinite(len) ? len : (await res?.blob())?.size ?? 0
            }
            out.push({ size: m.size, bytes })
          }
          return out
        }),
        deleteModel: (model) =>
          Effect.promise(async () => {
            if (typeof caches === "undefined") return
            const cache = await caches.open(CACHE_NAME)
            const repo = modelRepo(model)
            for (const k of await cache.keys()) if (k.url.includes(`/${repo}/`)) await cache.delete(k)
          })
      })
    })
  )
}

/** Tests and users can force WASM with ?wasm in the URL. */
const isForcedWasm = () => {
  try {
    return new URLSearchParams(location.search).has("wasm") || localStorage.getItem("weave.forceWasm") === "1"
  } catch {
    return false
  }
}
