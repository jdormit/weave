import { useAtomValue } from "@effect/atom-react"
import { Effect, Option } from "effect"
import { useEffect, useRef, useState } from "react"
import type { Recording } from "../../domain/schema.ts"
import { formatClock } from "../../domain/transcriptFormat.ts"
import { RecordingStore } from "../../services/RecordingStore.ts"
import { run } from "../../services/runtime.ts"
import { finalizeRecording, recoverableMs } from "../../services/workflows.ts"
import { Nav } from "../App.tsx"
import { ConfirmDialog } from "../components/Dialog.tsx"
import { formatBytes, formatDate } from "../format.ts"
import { Icon } from "../Icon.tsx"
import { navigate, onLinkClick } from "../router.ts"
import {
  jobAtom,
  recordingAtom as recordingAtomFor,
  recordingsAtom,
  refreshRecordings,
  registry,
  startTranscription,
  toast,
  toastError,
  unfinishedAtom,
  updateRecording
} from "../state.ts"

const useStorage = (deps: unknown) => {
  const [usage, setUsage] = useState<{ used: number; quota: number } | null>(null)
  useEffect(() => {
    void run(Effect.gen(function*() {
      const store = yield* RecordingStore
      const u = yield* store.usage
      return { used: yield* store.recordingsBytes, quota: u.quota }
    })).then(setUsage, () => setUsage(null))
  }, [deps])
  return usage
}

export const Library = () => {
  const recordings = useAtomValue(recordingsAtom)
  const unfinished = useAtomValue(unfinishedAtom)
  const usage = useStorage(recordings)
  useEffect(() => {
    void refreshRecordings()
  }, [])
  return (
    <>
      <Nav current="library" />
      <main className="page">
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-end", justifyContent: "space-between", gap: 16, marginBottom: 24 }}>
          <div>
            <h1>Library</h1>
            <p className="lede">
              {recordings === null
                ? "Loading…"
                : `${recordings.length} recording${recordings.length === 1 ? "" : "s"}, stored in this browser only`}
            </p>
          </div>
          {usage && (
            <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 220 }} data-testid="storage">
              <div className="tnum" style={{ fontSize: 13, color: "var(--muted)", display: "flex", justifyContent: "space-between", gap: 12 }}>
                <span>Storage</span>
                <span><b style={{ color: "var(--ink)", fontWeight: 550 }}>{formatBytes(usage.used)}</b> of {formatBytes(usage.quota)}</span>
              </div>
              <div className="bar ink"><div style={{ width: `${Math.min(100, Math.max(1, (usage.used / Math.max(1, usage.quota)) * 100))}%` }} /></div>
            </div>
          )}
        </div>
        {unfinished.map((r) => <RecoverBanner key={r.id} recording={r} />)}
        {recordings && recordings.length === 0 && (
          <div className="empty">
            <h2>No recordings yet</h2>
            <p>Record your screen and camera. Everything stays on this device.</p>
            <a className="btn primary" href="/record" onClick={onLinkClick("/record")}>
              <Icon name="record" />New recording
            </a>
          </div>
        )}
        <div className="grid" data-testid="library-grid">
          {recordings?.map((r) => <RecordingCard key={r.id} recording={r} />)}
        </div>
      </main>
    </>
  )
}

const RecoverBanner = ({ recording }: { recording: Recording }) => {
  const [ms, setMs] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    void run(recoverableMs(recording.id)).then(setMs, () => setMs(0))
  }, [recording.id])
  const discard = async () => {
    setBusy(true)
    await run(Effect.gen(function*() { yield* (yield* RecordingStore).remove(recording.id) })).catch(toastError)
    await refreshRecordings()
  }
  const recover = async () => {
    setBusy(true)
    try {
      await run(finalizeRecording(recording.id))
      await refreshRecordings()
      toast("Recording recovered.")
    } catch (e) {
      toastError(e)
      setBusy(false)
    }
  }
  const when = new Date(recording.createdAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
  return (
    <section className="banner" aria-label="Recovered recording" data-testid="recover-banner">
      <Icon name="alert" style={{ color: "var(--accent)" }} />
      <div style={{ flex: 1, minWidth: 260 }}>
        <b style={{ fontWeight: 550 }}>A recording from {formatDate(recording.createdAt).startsWith("Today") ? `today at ${when}` : formatDate(recording.createdAt)} didn't finish saving.</b>{" "}
        <span className="muted">
          {ms === null ? "Checking what can be recovered…" : ms > 0 ? `${formatClock(ms)} of video can be recovered.` : "No video can be recovered."}
        </span>
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <button className="btn ghost" disabled={busy} onClick={discard}>Discard</button>
        {ms !== 0 && <button className="btn" disabled={busy || ms === null} onClick={recover}>Recover recording</button>}
      </div>
    </section>
  )
}

