import * as Atom from "effect/reactivity/Atom"
import { editedDuration, editedToSource, normalizeCuts, sourceToEdited } from "../domain/editList.ts"
import { playheadAtom, type EditorContextValue } from "./editorState.ts"
import { registry } from "./state.ts"

/**
 * Where playback starts, as a source time. It works like a DAW's start
 * marker: it stays put while the video plays, and stopping returns the
 * playhead to it. Only an explicit move (a click, a drag, a jump) changes it.
 */
export const markerAtom = Atom.family((_id: string) => Atom.make(0).pipe(Atom.keepAlive))

type Ctx = Pick<EditorContextValue, "id" | "player" | "cuts" | "recording" | "speed">

/** Moves the start marker, and the playhead with it, to a source time. */
export const moveTo = (c: Ctx, sourceMs: number) => {
  const t = Math.max(0, Math.min(c.recording.durationMs, sourceMs))
  registry.set(markerAtom(c.id), t)
  const p = c.player.current
  if (p) p.seek(t)
  else registry.set(playheadAtom(c.id), t)
}

/** Moves the marker by an amount of edited (after cuts) time, from where the playhead is now. */
export const moveBy = (c: Ctx, editedDeltaMs: number) => {
  const cuts = normalizeCuts(c.cuts, c.recording.durationMs)
  const from = c.player.current?.playing() ? c.player.current.currentMs() : registry.get(markerAtom(c.id))
  const edited = Math.max(0, Math.min(editedDuration(cuts, c.recording.durationMs, c.speed), sourceToEdited(cuts, from, c.speed) + editedDeltaMs))
  moveTo(c, editedToSource(cuts, edited, c.speed))
}

export const jumpToStart = (c: Ctx) => moveTo(c, 0)

/** The last moment of the edited video. */
export const jumpToEnd = (c: Ctx) => {
  const cuts = normalizeCuts(c.cuts, c.recording.durationMs)
  moveTo(c, editedToSource(cuts, Math.max(0, editedDuration(cuts, c.recording.durationMs, c.speed) - 1), c.speed))
}

/** Plays from the marker, or stops and goes back to it. */
export const togglePlay = (c: Ctx) => {
  const p = c.player.current
  if (!p) return
  if (p.playing()) p.pause()
  else p.play()
}

/** Called when playback stops for any reason: the playhead returns to the marker. */
export const returnToMarker = (c: Ctx) => {
  c.player.current?.seek(registry.get(markerAtom(c.id)))
}
