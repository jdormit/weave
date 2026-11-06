import { Effect, Schema } from "effect"

/** Where the camera bubble sits on the frame, and how it looks. */
export const OverlayShape = Schema.Literals(["circle", "rounded"])
export type OverlayShape = typeof OverlayShape.Type

/** How strongly the camera's background is blurred. */
export const BlurStrength = Schema.Literals(["light", "strong"])
export type BlurStrength = typeof BlurStrength.Type

export const Overlay = Schema.Struct({
  /** Left edge of the bubble, as a fraction of the frame width. */
  x: Schema.Number,
  /** Top edge of the bubble, as a fraction of the frame height. */
  y: Schema.Number,
  /** Bubble height, as a fraction of the frame height. */
  size: Schema.Number,
  shape: OverlayShape,
  visible: Schema.Boolean,
  /** Blur the camera's background. Recordings saved before this option existed decode as false. */
  blur: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
  /** Recordings saved before this option existed used the strong blur. */
  blurStrength: BlurStrength.pipe(Schema.withDecodingDefaultKey(Effect.succeed("strong" as const)))
})
export type Overlay = typeof Overlay.Type

export const defaultOverlay: Overlay = {
  x: 0.77,
  y: 0.66,
  size: 0.28,
  shape: "circle",
  visible: true,
  blur: false,
  blurStrength: "strong"
}

export const TranscriptStatus = Schema.Literals(["none", "running", "done", "error"])
export type TranscriptStatus = typeof TranscriptStatus.Type

export const RecordingStatus = Schema.Literals(["recording", "ready"])
export type RecordingStatus = typeof RecordingStatus.Type

export const ScreenInfo = Schema.Struct({
  width: Schema.Number,
  height: Schema.Number,
  mimeType: Schema.String
})
export type ScreenInfo = typeof ScreenInfo.Type

/**
 * A stretch of source time covered by a camera take that was recorded in the
 * editor, while the video played back. cameraMs is the camera file's time at
 * startMs. rate is how many milliseconds of source played per millisecond of
 * camera, which is the speed the video played at while the take recorded.
 */
export const CameraSegment = Schema.Struct({
  startMs: Schema.Number,
  endMs: Schema.Number,
  cameraMs: Schema.Number,
  /** Takes saved before speeds existed decode as 1. */
  rate: Schema.Number.pipe(Schema.withDecodingDefaultKey(Effect.succeed(1)))
})
export type CameraSegment = typeof CameraSegment.Type

export const Recording = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  createdAt: Schema.Number,
  durationMs: Schema.Number,
  status: RecordingStatus,
  screen: ScreenInfo,
  hasCamera: Schema.Boolean,
  hasAudio: Schema.Boolean,
  /** Camera recorder start time minus screen recorder start time. */
  cameraOffsetMs: Schema.Number,
  /**
   * Set when the camera was re-recorded in the editor. Source times outside
   * every segment have no camera. Empty means the camera was recorded with the
   * screen and lines up with it through cameraOffsetMs.
   */
  cameraSegments: Schema.Array(CameraSegment).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
  /** The camera file has a voiceover (microphone) track. */
  cameraAudio: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
  /** Leave the screen recording's own sound out of playback, transcription and export. */
  screenAudioMuted: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
  overlay: Overlay,
  transcriptStatus: TranscriptStatus
})
export type Recording = typeof Recording.Type

export const Word = Schema.Struct({
  id: Schema.String,
  text: Schema.String,
  startMs: Schema.Number,
  endMs: Schema.Number
})
export type Word = typeof Word.Type

export const Transcript = Schema.Struct({
  recordingId: Schema.String,
  modelId: Schema.String,
  language: Schema.String,
  words: Schema.Array(Word)
})
export type Transcript = typeof Transcript.Type

export const Cut = Schema.Struct({
  startMs: Schema.Number,
  endMs: Schema.Number
})
export type Cut = typeof Cut.Type

/** A stretch of source time that plays at a speed other than normal. */
export const SpeedRange = Schema.Struct({
  startMs: Schema.Number,
  endMs: Schema.Number,
  rate: Schema.Number
})
export type SpeedRange = typeof SpeedRange.Type

const speedFields = {
  /** Clip speeds, by source range. Edits saved before speeds existed decode as none. */
  speeds: Schema.Array(SpeedRange).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
  /** The whole video's speed, which multiplies each clip's speed. */
  speed: Schema.Number.pipe(Schema.withDecodingDefaultKey(Effect.succeed(1)))
}

export const EditState = Schema.Struct({
  cuts: Schema.Array(Cut),
  splits: Schema.Array(Schema.Number),
  ...speedFields
})
export type EditState = typeof EditState.Type

export const EditList = Schema.Struct({
  recordingId: Schema.String,
  cuts: Schema.Array(Cut),
  splits: Schema.Array(Schema.Number),
  ...speedFields,
  past: Schema.Array(EditState),
  future: Schema.Array(EditState)
})
export type EditList = typeof EditList.Type

export const ModelSize = Schema.Literals(["tiny", "base", "small", "large-v3-turbo"])
export type ModelSize = typeof ModelSize.Type

export const SourceType = Schema.Literals(["browser", "window", "monitor"])
export type SourceType = typeof SourceType.Type

export const Settings = Schema.Struct({
  model: ModelSize,
  language: Schema.String,
  source: SourceType,
  cameraId: Schema.String,
  micId: Schema.String,
  includeSystemAudio: Schema.Boolean,
  showCutWords: Schema.Boolean,
  /** Blur the camera's background in new recordings. */
  blurBackground: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
  blurStrength: BlurStrength.pipe(Schema.withDecodingDefaultKey(Effect.succeed("strong" as const)))
})
export type Settings = typeof Settings.Type

export const defaultSettings: Settings = {
  model: "base",
  language: "auto",
  source: "browser",
  cameraId: "default",
  micId: "default",
  includeSystemAudio: true,
  showCutWords: true,
  blurBackground: false,
  blurStrength: "strong"
}

/** The JSON transcript export, which can be re-imported later. */
export const TranscriptExport = Schema.Struct({
  version: Schema.Literal(1),
  title: Schema.String,
  modelId: Schema.String,
  language: Schema.String,
  durationMs: Schema.Number,
  editedDurationMs: Schema.Number,
  words: Schema.Array(Schema.Struct({
    id: Schema.String,
    text: Schema.String,
    startMs: Schema.Number,
    endMs: Schema.Number,
    cut: Schema.Boolean
  })),
  cuts: Schema.Array(Cut),
  /** Word times are source times; these speeds turn them into edited times. */
  ...speedFields
})
export type TranscriptExport = typeof TranscriptExport.Type
