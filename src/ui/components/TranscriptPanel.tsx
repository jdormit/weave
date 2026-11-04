import { useAtomValue } from "@effect/atom-react"
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react"
import { isWordCut, sourceToEdited } from "../../domain/editList.ts"
import type { Word } from "../../domain/schema.ts"
import { formatClock, paragraphs } from "../../domain/transcriptFormat.ts"
import { modelInfo } from "../../workers/transcribeProtocol.ts"
import { playheadAtom, selectionAtom, selectedClipAtom, useEditor } from "../editorState.ts"
import { moveTo } from "../transport.ts"
import { Icon } from "../Icon.tsx"
import { deleteSelection } from "../screens/Editor.tsx"
import { jobAtom, registry, settingsAtom, startTranscription, updateSettings } from "../state.ts"
import { formatBytes } from "../format.ts"

const LANGUAGE_NAMES: Record<string, string> = {}
const languageName = (code: string) => {
  if (!code || code === "auto") return "language detected automatically"
  if (LANGUAGE_NAMES[code]) return LANGUAGE_NAMES[code]!
  try {
    return (LANGUAGE_NAMES[code] = new Intl.DisplayNames(["en"], { type: "language" }).of(code) ?? code)
  } catch {
    return code
  }
}

export const TranscriptPanel = ({ style }: { style?: CSSProperties }) => {
  const c = useEditor()
  const settings = useAtomValue(settingsAtom)
  const job = useAtomValue(jobAtom(c.id))
  const running = job.stage === "download" || job.stage === "transcribe"
  const showCut = settings.showCutWords
  return (
    <section aria-label="Transcript" className="tpanel" style={style}>
      <div className="thead">
        <h2>Transcript</h2>
        {c.transcript && (
          <span style={{ fontSize: 13, color: "var(--muted)" }}>
            {modelInfo(c.transcript.modelId as never).name} model · {languageName(c.transcript.language)}
          </span>
        )}
        <div className="spacer" />
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--muted)" }}>
          Show cut words
          <button
            className="switch"
            role="switch"
            aria-checked={showCut}
            aria-label="Show cut words"
            onClick={() => updateSettings((s) => ({ ...s, showCutWords: !s.showCutWords }))}
          />
        </label>
      </div>
      <div className="tbody" data-testid="transcript">
        {running && <Progress />}
        {!running && !c.transcript && c.words.length === 0 && <NotTranscribed />}
        <Words showCut={showCut} />
        {running && (
          <div style={{ marginLeft: 60, paddingTop: 6 }} aria-hidden="true">
            <div className="skel" style={{ width: "92%" }} />
            <div className="skel" style={{ width: "84%" }} />
            <div className="skel" style={{ width: "60%" }} />
          </div>
        )}
      </div>
    </section>
  )
}

const Progress = () => {
  const c = useEditor()
  const job = useAtomValue(jobAtom(c.id))
  const pct = job.stage === "download"
    ? (job.total ? job.loaded / job.total : 0)
    : (job.chunks ? job.done / job.chunks : 0)
  return (
    <div className="tprog" data-testid="transcription-progress">
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 8, gap: 12 }}>
        <b style={{ fontWeight: 550 }}>{job.stage === "download" ? "Downloading the transcription model" : "Transcribing on your device"}</b>
        <span className="tnum muted">
          {job.stage === "download"
            ? `${formatBytes(job.loaded)} of ${formatBytes(job.total)}`
            : job.chunks
              ? `${job.done} of ${job.chunks} sections`
              : "Starting…"}
        </span>
      </div>
      <div className="bar"><div style={{ width: `${Math.round(pct * 100)}%` }} /></div>
      <p style={{ margin: "8px 0 0", fontSize: 12, color: "var(--muted)" }}>You can watch and cut on the timeline while this runs.</p>
    </div>
  )
}

const NotTranscribed = () => {
  const c = useEditor()
  const job = useAtomValue(jobAtom(c.id))
  const failed = job.stage === "error" || c.recording.transcriptStatus === "error"
  return (
    <div style={{ margin: "0 0 24px 60px", padding: 16, border: "1px solid var(--line)", borderRadius: 10, background: "var(--bg)" }}>
      <p style={{ margin: "0 0 12px", fontSize: 14, lineHeight: 1.5 }}>
        {failed
          ? (job.error ?? "Transcription failed.")
          : c.recording.hasAudio
            ? "This recording isn't transcribed yet."
            : "This recording has no sound to transcribe."}
      </p>
      {c.recording.hasAudio && (
        <button className="btn" onClick={() => startTranscription(c.id)}>
          {failed ? "Try again" : "Transcribe"}
        </button>
      )}
    </div>
  )
}