const useThumbnail = (id: string) => {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    let revoked = false
    let made: string | null = null
    void run(Effect.gen(function*() { return yield* (yield* RecordingStore).readFile(id, "thumb.webp") })).then((f) => {
      if (revoked || Option.isNone(f)) return
      made = URL.createObjectURL(f.value)
      setUrl(made)
    }, () => {})
    return () => {
      revoked = true
      if (made) URL.revokeObjectURL(made)
    }
  }, [id])
  return url
}

const StatusPill = ({ recording }: { recording: Recording }) => {
  const job = useAtomValue(jobAtom(recording.id))
  if (job.stage === "download") {
    return <span className="pill busy">Downloading model {job.total ? Math.round((job.loaded / job.total) * 100) : 0}%</span>
  }
  if (job.stage === "transcribe") {
    return <span className="pill busy">Transcribing {job.chunks ? Math.round((job.done / job.chunks) * 100) : 0}%</span>
  }
  switch (recording.transcriptStatus) {
    case "done":
      return <span className="pill ok">Transcribed</span>
    case "running":
      return <span className="pill busy">Transcribing</span>
    case "error":
      return <span className="pill err">Transcription failed</span>
    case "none":
      return <span className="pill">Not transcribed</span>
  }
}

const RecordingCard = ({ recording }: { recording: Recording }) => {
  const thumb = useThumbnail(recording.id)
  const [menu, setMenu] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const href = `/r/${encodeURIComponent(recording.id)}`
  useEffect(() => {
    if (!menu) return
    const close = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenu(false)
    }
    window.addEventListener("mousedown", close)
    return () => window.removeEventListener("mousedown", close)
  }, [menu])
  const remove = async () => {
    setConfirmDelete(false)
    try {
      await run(Effect.gen(function*() { yield* (yield* RecordingStore).remove(recording.id) }))
      registry.update(recordingsAtom, (rs) => rs?.filter((r) => r.id !== recording.id) ?? rs)
      toast(`Deleted "${recording.title}".`)
    } catch (e) {
      toastError(e)
    }
  }
  return (
    <article className="card" data-testid="recording-card" data-id={recording.id}>
      <a className="thumb" href={href} onClick={onLinkClick(href)} aria-label={`Open ${recording.title}`}>
        {thumb && <img src={thumb} alt="" />}
        <span className="dur tnum">{formatClock(recording.durationMs)}</span>
      </a>
      <div style={{ display: "flex", gap: 8, alignItems: "flex-start", padding: "12px 8px 14px 14px" }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          {renaming
            ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault()
                  const v = new FormData(e.currentTarget).get("title")?.toString().trim()
                  if (v) {
                    registry.set(recordingAtomFor(recording.id), recording)
                    updateRecording(recording.id, (r) => ({ ...r, title: v }))
                  }
                  setRenaming(false)
                }}
              >
                <input
                  name="title"
                  aria-label="Title"
                  className="titleinput"
                  style={{ width: "100%", borderColor: "var(--line)" }}
                  defaultValue={recording.title}
                  autoFocus
                  onBlur={(e) => e.currentTarget.form?.requestSubmit()}
                  onKeyDown={(e) => e.key === "Escape" && setRenaming(false)}
                />
              </form>
            )
            : <h2><a href={href} onClick={onLinkClick(href)}>{recording.title}</a></h2>}
          <p className="meta">{formatDate(recording.createdAt)}</p>
          <StatusPill recording={recording} />
        </div>
        <div ref={menuRef} style={{ position: "static" }}>
          <button className="iconbtn" aria-label="More actions" aria-expanded={menu} onClick={() => setMenu((m) => !m)}>
            <Icon name="more" />
          </button>
          {menu && (
            <div className="menu" role="menu">
              <button role="menuitem" onClick={() => navigate(href)}>Open</button>
              <button role="menuitem" onClick={() => { setMenu(false); setRenaming(true) }}>Rename</button>
              {recording.transcriptStatus !== "done" && recording.transcriptStatus !== "running" && (
                <button role="menuitem" onClick={() => { setMenu(false); startTranscription(recording.id) }}>Transcribe</button>
              )}
              <button role="menuitem" className="danger" onClick={() => { setMenu(false); setConfirmDelete(true) }}>Delete</button>
            </div>
          )}
        </div>
      </div>
      {confirmDelete && (
        <ConfirmDialog
          title="Delete this recording?"
          body={`"${recording.title}" and its transcript and edits will be removed from this browser. This can't be undone.`}
          confirm="Delete"
          danger
          onConfirm={remove}
          onCancel={() => setConfirmDelete(false)}
        />
      )}
    </article>
  )
}

