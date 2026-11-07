import { useAtomValue } from "@effect/atom-react"
import { Effect, Option } from "effect"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { addCut, addSplit, clips, editedDuration, isWordCut, setMuted, toggleWords } from "../../domain/editList.ts"
import { RecordingStore } from "../../services/RecordingStore.ts"
import type { PlayerController } from "../../services/Player.ts"
import { run } from "../../services/runtime.ts"
import { recordingAudio } from "../../services/workflows.ts"
import { CleanupDialog } from "../components/CleanupDialog.tsx"
import { Dialog } from "../components/Dialog.tsx"
import { ExportDialog } from "../components/ExportDialog.tsx"
import { RetakeDialog } from "../components/RetakeDialog.tsx"
import { Preview } from "../components/Preview.tsx"
import { Timeline } from "../components/Timeline.tsx"
import { TranscriptPanel } from "../components/TranscriptPanel.tsx"
import { EditorContext, mediaVersionAtom, playheadAtom, takeAtom, selectedClipAtom, selectionAtom, zoomAtom, type EditorContextValue } from "../editorState.ts"
import { Icon } from "../Icon.tsx"
import { onLinkClick } from "../router.ts"
import { jumpToEnd, jumpToStart, moveBy, togglePlay } from "../transport.ts"
import {
  applyEdit,
  editsAtom,
  loadEditor,
  loadErrorAtom,
  partialWordsAtom,
  recordingAtom,
  redoEdit,
  registry,
  transcriptAtom,
  undoEdit,
  updateRecording
} from "../state.ts"

const useMediaFiles = (id: string, ready: boolean, version: number) => {
  const [files, setFiles] = useState<{ screen: File | null; camera: File | null; screenUrl: string | null; cameraUrl: string | null }>({
    screen: null,
    camera: null,
    screenUrl: null,
    cameraUrl: null
  })
  useEffect(() => {
    if (!ready) return
    let alive = true
    const urls: Array<string> = []
    void run(Effect.gen(function*() {
      const store = yield* RecordingStore
      return { screen: yield* store.readFile(id, "screen.webm"), camera: yield* store.readFile(id, "camera.webm") }
    })).then(({ screen, camera }) => {
      if (!alive) return
      const s = Option.getOrNull(screen)
      const c = Option.getOrNull(camera)
      const su = s ? URL.createObjectURL(s) : null
      const cu = c ? URL.createObjectURL(c) : null
      if (su) urls.push(su)
      if (cu) urls.push(cu)
      setFiles({ screen: s, camera: c, screenUrl: su, cameraUrl: cu })
    })
    return () => {
      alive = false
      urls.forEach((u) => URL.revokeObjectURL(u))
    }
  }, [id, ready, version])
  return files
}

const isTyping = (e: KeyboardEvent) => {
  const t = e.target as HTMLElement | null
  return !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)
}

