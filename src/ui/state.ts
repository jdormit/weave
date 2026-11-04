import { Effect, Fiber, Option } from "effect"
import * as Atom from "effect/reactivity/Atom"
import * as AtomRegistry from "effect/reactivity/AtomRegistry"
import { commit, redo, undo } from "../domain/editList.ts"
import { describeError } from "../domain/errors.ts"
import type { EditList, EditState, Recording, Settings as SettingsType, Transcript, Word } from "../domain/schema.ts"
import { defaultSettings } from "../domain/schema.ts"
import { RecordingStore } from "../services/RecordingStore.ts"
import { Settings } from "../services/Settings.ts"
import { run, runtime } from "../services/runtime.ts"
import { transcribeRecording, unfinishedRecordings } from "../services/workflows.ts"

/** The one atom registry, shared by React and by actions outside components. */
export const registry = AtomRegistry.make()

const keep = <A>(initial: A) => Atom.make(initial).pipe(Atom.keepAlive)

// ---------------------------------------------------------------------------
// Toasts

export interface Toast {
  readonly id: number
  readonly text: string
}
export const toastsAtom = keep<ReadonlyArray<Toast>>([])
let toastId = 0
export const toast = (text: string) => {
  const id = ++toastId
  registry.update(toastsAtom, (ts) => [...ts, { id, text }])
  setTimeout(() => dismissToast(id), 8000)
}
export const dismissToast = (id: number) => registry.update(toastsAtom, (ts) => ts.filter((t) => t.id !== id))
export const toastError = (e: unknown) => toast(describeError(e))

// ---------------------------------------------------------------------------
// Settings

export const settingsAtom = keep<SettingsType>(defaultSettings)
export const loadSettings = async () => registry.set(settingsAtom, await run(Effect.gen(function*() { return yield* (yield* Settings).get })))
export const updateSettings = (f: (s: SettingsType) => SettingsType) => {
  const next = f(registry.get(settingsAtom))
  registry.set(settingsAtom, next)
  void run(Effect.gen(function*() { yield* (yield* Settings).set(next) }))
}

// ---------------------------------------------------------------------------
// Library

export const recordingsAtom = keep<ReadonlyArray<Recording> | null>(null)
export const unfinishedAtom = keep<ReadonlyArray<Recording>>([])

export const refreshRecordings = async () => {
  try {
    const all = await run(Effect.gen(function*() { return yield* (yield* RecordingStore).list }))
    registry.set(recordingsAtom, all.filter((r) => r.status === "ready"))
    registry.set(unfinishedAtom, await run(unfinishedRecordings))
  } catch (e) {
    registry.set(recordingsAtom, [])
    toastError(e)
  }
}

// ---------------------------------------------------------------------------
// Editor

export interface TranscriptionJob {
  readonly stage: "idle" | "download" | "transcribe" | "done" | "error"
  readonly loaded: number
  readonly total: number
  readonly done: number
  readonly chunks: number
  readonly error: string | null
}
const idleJob: TranscriptionJob = { stage: "idle", loaded: 0, total: 0, done: 0, chunks: 0, error: null }

export const recordingAtom = Atom.family((_id: string) => keep<Recording | null>(null))
export const transcriptAtom = Atom.family((_id: string) => keep<Transcript | null>(null))
export const editsAtom = Atom.family((_id: string) => keep<EditList | null>(null))
export const jobAtom = Atom.family((_id: string) => keep<TranscriptionJob>(idleJob))
/** Words found so far while transcription runs. */
export const partialWordsAtom = Atom.family((_id: string) => keep<ReadonlyArray<Word>>([]))
export const loadErrorAtom = Atom.family((_id: string) => keep<string | null>(null))

