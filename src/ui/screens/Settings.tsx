import { useAtomValue } from "@effect/atom-react"
import { Effect, Fiber } from "effect"
import { useCallback, useEffect, useRef, useState } from "react"
import { describeError } from "../../domain/errors.ts"
import type { ModelSize } from "../../domain/schema.ts"
import { RecordingStore } from "../../services/RecordingStore.ts"
import { run, runtime } from "../../services/runtime.ts"
import { Transcriber, type CachedModel } from "../../services/Transcriber.ts"
import { MODELS } from "../../workers/transcribeProtocol.ts"
import type { Device } from "../../workers/transcribeProtocol.ts"
import { Nav } from "../App.tsx"
import { formatBytes } from "../format.ts"
import { Icon } from "../Icon.tsx"
import { settingsAtom, toast, updateSettings } from "../state.ts"

const LANGUAGES: ReadonlyArray<[string, string]> = [
  ["auto", "Detect automatically"],
  ["en", "English"],
  ["es", "Spanish"],
  ["fr", "French"],
  ["de", "German"],
  ["it", "Italian"],
  ["pt", "Portuguese"],
  ["nl", "Dutch"],
  ["sv", "Swedish"],
  ["pl", "Polish"],
  ["ru", "Russian"],
  ["uk", "Ukrainian"],
  ["tr", "Turkish"],
  ["ar", "Arabic"],
  ["hi", "Hindi"],
  ["ja", "Japanese"],
  ["ko", "Korean"],
  ["zh", "Chinese"]
]

