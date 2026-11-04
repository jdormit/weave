import { Schema } from "effect"

export class PermissionDenied extends Schema.TaggedError<PermissionDenied>()("PermissionDenied", {
  device: Schema.Literals(["screen", "camera", "microphone"])
}) {}

export class CaptureFailed extends Schema.TaggedError<CaptureFailed>()("CaptureFailed", {
  message: Schema.String
}) {}

export class RecorderFailed extends Schema.TaggedError<RecorderFailed>()("RecorderFailed", {
  message: Schema.String
}) {}

export class QuotaExceeded extends Schema.TaggedError<QuotaExceeded>()("QuotaExceeded", {}) {}

export class StorageFailed extends Schema.TaggedError<StorageFailed>()("StorageFailed", {
  message: Schema.String
}) {}

export class RecordingNotFound extends Schema.TaggedError<RecordingNotFound>()("RecordingNotFound", {
  id: Schema.String
}) {}

export class ModelDownloadFailed extends Schema.TaggedError<ModelDownloadFailed>()("ModelDownloadFailed", {
  model: Schema.String,
  message: Schema.String
}) {}

export class TranscriptionFailed extends Schema.TaggedError<TranscriptionFailed>()("TranscriptionFailed", {
  message: Schema.String
}) {}

export class EncoderUnsupported extends Schema.TaggedError<EncoderUnsupported>()("EncoderUnsupported", {}) {}

export class ExportFailed extends Schema.TaggedError<ExportFailed>()("ExportFailed", {
  message: Schema.String
}) {}

export class ExportCanceled extends Schema.TaggedError<ExportCanceled>()("ExportCanceled", {}) {}

export type AppError =
  | PermissionDenied
  | CaptureFailed
  | RecorderFailed
  | QuotaExceeded
  | StorageFailed
  | RecordingNotFound
  | ModelDownloadFailed
  | TranscriptionFailed
  | EncoderUnsupported
  | ExportFailed
  | ExportCanceled

/** A plain-language message for each error, for the UI. */
export const describeError = (error: unknown): string => {
  if (typeof error === "object" && error !== null && "_tag" in error) {
    const e = error as AppError
    switch (e._tag) {
      case "PermissionDenied":
        return e.device === "screen"
          ? "Screen sharing was blocked or canceled. Click Start recording to try again."
          : `Weave can't use your ${e.device}. Allow it in the browser's site settings, or pick "No ${e.device}".`
      case "CaptureFailed":
        return `Weave couldn't start capturing: ${e.message}`
      case "RecorderFailed":
        return `Recording stopped because of an error: ${e.message}`
      case "QuotaExceeded":
        return "This browser has run out of storage for Weave. Delete old recordings or downloaded models, then try again."
      case "StorageFailed":
        return `Weave couldn't read or save data in this browser: ${e.message}`
      case "RecordingNotFound":
        return "This recording doesn't exist anymore. It may have been deleted in another tab."
      case "ModelDownloadFailed":
        return `The ${e.model} transcription model didn't download: ${e.message}. Check your connection, or try a smaller model.`
      case "TranscriptionFailed":
        return `Transcription failed: ${e.message}. If your graphics chip is low on memory, try a smaller model in Settings.`
      case "EncoderUnsupported":
        return "This browser can't encode video. Use a recent version of Chrome or Edge."
      case "ExportFailed":
        return `Export failed: ${e.message}`
      case "ExportCanceled":
        return "Export canceled."
    }
  }
  if (error instanceof Error) return error.message
  return String(error)
}
