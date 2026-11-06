import type { CameraSegment, Cut, Overlay } from "../domain/schema.ts"
import type { SpeedMap } from "../domain/speed.ts"

export type Resolution = "source" | "1080" | "720"

export interface ExportJob {
  readonly type: "export"
  readonly screen: Blob
  readonly camera: Blob | null
  readonly cuts: ReadonlyArray<Cut>
  /** Clip and global playback speeds. */
  readonly speed: SpeedMap
  /** Source ranges whose sound (screen and voiceover) is left out. */
  readonly mutes: ReadonlyArray<Cut>
  readonly durationMs: number
  readonly overlay: Overlay
  readonly cameraOffsetMs: number
  readonly cameraSegments: ReadonlyArray<CameraSegment>
  /** Include the camera file's voiceover track. */
  readonly cameraAudio: boolean
  /** Leave out the screen file's sound. */
  readonly screenAudioMuted: boolean
  readonly resolution: Resolution
}

export type ExportRequest = ExportJob | { readonly type: "cancel" }

export type ExportResponse =
  | { readonly type: "progress"; readonly doneMs: number; readonly totalMs: number }
  | { readonly type: "done"; readonly data: ArrayBuffer; readonly mimeType: string; readonly extension: string; readonly videoCodec: string; readonly audioCodec: string | null }
  | { readonly type: "error"; readonly message: string; readonly unsupported: boolean }
  | { readonly type: "canceled" }

/** Output size for a source size, never upscaling, with even dimensions for H.264. */
export const outputSize = (width: number, height: number, resolution: Resolution): { width: number; height: number } => {
  const target = resolution === "1080" ? 1080 : resolution === "720" ? 720 : height
  const h = Math.min(height, target)
  const w = Math.round((width * h) / Math.max(1, height))
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2)
  return { width: even(w), height: even(h) }
}

/** Where to draw the camera bubble on a frame of the given size. */
export const overlayRect = (overlay: Overlay, width: number, height: number) => {
  const h = overlay.size * height
  const w = overlay.shape === "circle" ? h : (h * 4) / 3
  const x = Math.max(0, Math.min(width - w, overlay.x * width))
  const y = Math.max(0, Math.min(height - h, overlay.y * height))
  return { x, y, w, h, radius: overlay.shape === "circle" ? h / 2 : h * 0.16 }
}