export const SettingsScreen = () => {
  const settings = useAtomValue(settingsAtom)
  const [device, setDevice] = useState<Device | null>(null)
  const [cached, setCached] = useState<ReadonlyArray<CachedModel> | null>(null)
  const [downloading, setDownloading] = useState<{ model: ModelSize; loaded: number; total: number } | null>(null)
  const [storage, setStorage] = useState<{ recordings: number; quota: number; usage: number; persisted: boolean } | null>(null)
  const fiber = useRef<Fiber.Fiber<unknown, unknown> | null>(null)

  const refresh = useCallback(() => {
    void run(Effect.gen(function*() { return yield* (yield* Transcriber).cachedModels })).then(setCached)
    void run(Effect.gen(function*() {
      const store = yield* RecordingStore
      const u = yield* store.usage
      return { recordings: yield* store.recordingsBytes, quota: u.quota, usage: u.usage, persisted: u.persisted }
    })).then(setStorage, () => {})
  }, [])

  useEffect(() => {
    void run(Effect.gen(function*() { return yield* (yield* Transcriber).device })).then(setDevice)
    refresh()
    return () => {
      if (fiber.current) void runtime.runPromise(Fiber.interrupt(fiber.current))
    }
  }, [refresh])

  const gpu = device === "webgpu"
  const modelsBytes = cached?.reduce((s, m) => s + m.bytes, 0) ?? 0

  const download = (model: ModelSize) => {
    setDownloading({ model, loaded: 0, total: 0 })
    fiber.current = runtime.runFork(
      Effect.gen(function*() {
        yield* (yield* Transcriber).download(model, (loaded, total) => setDownloading({ model, loaded, total }))
      }).pipe(
        Effect.tapError((e) => Effect.sync(() => toast(describeError(e)))),
        Effect.ensuring(Effect.sync(() => {
          fiber.current = null
          setDownloading(null)
          refresh()
        }))
      )
    )
  }
  const cancelDownload = () => {
    if (fiber.current) void runtime.runPromise(Fiber.interrupt(fiber.current))
  }
  const remove = (model: ModelSize) => {
    void run(Effect.gen(function*() { yield* (yield* Transcriber).deleteModel(model) })).then(refresh)
  }

  return (
    <>
      <Nav current="settings" />
      <main className="page" style={{ maxWidth: 880, paddingTop: 40, display: "flex", flexDirection: "column", gap: 40 }}>
        <h1>Settings</h1>
        <section>
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
            <h2 className="sec">Transcription model</h2>
            {device === "webgpu" && (
              <span className="pill ok"><Icon name="check" size={14} />WebGPU available: models run on your graphics chip</span>
            )}
            {device === "wasm" && <span className="pill">No WebGPU: models run on the CPU, which is slower</span>}
          </div>
          <p className="help">
            Speech is turned into text in this browser. Each model downloads once and stays in the browser's cache. Bigger models are more accurate and slower.
            {device === "wasm" && " Without WebGPU, Tiny or Base is a better choice."}
          </p>
          <fieldset className="models" data-testid="models">
            <legend className="sr">Model</legend>
            {MODELS.map((m) => {
              const blocked = !gpu && m.wasmMb === null
              const on = settings.model === m.size
              const c = cached?.find((x) => x.size === m.size)
              const isDownloading = downloading?.model === m.size
              const mb = gpu ? m.webgpuMb : m.wasmMb
              return (
                <label key={m.size} className={`model${on ? " on" : ""}${blocked ? " off" : ""}`} data-testid={`model-${m.size}`}>
                  <input
                    type="radio"
                    name="model"
                    value={m.size}
                    checked={on}
                    disabled={blocked}
                    onChange={() => updateSettings((s) => ({ ...s, model: m.size }))}
                  />
                  <span>
                    <span className="n">{m.name}{m.size === "base" && <span className="badge">Default</span>}</span>
                    <span className="b">{m.best}</span>
                  </span>
                  <span className="size tnum">{c ? formatBytes(c.bytes) : mb ? `${mb} MB` : "n/a"}</span>
                  <span className="act">
                    {blocked && <span style={{ fontSize: 13, color: "var(--muted)" }}>Needs WebGPU</span>}
                    {!blocked && c && !isDownloading && (
                      <>
                        <span style={{ fontSize: 13, color: "var(--ok)", display: "inline-flex", alignItems: "center", gap: 6 }} data-testid="downloaded">
                          <Icon name="check" size={16} />Downloaded
                        </span>
                        <button
                          type="button"
                          className="iconbtn"
                          aria-label={`Delete downloaded ${m.name} model`}
                          onClick={(e) => {
                            e.preventDefault()
                            remove(m.size)
                          }}
                        >
                          <Icon name="trash" />
                        </button>
                      </>
                    )}
                    {!blocked && isDownloading && (
                      <>
                        <span style={{ flex: 1, display: "flex", flexDirection: "column", gap: 4 }}>
                          <span className="tnum" style={{ fontSize: 12, color: "var(--muted)" }}>
                            {downloading.total ? `${formatBytes(downloading.loaded)} of ${formatBytes(downloading.total)}` : "Starting…"}
                          </span>
                          <span className="bar" style={{ height: 5, display: "block" }}>
                            <span style={{ display: "block", height: "100%", background: "var(--accent)", width: `${downloading.total ? (downloading.loaded / downloading.total) * 100 : 0}%` }} />
                          </span>
                        </span>
                        <button type="button" className="iconbtn" aria-label="Cancel download" onClick={(e) => {
                          e.preventDefault()
                          cancelDownload()
                        }}>
                          <Icon name="close" />
                        </button>
                      </>
                    )}
                    {!blocked && !c && !isDownloading && (
                      <button
                        type="button"
                        className="btn small"
                        disabled={downloading !== null || cached === null}
                        onClick={(e) => {
                          e.preventDefault()
                          download(m.size)
                        }}
                      >
                        <Icon name="download" size={16} />Download
                      </button>
                    )}
                  </span>
                </label>
              )
            })}
          </fieldset>
          <p className="tnum" style={{ margin: "10px 0 0", fontSize: 13, color: "var(--muted)" }} data-testid="models-total">
            {cached && cached.length > 0 ? `Downloaded models use ${formatBytes(modelsBytes)}.` : "No models downloaded yet. The chosen model downloads the first time you transcribe."}
          </p>
        </section>

        <section>
          <h2 className="sec"><label htmlFor="lang">Spoken language</label></h2>
          <p className="help">Weave detects the language on its own. Pick one if it guesses wrong.</p>
          <div className="selwrap" style={{ maxWidth: 320 }}>
            <select className="sel" id="lang" value={settings.language} onChange={(e) => updateSettings((s) => ({ ...s, language: e.target.value }))}>
              {LANGUAGES.map(([code, name]) => <option key={code} value={code}>{name}</option>)}
            </select>
            <Icon name="chevron" />
          </div>
        </section>

        <section>
          <h2 className="sec">Storage</h2>
          {storage && (
            <p className="help" style={{ display: "flex", alignItems: "center", gap: 6 }}>
              {storage.persisted
                ? <><Icon name="check" size={16} style={{ color: "var(--ok)" }} />Your browser won't delete recordings to free up space.</>
                : <>Your browser may delete recordings if it runs low on space. Weave asks it not to when you first record.</>}
            </p>
          )}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
            <div className="stat"><b className="tnum">{storage ? formatBytes(storage.recordings) : "…"}</b><span>Recordings</span></div>
            <div className="stat"><b className="tnum">{cached ? formatBytes(modelsBytes) : "…"}</b><span>Models</span></div>
            <div className="stat"><b className="tnum">{storage ? formatBytes(storage.quota) : "…"}</b><span>Available to Weave</span></div>
          </div>
        </section>
      </main>
    </>
  )
}
