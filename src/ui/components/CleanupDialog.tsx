import { useMemo, useState } from "react"
import { applyCleanup, DEFAULT_MIN_PAUSE_MS, fillerCounts, findFillers, findPauses, SHORTENED_PAUSE_MS } from "../../domain/cleanup.ts"
import { editedDuration } from "../../domain/editList.ts"
import { formatClock } from "../../domain/transcriptFormat.ts"
import { TRANSCRIBE_RATE } from "../../services/media.ts"
import { useEditor } from "../editorState.ts"
import { applyEdit } from "../state.ts"
import { Dialog } from "./Dialog.tsx"

/** Shorten long pauses and remove filler words. Shows what each will do before applying, and undoes as one step. */
export const CleanupDialog = ({ onClose }: { onClose: () => void }) => {
  const c = useEditor()
  const [pausesOn, setPausesOn] = useState(true)
  const [fillersOn, setFillersOn] = useState(true)
  const [minPauseSec, setMinPauseSec] = useState(DEFAULT_MIN_PAUSE_MS / 1000)
  const duration = c.recording.durationMs
  const audio = useMemo(() => (c.audio ? { sampleRate: TRANSCRIBE_RATE, samples: c.audio } : undefined), [c.audio])
  const pauses = useMemo(
    () => findPauses(c.words, c.cuts, duration, Math.max(0.6, minPauseSec) * 1000, audio),
    [c.words, c.cuts, duration, minPauseSec, audio]
  )
  const fillers = useMemo(() => findFillers(c.words, c.cuts), [c.words, c.cuts])
  const plannedPauses = pausesOn ? pauses : []
  const plannedFillers = fillersOn ? fillers.map((f) => f.cut) : []
  const next = applyCleanup(c.cuts, [...plannedPauses, ...plannedFillers], duration)
  const before = editedDuration(c.cuts, duration)
  const after = editedDuration(next, duration)
  const savedPauses = editedDuration(c.cuts, duration) - editedDuration(applyCleanup(c.cuts, pauses, duration), duration)
  const savedFillers = editedDuration(c.cuts, duration) - editedDuration(applyCleanup(c.cuts, fillers.map((f) => f.cut), duration), duration)
  const count = plannedPauses.length + plannedFillers.length

  const apply = () => {
    applyEdit(c.id, (s) => ({ ...s, cuts: next }))
    onClose()
  }

  return (
    <Dialog
      title="Clean up"
      subtitle="These become ordinary cuts. Undo removes all of them in one step, or you can restore any one later."
      onClose={onClose}
      testId="cleanup"
    >
      <label className="opt">
        <input type="checkbox" checked={pausesOn} onChange={(e) => setPausesOn(e.target.checked)} data-testid="cleanup-pauses" />
        <span className="t">Shorten long pauses</span>
        <span className="n tnum" data-testid="cleanup-pauses-count">
          {pauses.length} pause{pauses.length === 1 ? "" : "s"} · saves {formatClock(savedPauses)}
        </span>
        <span className="d">
          Pauses longer than
          <input
            className="num tnum"
            type="number"
            value={minPauseSec}
            step={0.5}
            min={1}
            aria-label="Minimum pause in seconds"
            onChange={(e) => setMinPauseSec(Number(e.target.value) || 1)}
          />
          seconds are shortened to {SHORTENED_PAUSE_MS / 1000} seconds.
        </span>
      </label>
      <label className="opt">
        <input type="checkbox" checked={fillersOn} onChange={(e) => setFillersOn(e.target.checked)} data-testid="cleanup-fillers" />
        <span className="t">Remove filler words</span>
        <span className="n tnum">{fillers.length} word{fillers.length === 1 ? "" : "s"} · saves {formatClock(savedFillers)}</span>
        <span className="d">
          {fillerCounts(fillers).map(([w, n]) => <span key={w} className="chip">{w} ×{n}</span>)}
          {fillers.length > 0 && <br />}
          Best effort: Whisper often leaves filler words out of the transcript, so some won't be found.
        </span>
      </label>
      <div style={{ display: "flex", alignItems: "center", gap: 8, paddingTop: 4 }}>
        <span className="tnum" style={{ flex: 1, fontSize: 13, color: "var(--muted)" }}>
          {formatClock(before)} becomes <b style={{ color: "var(--ink)", fontWeight: 550 }}>{formatClock(after)}</b>
        </span>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={count === 0} onClick={apply} data-testid="cleanup-apply">
          Apply {count} cut{count === 1 ? "" : "s"}
        </button>
      </div>
    </Dialog>
  )
}
