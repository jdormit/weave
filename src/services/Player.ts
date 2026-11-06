import { Context, Effect, Layer } from "effect"
import { cameraTimeAt, type CameraTiming } from "../domain/camera.ts"
import { cutAt } from "../domain/editList.ts"
import type { Cut } from "../domain/schema.ts"

export interface PlayerController {
  play(): void
  pause(): void
  readonly playing: () => boolean
  /** Moves to a source time. A time inside a cut moves to the end of that cut. */
  seek(sourceMs: number): void
  /** Plays from one source time and stops at another. */
  playRange(fromMs: number, toMs: number): void
  setCuts(cuts: ReadonlyArray<Cut>): void
  readonly currentMs: () => number
  /** Called about 60 times a second with the source time while playing, and after each seek. */
  onTime(f: (sourceMs: number) => void): () => void
  onPlayingChange(f: (playing: boolean) => void): () => void
  /** Called when the camera starts or stops having something to show at the current time. */
  onCameraActive(f: (active: boolean) => void): () => void
  destroy(): void
}

export interface PlayerOptions {
  readonly cuts: ReadonlyArray<Cut>
  readonly timing: CameraTiming
  readonly durationMs: number
}

/** How far ahead to look for a cut, so a skip lands before the cut is seen or heard. */
const LOOKAHEAD_MS = 40
const SYNC_TOLERANCE_MS = 120

/**
 * Keeps the screen and camera videos in sync, and jumps over cuts during
 * playback so the preview matches the export.
 */
export class Player extends Context.Service<Player, {
  attach(
    screen: HTMLVideoElement,
    camera: HTMLMediaElement | null,
    options: PlayerOptions
  ): Effect.Effect<PlayerController>
}>()("weave/Player") {
  static readonly layer = Layer.succeed(Player, Player.of({
    attach: (screen, camera, options) => Effect.sync(() => makeController(screen, camera, options))
  }))
}

const makeController = (
  screen: HTMLVideoElement,
  camera: HTMLMediaElement | null,
  options: PlayerOptions
): PlayerController => {
  let cuts = options.cuts
  let stopAt: number | null = null
  let destroyed = false
  const timeListeners = new Set<(ms: number) => void>()
  const playingListeners = new Set<(p: boolean) => void>()
  const activeListeners = new Set<(a: boolean) => void>()
  let cameraActive = true
  const now = () => screen.currentTime * 1000
  const emit = () => timeListeners.forEach((f) => f(now()))

  const syncCamera = (force = false) => {
    if (!camera) return
    const at = cameraTimeAt(options.timing, now())
    const active = at !== null
    if (active !== cameraActive) {
      cameraActive = active
      activeListeners.forEach((f) => f(active))
    }
    if (at === null) {
      if (!camera.paused) camera.pause()
      return
    }
    if (!screen.paused && camera.paused) void camera.play().catch(() => {})
    const target = at / 1000
    if (force || Math.abs(camera.currentTime - target) * 1000 > SYNC_TOLERANCE_MS) {
      if (Number.isFinite(camera.duration) && target > camera.duration) return
      camera.currentTime = target
    }
  }

  const skipCuts = () => {
    const t = now()
    if (stopAt !== null && t >= stopAt) {
      stopAt = null
      screen.pause()
      return
    }
    const cut = cutAt(cuts, t + LOOKAHEAD_MS) ?? cutAt(cuts, t)
    if (cut) {
      if (cut.endMs >= options.durationMs - 1) {
        screen.pause()
        screen.currentTime = Math.max(0, cut.startMs - 1) / 1000
      } else {
        screen.currentTime = cut.endMs / 1000
        syncCamera(true)
      }
    }
  }

  // Check for cuts on every presented frame.
  const onFrame = () => {
    if (destroyed) return
    if (!screen.paused) skipCuts()
    if ("requestVideoFrameCallback" in screen) screen.requestVideoFrameCallback(onFrame)
  }
  if ("requestVideoFrameCallback" in screen) screen.requestVideoFrameCallback(onFrame)

  // Also check on animation frames, which keep running while the video stalls, and report the time.
  let raf = 0
  const tick = () => {
    if (destroyed) return
    if (!screen.paused) {
      skipCuts()
      syncCamera()
      emit()
    }
    raf = requestAnimationFrame(tick)
  }
  raf = requestAnimationFrame(tick)

  const onPlay = () => {
    if (camera && cameraTimeAt(options.timing, now()) !== null) void camera.play().catch(() => {})
    playingListeners.forEach((f) => f(true))
  }
  const onPause = () => {
    camera?.pause()
    syncCamera(true)
    playingListeners.forEach((f) => f(false))
    emit()
  }
  const onSeeked = () => {
    syncCamera(true)
    emit()
  }
  screen.addEventListener("play", onPlay)
  screen.addEventListener("pause", onPause)
  screen.addEventListener("seeked", onSeeked)
  screen.addEventListener("ended", onPause)

  return {
    play: () => {
      const t = now()
      // Restart from the beginning when at the end.
      if (t >= options.durationMs - 50) screen.currentTime = 0
      skipCuts()
      void screen.play().catch(() => {})
    },
    pause: () => {
      stopAt = null
      screen.pause()
    },
    playing: () => !screen.paused,
    seek: (ms) => {
      const cut = cutAt(cuts, ms)
      const target = cut ? Math.min(cut.endMs, options.durationMs) : ms
      screen.currentTime = Math.max(0, target) / 1000
      syncCamera(true)
      emit()
    },
    playRange: (from, to) => {
      screen.currentTime = from / 1000
      stopAt = to
      syncCamera(true)
      void screen.play().catch(() => {})
    },
    setCuts: (next) => {
      cuts = next
    },
    currentMs: now,
    onTime: (f) => {
      timeListeners.add(f)
      return () => timeListeners.delete(f)
    },
    onPlayingChange: (f) => {
      playingListeners.add(f)
      return () => playingListeners.delete(f)
    },
    onCameraActive: (f) => {
      activeListeners.add(f)
      f(cameraActive)
      return () => activeListeners.delete(f)
    },
    destroy: () => {
      destroyed = true
      camera?.pause()
      cancelAnimationFrame(raf)
      screen.removeEventListener("play", onPlay)
      screen.removeEventListener("pause", onPause)
      screen.removeEventListener("seeked", onSeeked)
      screen.removeEventListener("ended", onPause)
      timeListeners.clear()
      playingListeners.clear()
      activeListeners.clear()
    }
  }
}
