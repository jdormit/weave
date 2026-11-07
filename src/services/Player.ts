import { Context, Effect, Layer } from "effect"
import { cameraRateAt, cameraTimeAt, type CameraTiming } from "../domain/camera.ts"
import { cutAt, isInCut } from "../domain/editList.ts"
import type { Cut } from "../domain/schema.ts"
import { normalSpeed, rateAt, type SpeedMap } from "../domain/speed.ts"

export interface PlayerController {
  play(): void
  pause(): void
  readonly playing: () => boolean
  /** Moves to a source time. A time inside a cut moves to the end of that cut. */
  seek(sourceMs: number): void
  /** Plays from one source time and stops at another. */
  playRange(fromMs: number, toMs: number): void
  setCuts(cuts: ReadonlyArray<Cut>): void
  setSpeed(speed: SpeedMap): void
  /** Source ranges to play silently. */
  setMutes(mutes: ReadonlyArray<Cut>): void
  readonly currentMs: () => number
  /** The speed the video plays at, at the current time. */
  readonly currentRate: () => number
  /** Called about 60 times a second with the source time while playing, and after each seek. */
  onTime(f: (sourceMs: number) => void): () => void
  onPlayingChange(f: (playing: boolean) => void): () => void
  /** Called when the camera starts or stops having something to show at the current time. */
  onCameraActive(f: (active: boolean) => void): () => void
  destroy(): void
}

export interface PlayerOptions {
  readonly cuts: ReadonlyArray<Cut>
  readonly speed?: SpeedMap
  readonly mutes?: ReadonlyArray<Cut>
  readonly timing: CameraTiming
  readonly durationMs: number
}

/** How far ahead to look for a cut, so a skip lands before the cut is seen or heard. */
const LOOKAHEAD_MS = 40
const SYNC_TOLERANCE_MS = 120
/** An end this much before the video's duration is taken to be early (see resumeEarlyEnd). */
const EARLY_END_MS = 100

/**
 * Keeps the screen and camera videos in sync, jumps over cuts during
 * playback, and plays each part at its speed, so the preview matches the
 * export. The browser keeps the pitch of sped-up sound.
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
  let speed = options.speed ?? normalSpeed
  let mutes = options.mutes ?? []
  let stopAt: number | null = null
  let destroyed = false
  const timeListeners = new Set<(ms: number) => void>()
  const playingListeners = new Set<(p: boolean) => void>()
  const activeListeners = new Set<(a: boolean) => void>()
  let cameraActive = true
  const now = () => screen.currentTime * 1000
  const emit = () => timeListeners.forEach((f) => f(now()))

  /** The last source time seen while playing, and when it was seen. */
  let lastSeen: { ms: number; at: number } | null = null
  const see = () => {
    if (!screen.paused && !screen.seeking) lastSeen = { ms: now(), at: performance.now() }
  }
  /** Where the video resumed after its last early end, so an end there again isn't retried forever. */
  let resumedAt = -Infinity

  /**
   * Chrome sometimes ends a video with no sound track early, 1 to 1.5 seconds
   * before its last frame, the first time it plays through. Screen recordings
   * of a mostly still screen trigger it: the browser only records a frame when
   * something changes, so frames come about once a second, unevenly spaced.
   * When the video ends well before where it should be by now, this plays on
   * from there instead (which Chrome then does to the end), so the camera,
   * the voice and a take in progress all keep going.
   */
  const resumeEarlyEnd = (): boolean => {
    if (!screen.ended || lastSeen === null || stopAt !== null) return false
    const expected = lastSeen.ms + (performance.now() - lastSeen.at) * rateAt(speed, lastSeen.ms)
    const end = Math.min(options.durationMs, screen.duration * 1000)
    if (expected >= end - EARLY_END_MS || expected <= resumedAt + EARLY_END_MS) return false
    resumedAt = expected
    screen.currentTime = expected / 1000
    void screen.play().catch(() => {})
    return true
  }

  /** Sets each video's playback rate for the current time. */
  const syncRate = () => {
    const rate = rateAt(speed, now())
    if (screen.playbackRate !== rate) screen.playbackRate = rate
    if (!camera) return
    // The camera was recorded while the video played at some speed; it plays at
    // its natural pace when the video plays at that speed again.
    const camRate = rate / cameraRateAt(options.timing, now())
    if (camera.playbackRate !== camRate) camera.playbackRate = camRate
  }

  /**
   * Silences both videos inside a muted clip. This uses volume, not the muted
   * property, which the editor keeps for muting the screen's sound as a whole.
   * It looks a little ahead so a muted clip isn't heard for a moment after a
   * clip boundary.
   */
  const syncVolume = () => {
    const t = now()
    const silent = isInCut(mutes, t) || (!screen.paused && isInCut(mutes, t + LOOKAHEAD_MS * screen.playbackRate))
    const volume = silent ? 0 : 1
    if (screen.volume !== volume) screen.volume = volume
    if (camera && camera.volume !== volume) camera.volume = volume
  }

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
    const cut = cutAt(cuts, t + LOOKAHEAD_MS * screen.playbackRate) ?? cutAt(cuts, t)
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
    see()
    if (!screen.paused) {
      skipCuts()
      syncVolume()
    }
    if ("requestVideoFrameCallback" in screen) screen.requestVideoFrameCallback(onFrame)
  }
  if ("requestVideoFrameCallback" in screen) screen.requestVideoFrameCallback(onFrame)

  // Also check on animation frames, which keep running while the video stalls, and report the time.
  let raf = 0
  const tick = () => {
    if (destroyed) return
    see()
    if (!screen.paused) {
      skipCuts()
      syncRate()
      syncVolume()
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
    // Chrome fires pause and then ended. After an early end the video is
    // playing again by the time ended arrives, and it's ignored.
    if (!screen.paused || resumeEarlyEnd()) return
    camera?.pause()
    syncCamera(true)
    playingListeners.forEach((f) => f(false))
    emit()
  }
  const onSeeked = () => {
    syncRate()
    syncVolume()
    syncCamera(true)
    emit()
  }
  screen.addEventListener("play", onPlay)
  screen.addEventListener("pause", onPause)
  screen.addEventListener("seeked", onSeeked)
  screen.addEventListener("ended", onPause)
  // Time updates keep coming in a background tab, where animation frames stop.
  screen.addEventListener("timeupdate", see)
  // A jump (a seek, a cut skipped) makes the last time seen meaningless for judging an end.
  const onSeeking = () => {
    lastSeen = null
  }
  screen.addEventListener("seeking", onSeeking)

  return {
    play: () => {
      const t = now()
      // Restart from the beginning when at the end.
      if (t >= options.durationMs - 50) screen.currentTime = 0
      resumedAt = -Infinity
      skipCuts()
      syncRate()
      syncVolume()
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
      resumedAt = -Infinity
      syncRate()
      syncVolume()
      syncCamera(true)
      void screen.play().catch(() => {})
    },
    setCuts: (next) => {
      cuts = next
    },
    setSpeed: (next) => {
      speed = next
      syncRate()
    },
    setMutes: (next) => {
      mutes = next
      syncVolume()
    },
    currentMs: now,
    currentRate: () => rateAt(speed, now()),
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
      screen.removeEventListener("timeupdate", see)
      screen.removeEventListener("seeking", onSeeking)
      timeListeners.clear()
      playingListeners.clear()
      activeListeners.clear()
    }
  }
}