export const Editor = ({ id }: { id: string }) => {
  const recording = useAtomValue(recordingAtom(id))
  const transcript = useAtomValue(transcriptAtom(id))
  const partial = useAtomValue(partialWordsAtom(id))
  const edits = useAtomValue(editsAtom(id))
  const loadError = useAtomValue(loadErrorAtom(id))
  const [dialog, setDialog] = useState<"cleanup" | "export" | "shortcuts" | "retake" | null>(null)
  const mediaVersion = useAtomValue(mediaVersionAtom(id))
  const take = useAtomValue(takeAtom(id))
  const [audio, setAudio] = useState<Float32Array | null>(null)
  const player = useRef<PlayerController | null>(null)

  useEffect(() => {
    void loadEditor(id)
    registry.set(selectionAtom(id), null)
    registry.set(selectedClipAtom(id), null)
  }, [id])
  const ready = recording?.status === "ready"
  const media = useMediaFiles(id, ready, mediaVersion)
  useEffect(() => {
    if (!ready) return
    let alive = true
    void run(recordingAudio(id)).then((a) => alive && setAudio(a), () => {})
    return () => {
      alive = false
    }
  }, [id, ready, mediaVersion, recording?.screenAudioMuted])

  const words = transcript?.words ?? partial
  const ctx = useMemo<EditorContextValue | null>(
    () =>
      recording && edits
        ? {
          id,
          recording,
          transcript,
          words,
          cuts: edits.cuts,
          splits: edits.splits,
          speeds: edits.speeds,
          speed: { ranges: edits.speeds, global: edits.speed },
          mutes: edits.mutes,
          player,
          screenUrl: media.screenUrl,
          cameraUrl: media.cameraUrl,
          screenFile: media.screen,
          cameraFile: media.camera,
          audio
        }
        : null,
    [id, recording, transcript, words, edits, media, audio]
  )

  // Keyboard shortcuts for every editing action.
  const ctxRef = useRef(ctx)
  ctxRef.current = ctx
  const dialogRef = useRef(dialog)
  dialogRef.current = dialog
  const onKey = useCallback((e: KeyboardEvent) => {
    const c = ctxRef.current
    if (!c || dialogRef.current || registry.get(takeAtom(id)) || isTyping(e)) return
    const mod = e.metaKey || e.ctrlKey
    const key = e.key
    if (mod && (key === "z" || key === "Z")) {
      e.preventDefault()
      if (e.shiftKey) redoEdit(id)
      else undoEdit(id)
      return
    }
    if (mod && (key === "y" || key === "Y")) {
      e.preventDefault()
      redoEdit(id)
      return
    }
    if (mod) return
    if (key === " ") {
      e.preventDefault()
      togglePlay(c)
    } else if (key === "Delete" || key === "Backspace") {
      e.preventDefault()
      deleteSelection(c)
    } else if (key === "s" || key === "S") {
      e.preventDefault()
      splitAtPlayhead(c)
    } else if (key === "m" || key === "M") {
      e.preventDefault()
      toggleMuteSelected(c)
    } else if (key === "+" || key === "=") {
      registry.update(zoomAtom(id), (z) => Math.min(64, z * 1.5))
    } else if (key === "-" || key === "_") {
      registry.update(zoomAtom(id), (z) => Math.max(1, z / 1.5))
    } else if (key === "?") {
      setDialog("shortcuts")
    } else if (key === "Escape") {
      registry.set(selectionAtom(id), null)
      registry.set(selectedClipAtom(id), null)
    } else if (key === "ArrowLeft" || key === "ArrowRight") {
      e.preventDefault()
      moveBy(c, key === "ArrowLeft" ? -5000 : 5000)
    } else if (key === "Home") {
      e.preventDefault()
      jumpToStart(c)
    } else if (key === "End") {
      e.preventDefault()
      jumpToEnd(c)
    }
  }, [id])
  useEffect(() => {
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onKey])

  if (loadError) {
    return (
      <main className="page">
        <h1>Can't open this recording</h1>
        <p className="lede">{loadError}</p>
        <p><a href="/" onClick={onLinkClick("/")}>Back to your library</a></p>
      </main>
    )
  }
  if (!ctx || !recording || !edits) return <main className="page"><p className="lede">Loading…</p></main>
  if (!ready) {
    return (
      <main className="page">
        <h1>This recording didn't finish saving</h1>
        <p className="lede">Go to your library to recover it.</p>
        <p><a href="/" onClick={onLinkClick("/")}>Back to your library</a></p>
      </main>
    )
  }

  return (
    <EditorContext.Provider value={ctx}>
      <div className="editor" data-testid="editor">
        <header className="ehead">
          <a className="iconbtn" href="/" onClick={onLinkClick("/")} aria-label="Back to library">
            <Icon name="back" />
          </a>
          <TitleInput id={id} title={recording.title} />
          <span style={{ fontSize: 13, color: "var(--muted)" }}>Saved on this device</span>
          <div className="spacer" />
          <button className="iconbtn" aria-label="Undo" title="Undo (Ctrl+Z)" disabled={edits.past.length === 0} onClick={() => undoEdit(id)}>
            <Icon name="undo" />
          </button>
          <button className="iconbtn" aria-label="Redo" title="Redo (Ctrl+Shift+Z)" disabled={edits.future.length === 0} onClick={() => redoEdit(id)}>
            <Icon name="redo" />
          </button>
          <span className="vsep" />
          <button
            className="btn small"
            onClick={() => setDialog("retake")}
            disabled={take !== null}
            title="Record your camera and voice again while the video plays"
          >
            <Icon name="camera" />{recording.hasCamera || recording.cameraAudio ? "Re-record camera" : "Add camera"}
          </button>
          <button className="btn small" onClick={() => setDialog("cleanup")} disabled={!transcript || take !== null}>
            <Icon name="cleanup" />Clean up
          </button>
          <button className="btn primary small" onClick={() => setDialog("export")} disabled={take !== null}>
            <Icon name="download" />Export
          </button>
        </header>
        <Body />
        <Timeline />
        {dialog === "cleanup" && <CleanupDialog onClose={() => setDialog(null)} />}
        {dialog === "export" && <ExportDialog onClose={() => setDialog(null)} />}
        {dialog === "retake" && <RetakeDialog onClose={() => setDialog(null)} />}
        {dialog === "shortcuts" && <ShortcutsDialog onClose={() => setDialog(null)} />}
        <ShortcutsButtonPortal onOpen={() => setDialog("shortcuts")} />
      </div>
    </EditorContext.Provider>
  )
}

/** Opens the shortcuts list from the button under the preview. */
const ShortcutsButtonPortal = ({ onOpen }: { onOpen: () => void }) => {
  useEffect(() => {
    const f = () => onOpen()
    window.addEventListener("weave:shortcuts", f)
    return () => window.removeEventListener("weave:shortcuts", f)
  }, [onOpen])
  return null
}

const Body = () => {
  const [split, setSplit] = useState(0.6)
  const [drag, setDrag] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!drag) return
    const move = (e: PointerEvent) => {
      const r = ref.current?.getBoundingClientRect()
      if (r) setSplit(Math.min(0.8, Math.max(0.3, (e.clientX - r.left) / r.width)))
    }
    const up = () => setDrag(false)
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", up)
    return () => {
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", up)
    }
  }, [drag])
  return (
    <div className="ebody" ref={ref}>
      <Preview style={{ width: `${split * 100}%` }} />
      <div
        className={`divider${drag ? " drag" : ""}`}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize panels"
        onPointerDown={(e) => {
          e.preventDefault()
          setDrag(true)
        }}
      />
      <TranscriptPanel style={{ width: `${(1 - split) * 100}%` }} />
    </div>
  )
}

