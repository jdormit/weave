import { Context, Effect, Layer, Option, Schema } from "effect"
import { QuotaExceeded, RecordingNotFound, StorageFailed } from "../domain/errors.ts"
import { EditList, Recording, Transcript } from "../domain/schema.ts"
import { emptyEditList } from "../domain/editList.ts"

export type MediaKind = "screen" | "camera"
export type StoreError = StorageFailed | QuotaExceeded

export interface StorageUsage {
  readonly usage: number
  readonly quota: number
  readonly persisted: boolean
}

/**
 * Stores media files in OPFS (recordings/<id>/) and metadata in IndexedDB.
 * Every record is checked with its Schema when read or written.
 */
export class RecordingStore extends Context.Service<RecordingStore, {
  readonly list: Effect.Effect<ReadonlyArray<Recording>, StoreError>
  get(id: string): Effect.Effect<Recording, RecordingNotFound | StoreError>
  put(recording: Recording): Effect.Effect<void, StoreError>
  update(id: string, f: (r: Recording) => Recording): Effect.Effect<Recording, RecordingNotFound | StoreError>
  remove(id: string): Effect.Effect<void, StoreError>
  getTranscript(id: string): Effect.Effect<Option.Option<Transcript>, StoreError>
  putTranscript(transcript: Transcript): Effect.Effect<void, StoreError>
  getEdits(id: string): Effect.Effect<EditList, StoreError>
  putEdits(edits: EditList): Effect.Effect<void, StoreError>
  appendChunk(id: string, kind: MediaKind, index: number, data: Blob): Effect.Effect<void, StoreError>
  assembleChunks(id: string, kind: MediaKind): Effect.Effect<Option.Option<Blob>, StoreError>
  clearChunks(id: string): Effect.Effect<void, StoreError>
  writeFile(id: string, name: string, data: Blob): Effect.Effect<void, StoreError>
  readFile(id: string, name: string): Effect.Effect<Option.Option<File>, StoreError>
  /** Ids of recording folders in OPFS, to check that a delete removed the files. */
  readonly folders: Effect.Effect<ReadonlyArray<string>, StoreError>
  readonly recordingsBytes: Effect.Effect<number, StoreError>
  readonly usage: Effect.Effect<StorageUsage, StoreError>
  readonly requestPersist: Effect.Effect<boolean>
}>()("weave/RecordingStore") {
  static readonly layer = Layer.effect(RecordingStore, Effect.sync(() => makeBrowserStore()))
}

// ---------------------------------------------------------------------------

const DB_NAME = "weave"
const DB_VERSION = 1

const toStoreError = (cause: unknown): StoreError => {
  if (cause instanceof StorageFailed || cause instanceof QuotaExceeded) return cause
  if (cause instanceof DOMException && cause.name === "QuotaExceededError") return new QuotaExceeded()
  const message = cause instanceof Error ? cause.message : String(cause)
  return new StorageFailed({ message })
}

const attempt = <A>(f: () => Promise<A>): Effect.Effect<A, StoreError> =>
  Effect.tryPromise({ try: f, catch: toStoreError })

const reqToPromise = <A>(req: IDBRequest<A>): Promise<A> =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })

let dbPromise: Promise<IDBDatabase> | undefined
const openDb = (): Promise<IDBDatabase> => {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains("recordings")) db.createObjectStore("recordings", { keyPath: "id" })
      if (!db.objectStoreNames.contains("transcripts")) db.createObjectStore("transcripts", { keyPath: "recordingId" })
      if (!db.objectStoreNames.contains("edits")) db.createObjectStore("edits", { keyPath: "recordingId" })
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return dbPromise
}

const tx = async <A>(
  store: "recordings" | "transcripts" | "edits",
  mode: IDBTransactionMode,
  f: (s: IDBObjectStore) => IDBRequest<A>
): Promise<A> => {
  const db = await openDb()
  const t = db.transaction(store, mode)
  const result = await reqToPromise(f(t.objectStore(store)))
  await new Promise<void>((resolve, reject) => {
    t.oncomplete = () => resolve()
    t.onerror = () => reject(t.error)
    t.onabort = () => reject(t.error)
  })
  return result
}

const decodeRecording = Schema.decodeUnknownEffect(Recording)
const encodeRecording = Schema.encodeEffect(Recording)
const decodeTranscript = Schema.decodeUnknownEffect(Transcript)
const encodeTranscript = Schema.encodeEffect(Transcript)
const decodeEdits = Schema.decodeUnknownEffect(EditList)
const encodeEdits = Schema.encodeEffect(EditList)

const schemaError = (e: { readonly message: string }) => new StorageFailed({ message: `Invalid data: ${e.message}` })

const root = () => navigator.storage.getDirectory()
const recordingsDir = async (create = true) => (await root()).getDirectoryHandle("recordings", { create })
const recordingDir = async (id: string, create = true) => (await recordingsDir(create)).getDirectoryHandle(id, { create })
const chunksDir = async (id: string, create = true) => (await recordingDir(id, create)).getDirectoryHandle("chunks", { create })

const isNotFound = (e: unknown) => e instanceof DOMException && (e.name === "NotFoundError" || e.name === "TypeMismatchError")

const writeBlob = async (dir: FileSystemDirectoryHandle, name: string, data: Blob) => {
  const handle = await dir.getFileHandle(name, { create: true })
  const w = await handle.createWritable()
  try {
    await w.write(data)
    await w.close()
  } catch (e) {
    await w.abort().catch(() => {})
    throw e
  }
}

