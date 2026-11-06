import { Effect, Fiber } from "effect"
import { useEffect, useRef, useState } from "react"
import { describeError } from "../../domain/errors.ts"
import { editedDuration } from "../../domain/editList.ts"
import { formatClock } from "../../domain/transcriptFormat.ts"
import { downloadBlob, Exporter, safeFilename, type TranscriptFormat } from "../../services/Exporter.ts"
import { run, runtime } from "../../services/runtime.ts"
import type { Resolution } from "../../workers/exportProtocol.ts"
import { useEditor } from "../editorState.ts"
import { Icon } from "../Icon.tsx"
import { toast } from "../state.ts"
import { Dialog } from "./Dialog.tsx"

const FORMATS: ReadonlyArray<{ format: TranscriptFormat; label: string; desc: string }> = [
  { format: "txt", label: "TXT", desc: "Plain text" },
  { format: "srt", label: "SRT", desc: "Subtitles" },
  { format: "vtt", label: "VTT", desc: "Web subtitles" },
  { format: "json", label: "JSON", desc: "Words, times, cuts" }
]

export const ExportDialog = ({ onClose }: { onClose: () => void }) => {
  const c = useEditor()
  const [resolution, setResolution] = useState<Resolution>("source")
  const [progress, setProgress] = useState<{ done: number; total: number; started: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const fiber = useRef<Fiber.Fiber<unknown, unknown> | null>(null)
  const title = safeFilename(c.recording.title)
  const edited = editedDuration(c.cuts, c.recording.durationMs, c.speed)
  const camera = c.cameraFile && c.recording.hasCamera && c.recording.overlay.visible

  useEffect(() => () => {
    if (fiber.current) void runtime.runPromise(Fiber.interrupt(fiber.current))
  }, [])

  const exportVideo = () => {
    if (!c.screenFile) return
    setError(null)
    setProgress({ done: 0, total: edited, started: performance.now() })
    const screen = c.screenFile
    fiber.current = runtime.runFork(
      Effect.gen(function*() {
        const exporter = yield* Exporter
        const result = yield* exporter.exportVideo({
          recording: c.recording,
          screen,
          camera: c.cameraFile,
          cuts: c.cuts,
          speed: c.speed,
          resolution,
          onProgress: (done, total) => setProgress((p) => ({ done, total, started: p?.started ?? performance.now() }))
        })
        downloadBlob(result.blob, `${title}.${result.extension}`)
        return result
      }).pipe(
        Effect.tap(() => Effect.sync(() => {
          setProgress(null)
          toast("Your video is in your downloads.")
        })),
        Effect.tapError((e) => Effect.sync(() => {
          setProgress(null)
          if (e._tag !== "ExportCanceled") setError(describeError(e))
        })),
        Effect.ensuring(Effect.sync(() => {
          fiber.current = null
        }))
      )
    )
  }

  const cancel = () => {
    if (fiber.current) void runtime.runPromise(Fiber.interrupt(fiber.current))
    setProgress(null)
  }

  const transcript = (format: TranscriptFormat) => {
    if (!c.transcript) return
    void run(Effect.gen(function*() {
      const exporter = yield* Exporter
      return exporter.transcriptFile(format, c.recording, c.transcript!, c.cuts, c.speed)
    })).then((blob) => downloadBlob(blob, `${title}.${format}`))
  }

  const remaining = progress && progress.done > 0
    ? ((performance.now() - progress.started) / progress.done) * (progress.total - progress.done)
    : null

  return (
    <Dialog title="Export" subtitle="Files are made on this device and saved to your downloads." onClose={onClose} wide testId="export">
      <p className="grp">Video</p>
      <div className="row" style={{ borderColor: "var(--ink)" }}>
        <div style={{ flex: 1, minWidth: 200 }}>
          <div className="t">Edited video</div>
          <div className="d tnum">MP4 · {formatClock(edited)} · {camera ? "camera included" : "no camera"}</div>
        </div>
        {!progress && (
          <>
            <div className="seg" role="radiogroup" aria-label="Resolution">
              {(["source", "1080", "720"] as const).map((r) => (
                <button key={r} role="radio" aria-checked={resolution === r} className={resolution === r ? "on" : ""} onClick={() => setResolution(r)}>
                  {r === "source" ? "Source" : `${r}p`}
                </button>
              ))}
            </div>
            <button className="btn primary" onClick={exportVideo} disabled={!c.screenFile} data-testid="export-video">
              <Icon name="download" />Export video
            </button>
          </>
        )}
        {progress && (
          <div style={{ flexBasis: "100%", display: "flex", alignItems: "center", gap: 12 }} data-testid="export-progress">
            <div style={{ flex: 1 }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 6, gap: 12 }}>
                <span>Encoding at {resolution === "source" ? "source size" : `${resolution}p`}</span>
                <span className="tnum muted">
                  {formatClock(progress.done)} of {formatClock(progress.total)}
                  {remaining !== null && ` · about ${Math.max(1, Math.round(remaining / 1000))} s left`}
                </span>
              </div>
              <div className="bar"><div style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%` }} /></div>
            </div>
            <button className="btn" onClick={cancel}>Cancel</button>
          </div>
        )}
        {error && <p style={{ flexBasis: "100%", margin: 0, color: "var(--danger)", fontSize: 13 }} role="alert">{error}</p>}
      </div>
      <div className="row">
        <div style={{ flex: 1, minWidth: 200 }}>
          <div className="t">Original screen recording</div>
          <div className="d tnum">WebM · {formatClock(c.recording.durationMs)} · no edits</div>
        </div>
        <button className="btn" disabled={!c.screenFile} onClick={() => c.screenFile && downloadBlob(c.screenFile, `${title} (screen).webm`)} data-testid="download-screen">
          Download
        </button>
      </div>
      {c.cameraFile && (
        <div className="row">
          <div style={{ flex: 1, minWidth: 200 }}>
            <div className="t">{c.recording.hasCamera ? "Original camera recording" : "Original voiceover recording"}</div>
            <div className="d tnum">
              WebM{c.recording.cameraSegments.length === 0 ? ` · ${formatClock(c.recording.durationMs)}` : ""} · {c.recording.cameraAudio ? "with your voice" : "no sound"}
            </div>
          </div>
          <button className="btn" onClick={() => c.cameraFile && downloadBlob(c.cameraFile, `${title} (camera).webm`)} data-testid="download-camera">
            Download
          </button>
        </div>
      )}
      <p className="grp" style={{ marginTop: 8 }}>
        Transcript <span style={{ fontWeight: 400 }}>· {c.transcript ? "times match the edited video" : "available after transcription"}</span>
      </p>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: 10 }}>
        {FORMATS.map((f) => (
          <button key={f.format} className="fmt" disabled={!c.transcript} onClick={() => transcript(f.format)} data-testid={`export-${f.format}`}>
            <b>{f.label} <Icon name="download" size={16} style={{ marginLeft: "auto", color: "var(--muted)" }} /></b>
            <span>{f.desc}</span>
          </button>
        ))}
      </div>
    </Dialog>
  )
}
