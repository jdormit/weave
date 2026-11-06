import * as Atom from "effect/reactivity/Atom"
import { createContext, useContext } from "react"
import type { Recording, Transcript, Word } from "../domain/schema.ts"
import type { Cut } from "../domain/schema.ts"
import type { PlayerController } from "../services/Player.ts"

/** Source time of the playhead. */
export const playheadAtom = Atom.family((_id: string) => Atom.make(0).pipe(Atom.keepAlive))
export const playingAtom = Atom.family((_id: string) => Atom.make(false).pipe(Atom.keepAlive))
/** Selected words, as indexes into the word list. */
export const selectionAtom = Atom.family((_id: string) =>
  Atom.make<{ anchor: number; focus: number } | null>(null).pipe(Atom.keepAlive)
)
/** Selected clip on the timeline, by its source range. */
export const selectedClipAtom = Atom.family((_id: string) =>
  Atom.make<{ startMs: number; endMs: number } | null>(null).pipe(Atom.keepAlive)
)
/** Timeline zoom, as a multiple of fit-to-width. */
export const zoomAtom = Atom.family((_id: string) => Atom.make(1).pipe(Atom.keepAlive))

export interface EditorContextValue {
  readonly id: string
  readonly recording: Recording
  readonly transcript: Transcript | null
  /** Words to show: the saved transcript, or words found so far while it runs. */
  readonly words: ReadonlyArray<Word>
  readonly cuts: ReadonlyArray<Cut>
  readonly splits: ReadonlyArray<number>
  readonly player: { current: PlayerController | null }
  readonly screenUrl: string | null
  readonly cameraUrl: string | null
  readonly audio: Float32Array | null
  readonly screenFile: File | null
  readonly cameraFile: File | null
}

export const EditorContext = createContext<EditorContextValue | null>(null)

export const useEditor = (): EditorContextValue => {
  const v = useContext(EditorContext)
  if (!v) throw new Error("useEditor must be used inside the editor")
  return v
}

/** A camera and voice take being recorded in the editor. */
export interface Take {
  readonly phase: "countdown" | "recording" | "saving"
  readonly count: number
  /** The live camera, shown in the bubble while recording. */
  readonly camera: MediaStream | null
  readonly keepScreenAudio: boolean
  /** performance.now() when recording started. */
  readonly startedAt: number
}
export const takeAtom = Atom.family((_id: string) => Atom.make<Take | null>(null).pipe(Atom.keepAlive))
/** Goes up when the recording's media files change, so the editor reloads them. */
export const mediaVersionAtom = Atom.family((_id: string) => Atom.make(0).pipe(Atom.keepAlive))
