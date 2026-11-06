import { Context, Effect, Layer } from "effect"
import { EncoderUnsupported, ExportCanceled, ExportFailed } from "../domain/errors.ts"
import type { Cut, Recording, Transcript } from "../domain/schema.ts"
import { toJson, toSrt, toTxt, toVtt } from "../domain/transcriptFormat.ts"
import type { ExportResponse, Resolution } from "../workers/exportProtocol.ts"

export interface VideoExport {
  readonly blob: Blob
  readonly extension: string
  readonly videoCodec: string
  readonly audioCodec: string | null
}

export type TranscriptFormat = "txt" | "srt" | "vtt" | "json"

export interface VideoExportOptions {
  readonly recording: Recording
  readonly screen: Blob
  readonly camera: Blob | null
  readonly cuts: ReadonlyArray<Cut>
  readonly resolution: Resolution
  readonly onProgress?: (doneMs: number, totalMs: number) => void
}

/** Client for the export worker. Also builds transcript files. */
export class Exporter extends Context.Service<Exporter, {
  exportVideo(options: VideoExportOptions): Effect.Effect<VideoExport, EncoderUnsupported | ExportFailed | ExportCanceled>
  transcriptFile(format: TranscriptFormat, recording: Recording, transcript: Transcript, cuts: ReadonlyArray<Cut>): Blob
}>()("weave/Exporter") {
  static readonly layer = Layer.succeed(Exporter, Exporter.of({
    exportVideo: (o) =>
      Effect.callback<VideoExport, EncoderUnsupported | ExportFailed | ExportCanceled>((resume) => {
        const worker = new Worker("/workers/export.js", { type: "module" })
        let finished = false
        const finish = (effect: Effect.Effect<VideoExport, EncoderUnsupported | ExportFailed | ExportCanceled>) => {
          finished = true
          worker.terminate()
          resume(effect)
        }
        worker.onmessage = (e: MessageEvent<ExportResponse>) => {
          const msg = e.data
          switch (msg.type) {
            case "progress":
              o.onProgress?.(msg.doneMs, msg.totalMs)
              break
            case "done":
              finish(Effect.succeed({
                blob: new Blob([msg.data], { type: msg.mimeType }),
                extension: msg.extension,
                videoCodec: msg.videoCodec,
                audioCodec: msg.audioCodec
              }))
              break
            case "canceled":
              finish(Effect.fail(new ExportCanceled()))
              break
            case "error":
              finish(Effect.fail(msg.unsupported ? new EncoderUnsupported() : new ExportFailed({ message: msg.message })))
              break
          }
        }
        worker.onerror = (e) => finish(Effect.fail(new ExportFailed({ message: e.message || "The export worker crashed." })))
        worker.postMessage({
          type: "export",
          screen: o.screen,
          camera: o.camera,
          cuts: o.cuts,
          durationMs: o.recording.durationMs,
          overlay: o.recording.overlay,
          cameraOffsetMs: o.recording.cameraOffsetMs,
          cameraSegments: o.recording.cameraSegments,
          cameraAudio: o.recording.cameraAudio,
          screenAudioMuted: o.recording.screenAudioMuted,
          resolution: o.resolution
        })
        return Effect.sync(() => {
          if (!finished) worker.terminate()
        })
      }),
    transcriptFile: (format, recording, transcript, cuts) => {
      switch (format) {
        case "txt":
          return new Blob([toTxt(transcript.words, cuts)], { type: "text/plain;charset=utf-8" })
        case "srt":
          return new Blob([toSrt(transcript.words, cuts)], { type: "application/x-subrip;charset=utf-8" })
        case "vtt":
          return new Blob([toVtt(transcript.words, cuts)], { type: "text/vtt;charset=utf-8" })
        case "json":
          return new Blob(
            [JSON.stringify(
              toJson({
                title: recording.title,
                modelId: transcript.modelId,
                language: transcript.language,
                durationMs: recording.durationMs,
                words: transcript.words,
                cuts
              }),
              null,
              2
            )],
            { type: "application/json" }
          )
      }
    }
  }))
}

/** Saves a blob through the browser's normal download flow. */
export const downloadBlob = (blob: Blob, filename: string) => {
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

/** A file name from a recording title. */
export const safeFilename = (title: string) =>
  title.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "Weave recording"