export const loadEditor = async (id: string) => {
  registry.set(loadErrorAtom(id), null)
  try {
    const { recording, transcript, edits } = await run(
      Effect.gen(function*() {
        const store = yield* RecordingStore
        return {
          recording: yield* store.get(id),
          transcript: yield* store.getTranscript(id),
          edits: yield* store.getEdits(id)
        }
      })
    )
    registry.set(recordingAtom(id), recording)
    registry.set(transcriptAtom(id), Option.getOrNull(transcript))
    registry.set(editsAtom(id), edits)
    // A transcription that was running when the page closed starts again.
    const job = registry.get(jobAtom(id))
    if (recording.transcriptStatus === "running" && job.stage !== "download" && job.stage !== "transcribe") {
      startTranscription(id)
    }
  } catch (e) {
    registry.set(loadErrorAtom(id), describeError(e))
  }
}

const persistEdits = (edits: EditList) => {
  void run(Effect.gen(function*() { yield* (yield* RecordingStore).putEdits(edits) })).catch(toastError)
}

/** Applies a change to the cuts and splits as one undoable step. */
export const applyEdit = (id: string, f: (state: EditState) => EditState) => {
  const current = registry.get(editsAtom(id))
  if (!current) return
  const next = commit(current, f({ cuts: current.cuts, splits: current.splits }))
  if (next === current) return
  registry.set(editsAtom(id), next)
  persistEdits(next)
}

export const undoEdit = (id: string) => {
  const current = registry.get(editsAtom(id))
  if (!current || current.past.length === 0) return
  const next = undo(current)
  registry.set(editsAtom(id), next)
  persistEdits(next)
}

export const redoEdit = (id: string) => {
  const current = registry.get(editsAtom(id))
  if (!current || current.future.length === 0) return
  const next = redo(current)
  registry.set(editsAtom(id), next)
  persistEdits(next)
}

export const updateRecording = (id: string, f: (r: Recording) => Recording) => {
  const current = registry.get(recordingAtom(id))
  if (!current) return
  const next = f(current)
  registry.set(recordingAtom(id), next)
  void run(Effect.gen(function*() { yield* (yield* RecordingStore).put(next) })).then(
    () => {
      const list = registry.get(recordingsAtom)
      if (list) registry.set(recordingsAtom, list.map((r) => (r.id === id ? next : r)))
    },
    toastError
  )
}

const jobs = new Map<string, Fiber.Fiber<unknown, unknown>>()

export const startTranscription = (id: string) => {
  if (jobs.has(id)) return
  const set = (j: Partial<TranscriptionJob>) => registry.update(jobAtom(id), (cur) => ({ ...cur, ...j }))
  set({ ...idleJob, stage: "transcribe" })
  registry.set(partialWordsAtom(id), [])
  registry.update(recordingAtom(id), (r) => (r ? { ...r, transcriptStatus: "running" as const } : r))
  const fiber = runtime.runFork(
    transcribeRecording(id, {
      onDownload: (loaded, total) => set({ stage: "download", loaded, total }),
      onProgress: (done, total) => set({ stage: "transcribe", done, chunks: total }),
      onPartial: (words) => registry.set(partialWordsAtom(id), words)
    }).pipe(
      Effect.tap((transcript) =>
        Effect.sync(() => {
          registry.set(transcriptAtom(id), transcript)
          registry.update(recordingAtom(id), (r) => (r ? { ...r, transcriptStatus: "done" as const } : r))
          set({ stage: "done" })
          void refreshRecordings()
        })
      ),
      Effect.tapError((e) =>
        Effect.sync(() => {
          set({ stage: "error", error: describeError(e) })
          registry.update(recordingAtom(id), (r) => (r ? { ...r, transcriptStatus: "error" as const } : r))
        })
      ),
      Effect.ensuring(Effect.sync(() => jobs.delete(id)))
    )
  )
  jobs.set(id, fiber)
}

export const cancelTranscription = async (id: string) => {
  const fiber = jobs.get(id)
  if (fiber) await runtime.runPromise(Fiber.interrupt(fiber))
  registry.set(jobAtom(id), idleJob)
}

export const isTranscribing = (id: string) => jobs.has(id)