const dirSize = async (dir: FileSystemDirectoryHandle): Promise<number> => {
  let total = 0
  for await (const [, handle] of dir.entries()) {
    if (handle.kind === "file") total += (await (handle as FileSystemFileHandle).getFile()).size
    else total += await dirSize(handle as FileSystemDirectoryHandle)
  }
  return total
}

const chunkName = (kind: MediaKind, index: number) => `${kind}-${String(index).padStart(6, "0")}.webm`

const makeBrowserStore = (): RecordingStore["Service"] => {
  const get = (id: string): Effect.Effect<Recording, RecordingNotFound | StoreError> =>
    Effect.gen(function*() {
      const raw = yield* attempt(() => tx("recordings", "readonly", (s) => s.get(id)))
      if (raw === undefined) return yield* new RecordingNotFound({ id })
      return yield* decodeRecording(raw).pipe(Effect.mapError(schemaError))
    })
  const put = (recording: Recording) =>
    encodeRecording(recording).pipe(
      Effect.mapError(schemaError),
      Effect.flatMap((encoded) => attempt(() => tx("recordings", "readwrite", (s) => s.put(encoded)))),
      Effect.asVoid
    )
  return RecordingStore.of({
    list: attempt(() => tx("recordings", "readonly", (s) => s.getAll())).pipe(
      Effect.flatMap((rows) =>
        Effect.forEach(rows, (row) => decodeRecording(row).pipe(Effect.option))
      ),
      Effect.map((rows) =>
        rows.flatMap((r) => (Option.isSome(r) ? [r.value] : [])).sort((a, b) => b.createdAt - a.createdAt)
      )
    ),
    get,
    put,
    update: (id, f) =>
      get(id).pipe(
        Effect.map(f),
        Effect.tap(put)
      ),
    remove: (id) =>
      attempt(async () => {
        await tx("recordings", "readwrite", (s) => s.delete(id))
        await tx("transcripts", "readwrite", (s) => s.delete(id))
        await tx("edits", "readwrite", (s) => s.delete(id))
        try {
          await (await recordingsDir()).removeEntry(id, { recursive: true })
        } catch (e) {
          if (!isNotFound(e)) throw e
        }
      }),
    getTranscript: (id) =>
      Effect.gen(function*() {
        const raw = yield* attempt(() => tx("transcripts", "readonly", (s) => s.get(id)))
        if (raw === undefined) return Option.none<Transcript>()
        return Option.some(yield* decodeTranscript(raw).pipe(Effect.mapError(schemaError)))
      }),
    putTranscript: (transcript) =>
      encodeTranscript(transcript).pipe(
        Effect.mapError(schemaError),
        Effect.flatMap((encoded) => attempt(() => tx("transcripts", "readwrite", (s) => s.put(encoded)))),
        Effect.asVoid
      ),
    getEdits: (id) =>
      Effect.gen(function*() {
        const raw = yield* attempt(() => tx("edits", "readonly", (s) => s.get(id)))
        if (raw === undefined) return emptyEditList(id)
        return yield* decodeEdits(raw).pipe(Effect.mapError(schemaError))
      }),
    putEdits: (edits) =>
      encodeEdits(edits).pipe(
        Effect.mapError(schemaError),
        Effect.flatMap((encoded) => attempt(() => tx("edits", "readwrite", (s) => s.put(encoded)))),
        Effect.asVoid
      ),
    appendChunk: (id, kind, index, data) =>
      attempt(async () => writeBlob(await chunksDir(id), chunkName(kind, index), data)),
    assembleChunks: (id, kind) =>
      attempt(async () => {
        let dir: FileSystemDirectoryHandle
        try {
          dir = await chunksDir(id, false)
        } catch (e) {
          if (isNotFound(e)) return Option.none<Blob>()
          throw e
        }
        const names: Array<string> = []
        for await (const name of dir.keys()) if (name.startsWith(`${kind}-`)) names.push(name)
        if (names.length === 0) return Option.none<Blob>()
        names.sort()
        const parts: Array<File> = []
        for (const name of names) parts.push(await (await dir.getFileHandle(name)).getFile())
        return Option.some(new Blob(parts, { type: "video/webm" }))
      }),
    clearChunks: (id) =>
      attempt(async () => {
        try {
          await (await recordingDir(id, false)).removeEntry("chunks", { recursive: true })
        } catch (e) {
          if (!isNotFound(e)) throw e
        }
      }),
    writeFile: (id, name, data) => attempt(async () => writeBlob(await recordingDir(id), name, data)),
    readFile: (id, name) =>
      attempt(async () => {
        try {
          const handle = await (await recordingDir(id, false)).getFileHandle(name)
          return Option.some(await handle.getFile())
        } catch (e) {
          if (isNotFound(e)) return Option.none<File>()
          throw e
        }
      }),
    folders: attempt(async () => {
      const out: Array<string> = []
      for await (const name of (await recordingsDir()).keys()) out.push(name)
      return out
    }),
    recordingsBytes: attempt(async () => dirSize(await recordingsDir())),
    usage: attempt(async () => {
      const est = await navigator.storage.estimate()
      const persisted = (await navigator.storage.persisted?.()) ?? false
      return { usage: est.usage ?? 0, quota: est.quota ?? 0, persisted }
    }),
    requestPersist: Effect.promise(async () => {
      try {
        return (await navigator.storage.persist?.()) ?? false
      } catch {
        return false
      }
    })
  })
}