const TitleInput = ({ id, title }: { id: string; title: string }) => {
  const [value, setValue] = useState(title)
  useEffect(() => setValue(title), [title])
  const save = () => {
    const v = value.trim()
    if (v && v !== title) updateRecording(id, (r) => ({ ...r, title: v }))
    else setValue(title)
  }
  return (
    <>
      <label className="sr" htmlFor="title">Title</label>
      <input
        id="title"
        className="titleinput"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur()
          if (e.key === "Escape") {
            setValue(title)
            e.currentTarget.blur()
          }
        }}
      />
    </>
  )
}

/** Deletes the selected words (or restores them if they're all cut), or deletes the selected clip. */
export const deleteSelection = (c: EditorContextValue) => {
  const sel = registry.get(selectionAtom(c.id))
  if (sel && c.words.length > 0) {
    applyEdit(c.id, (s) => ({ ...s, cuts: toggleWords(c.words, s.cuts, sel.anchor, sel.focus, c.recording.durationMs) }))
    return
  }
  const clip = registry.get(selectedClipAtom(c.id))
  if (clip) {
    applyEdit(c.id, (s) => ({ ...s, cuts: addCut(s.cuts, clip.startMs, clip.endMs, c.recording.durationMs) }))
    registry.set(selectedClipAtom(c.id), null)
  }
}

/** Mutes the selected clip, or unmutes it if it's muted. */
export const toggleMuteSelected = (c: EditorContextValue) => {
  const sel = registry.get(selectedClipAtom(c.id))
  if (!sel) return
  const clip = clips(c.cuts, c.splits, c.recording.durationMs, c.speeds, c.mutes).find((k) => k.startMs === sel.startMs && k.endMs === sel.endMs)
  if (!clip) return
  applyEdit(c.id, (s) => ({ ...s, mutes: setMuted(s.mutes, clip.startMs, clip.endMs, !clip.muted, c.recording.durationMs) }))
  // Muting next to a muted neighbor merges the two, so keep whichever clip now holds this one.
  const next = registry.get(editsAtom(c.id))
  if (!next) return
  const mid = (clip.startMs + clip.endMs) / 2
  const now = clips(next.cuts, next.splits, c.recording.durationMs, next.speeds, next.mutes).find((k) => mid >= k.startMs && mid < k.endMs)
  registry.set(selectedClipAtom(c.id), now ? { startMs: now.startMs, endMs: now.endMs } : null)
}

export const splitAtPlayhead = (c: EditorContextValue) => {
  const t = registry.get(playheadAtom(c.id))
  if (t <= 0 || t >= c.recording.durationMs) return
  applyEdit(c.id, (s) => ({ ...s, splits: addSplit(s.splits, Math.round(t)) }))
}

/** Restores the selected words. */
export const restoreSelection = (c: EditorContextValue) => {
  const sel = registry.get(selectionAtom(c.id))
  if (!sel) return
  const lo = Math.min(sel.anchor, sel.focus)
  const hi = Math.max(sel.anchor, sel.focus)
  if (c.words.slice(lo, hi + 1).every((w) => isWordCut(c.cuts, w))) deleteSelection(c)
}

export const editedLength = (c: EditorContextValue) => editedDuration(c.cuts, c.recording.durationMs, c.speed)

const SHORTCUTS: ReadonlyArray<[string, ReadonlyArray<string>]> = [
  ["Play from the start marker, or stop and go back to it", ["Space"]],
  ["Move the start marker to the beginning or end", ["Home", "End"]],
  ["Cut or restore selected words", ["Delete"]],
  ["Delete the selected clip", ["Delete"]],
  ["Split at the playhead", ["S"]],
  ["Mute or unmute the selected clip", ["M"]],
  ["Undo", ["Ctrl", "Z"]],
  ["Redo", ["Ctrl", "Shift", "Z"]],
  ["Zoom the timeline in or out", ["+", "−"]],
  ["Move the start marker back or ahead 5 seconds", ["←", "→"]],
  ["Select a range of words", ["Drag or Shift-click"]],
  ["Clear the selection", ["Esc"]],
  ["Show this list", ["?"]]
]

const ShortcutsDialog = ({ onClose }: { onClose: () => void }) => (
  <Dialog title="Keyboard shortcuts" onClose={onClose} testId="shortcuts">
    <div className="shortcuts">
      {SHORTCUTS.map(([what, keys]) => (
        <div key={what} style={{ display: "contents" }}>
          <span>{what}</span>
          <span style={{ display: "flex", gap: 4, justifyContent: "flex-end" }}>
            {keys.map((k) => <kbd key={k}>{k}</kbd>)}
          </span>
        </div>
      ))}
    </div>
    <p className="sub">On a Mac, use Cmd in place of Ctrl.</p>
  </Dialog>
)