/** The transcript, in paragraphs. Click a word to seek; drag or Shift-click to select. */
const Words = ({ showCut }: { showCut: boolean }) => {
  const c = useEditor()
  const selection = useAtomValue(selectionAtom(c.id))
  const playhead = useAtomValue(playheadAtom(c.id))
  const paras = useMemo(() => paragraphs(c.words), [c.words])
  const cutFlags = useMemo(() => c.words.map((w) => isWordCut(c.cuts, w)), [c.words, c.cuts])
  const drag = useRef<{ anchor: number; moved: boolean } | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const clickedRef = useRef<number | null>(null)

  // The word being spoken.
  const nowIndex = useMemo(() => {
    let lo = 0
    let hi = c.words.length - 1
    let found = -1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (c.words[mid]!.startMs <= playhead) {
        found = mid
        lo = mid + 1
      } else hi = mid - 1
    }
    if (found >= 0 && playhead <= c.words[found]!.endMs + 250) return found
    return -1
  }, [c.words, playhead])

  useEffect(() => {
    const up = () => {
      const d = drag.current
      drag.current = null
      if (d && !d.moved) {
        // A plain click seeks to the word.
        registry.set(selectionAtom(c.id), null)
        clickedRef.current = d.anchor
        const w = c.words[d.anchor]
        if (w) moveTo(c, w.startMs)
      }
    }
    window.addEventListener("mouseup", up)
    return () => window.removeEventListener("mouseup", up)
  }, [c])

  const onDown = useCallback((i: number, e: React.MouseEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    registry.set(selectedClipAtom(c.id), null)
    const sel = registry.get(selectionAtom(c.id))
    if (e.shiftKey) {
      // Shift-click extends from the selection, else the last clicked word, else the word being spoken.
      const anchor = sel?.anchor ?? clickedRef.current ?? nowIndexRef.current ?? i
      registry.set(selectionAtom(c.id), { anchor: anchor < 0 ? i : anchor, focus: i })
      drag.current = { anchor: anchor < 0 ? i : anchor, moved: true }
      return
    }
    drag.current = { anchor: i, moved: false }
  }, [c.id])
  const onEnter = useCallback((i: number) => {
    const d = drag.current
    if (!d) return
    if (i !== d.anchor || d.moved) {
      d.moved = true
      registry.set(selectionAtom(c.id), { anchor: d.anchor, focus: i })
    }
  }, [c.id])
  const onDouble = useCallback((i: number) => registry.set(selectionAtom(c.id), { anchor: i, focus: i }), [c.id])
  const nowIndexRef = useRef(nowIndex)
  nowIndexRef.current = nowIndex

  const lo = selection ? Math.min(selection.anchor, selection.focus) : -1
  const hi = selection ? Math.max(selection.anchor, selection.focus) : -1

  return (
    <div ref={containerRef} style={{ position: "relative" }}>
      {selection && <SelectionBar container={containerRef} lo={lo} hi={hi} cutFlags={cutFlags} />}
      {paras.map((p) => {
        const visible = p.words.some((_, j) => showCut || !cutFlags[p.firstIndex + j])
        if (!visible) return null
        return (
          <div className="para" key={p.firstIndex}>
            <button className="ts tnum" onClick={() => moveTo(c, p.startMs)}>
              {formatClock(sourceToEdited(c.cuts, p.startMs))}
            </button>
            <p className="tx">
              {p.words.map((w, j) => {
                const i = p.firstIndex + j
                const cut = cutFlags[i]!
                if (cut && !showCut) return null
                return (
                  <WordSpan
                    key={w.id}
                    word={w}
                    index={i}
                    cut={cut}
                    now={i === nowIndex}
                    selected={i >= lo && i <= hi}
                    onDown={onDown}
                    onEnter={onEnter}
                    onDouble={onDouble}
                  />
                )
              })}
            </p>
          </div>
        )
      })}
    </div>
  )
}

const WordSpan = memo(({
  word,
  index,
  cut,
  now,
  selected,
  onDown,
  onEnter,
  onDouble
}: {
  word: Word
  index: number
  cut: boolean
  now: boolean
  selected: boolean
  onDown: (i: number, e: React.MouseEvent) => void
  onEnter: (i: number) => void
  onDouble: (i: number) => void
}) => {
  const lead = word.text.match(/^\s*/)?.[0] ?? ""
  return (
    <>
      {lead}
      <span
        className={`w${cut ? " cut" : ""}${now ? " now" : ""}${selected ? " picked" : ""}`}
        data-index={index}
        data-start={word.startMs}
        data-end={word.endMs}
        data-cut={cut ? "true" : "false"}
        onMouseDown={(e) => onDown(index, e)}
        onMouseEnter={() => onEnter(index)}
        onDoubleClick={() => onDouble(index)}
      >
        {word.text.trim()}
      </span>
    </>
  )
})

const SelectionBar = ({
  container,
  lo,
  hi,
  cutFlags
}: {
  container: React.RefObject<HTMLDivElement | null>
  lo: number
  hi: number
  cutFlags: ReadonlyArray<boolean>
}) => {
  const c = useEditor()
  const [pos, setPos] = useState<{ left: number; top: number; transform: string } | null>(null)
  useLayoutEffect(() => {
    const root = container.current
    const first = root?.querySelector<HTMLElement>(`[data-index="${lo}"]`)
    if (!root || !first) return setPos(null)
    const r = root.getBoundingClientRect()
    const f = first.getBoundingClientRect()
    // Above the first word, or below it when there is no room above.
    const scroller = root.parentElement?.getBoundingClientRect()
    const roomAbove = f.top - (scroller?.top ?? r.top)
    setPos(
      roomAbove > 48
        ? { left: Math.max(0, f.left - r.left - 2), top: f.top - r.top - 8, transform: "translateY(-100%)" }
        : { left: Math.max(0, f.left - r.left - 2), top: f.bottom - r.top + 8, transform: "none" }
    )
  }, [lo, hi, c.words, c.cuts, container])
  if (!pos) return null
  const allCut = cutFlags.slice(lo, hi + 1).every(Boolean)
  const playSelection = () => {
    const a = c.words[lo]
    const b = c.words[hi]
    if (a && b) c.player.current?.playRange(a.startMs, b.endMs)
  }
  return (
    <div className="selbar" role="toolbar" aria-label="Selection" style={pos} data-testid="selection-bar" onMouseDown={(e) => e.stopPropagation()}>
      <button onClick={() => deleteSelection(c)}>
        {allCut ? <>Restore</> : <>Cut <kbd>⌫</kbd></>}
      </button>
      {!allCut && <button onClick={playSelection}>Play selection</button>}
      <button aria-label="Clear selection" onClick={() => registry.set(selectionAtom(c.id), null)}>
        <Icon name="close" size={14} />
      </button>
    </div>
  )
}
