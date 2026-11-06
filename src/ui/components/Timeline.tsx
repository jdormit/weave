import { useAtomValue } from "@effect/atom-react"
import { useEffect, useMemo, useRef, useState } from "react"
import { clips as makeClips, editedDuration, editedToSource, sourceToEdited, totalCutMs, trimClip, type Clip } from "../../domain/editList.ts"
import { normalizeCuts } from "../../domain/editList.ts"
import { CLIP_SPEEDS, formatRate, isNormal, setSpeed } from "../../domain/speed.ts"
import { formatClock } from "../../domain/transcriptFormat.ts"
import { SpeedSelect } from "./SpeedSelect.tsx"
import { filmstrip, peaks, TRANSCRIBE_RATE } from "../../services/media.ts"
import { playheadAtom, selectedClipAtom, selectionAtom, useEditor, zoomAtom } from "../editorState.ts"
import { markerAtom, moveTo } from "../transport.ts"
import { Icon } from "../Icon.tsx"
import { deleteSelection, splitAtPlayhead } from "../screens/Editor.tsx"
import { applyEdit, registry } from "../state.ts"

const FRAME_H = 56
const MIN_CLIP_PX = 4

/** Thumbnails across the whole recording, made once per recording. */
const useFrames = (file: File | null, durationMs: number, aspect: number) => {
  const [frames, setFrames] = useState<Array<{ t: number; url: string | null }>>([])
  useEffect(() => {
    if (!file || durationMs <= 0) return
    let alive = true
    const count = Math.max(4, Math.min(60, Math.round(durationMs / 2000)))
    const times = Array.from({ length: count }, (_, i) => ((i + 0.5) * durationMs) / count)
    let made: Array<string | null> = []
    void filmstrip(file, times, FRAME_H).then((urls) => {
      made = urls
      if (alive) setFrames(times.map((t, i) => ({ t, url: urls[i] ?? null })))
    }, () => {})
    return () => {
      alive = false
      made.forEach((u) => u && URL.revokeObjectURL(u))
    }
  }, [file, durationMs])
  void aspect
  return frames
}

export const Timeline = () => {
  const c = useEditor()
  const zoom = useAtomValue(zoomAtom(c.id))
  const playhead = useAtomValue(playheadAtom(c.id))
  const selectedClip = useAtomValue(selectedClipAtom(c.id))
  const scrollRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(800)
  const duration = c.recording.durationMs
  const cuts = useMemo(() => normalizeCuts(c.cuts, duration), [c.cuts, duration])
  const speed = c.speed
  const edited = editedDuration(cuts, duration, speed)
  const aspect = c.recording.screen.width / Math.max(1, c.recording.screen.height) || 16 / 9
  const frames = useFrames(c.screenFile, duration, aspect)

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setWidth(el.clientWidth))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Ctrl or Cmd with the scroll wheel zooms.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      registry.update(zoomAtom(c.id), (z) => Math.max(1, Math.min(64, z * (e.deltaY < 0 ? 1.15 : 1 / 1.15))))
    }
    el.addEventListener("wheel", onWheel, { passive: false })
    return () => el.removeEventListener("wheel", onWheel)
  }, [c.id])

  const pxPerMs = (Math.max(200, width - 2) * zoom) / Math.max(1, edited)
  const innerWidth = Math.max(width, edited * pxPerMs)
  const clipList = useMemo(() => makeClips(cuts, c.splits, duration, c.speeds), [cuts, c.splits, duration, c.speeds])
  const selected = selectedClip ? clipList.find((k) => k.startMs === selectedClip.startMs && k.endMs === selectedClip.endMs) ?? null : null

  // Keep the playhead in view while playing.
  const playheadX = sourceToEdited(cuts, playhead, speed) * pxPerMs
  useEffect(() => {
    const el = scrollRef.current
    if (!el || zoom <= 1) return
    if (playheadX < el.scrollLeft || playheadX > el.scrollLeft + el.clientWidth - 40) el.scrollLeft = Math.max(0, playheadX - 80)
  }, [playheadX, zoom])

  /** Moves the start marker (and the playhead) to a point on the timeline. */
  const seekToX = (clientX: number) => {
    const el = scrollRef.current
    if (!el) return
    const x = clientX - el.getBoundingClientRect().left + el.scrollLeft
    // Snap to the very start, which is otherwise hard to hit at the edge.
    const editedMs = x < 6 ? 0 : Math.max(0, Math.min(edited, x / pxPerMs))
    moveTo(c, editedToSource(cuts, editedMs, speed))
  }

  /** Press and drag to scrub: the marker follows the pointer until it's released. */
  const startScrub = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    seekToX(e.clientX)
    const move = (ev: PointerEvent) => seekToX(ev.clientX)
    const up = () => {
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", up)
      window.removeEventListener("pointercancel", up)
    }
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", up)
    window.addEventListener("pointercancel", up)
  }
  const marker = useAtomValue(markerAtom(c.id))
  const markerX = sourceToEdited(cuts, marker, speed) * pxPerMs

  // Ruler ticks every "nice" interval.
  const ticks = useMemo(() => {
    const steps = [1000, 2000, 5000, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000, 600_000]
    const step = steps.find((s) => s * pxPerMs >= 80) ?? 600_000
    const out: Array<number> = []
    for (let t = 0; t <= edited; t += step) out.push(t)
    return out
  }, [pxPerMs, edited])

  const cutMs = totalCutMs(cuts)

  return (
    <section aria-label="Timeline" className="timeline" data-testid="timeline">
      <div className="tlbar">
        <button className="btn ghost" onClick={() => splitAtPlayhead(c)} data-testid="split">
          <Icon name="split" />Split <kbd>S</kbd>
        </button>
        <button
          className="btn ghost"
          disabled={!selectedClip}
          onClick={() => {
            registry.set(selectionAtom(c.id), null)
            deleteSelection(c)
          }}
          data-testid="delete-clip"
        >
          <Icon name="trash" />Delete clip <kbd>⌫</kbd>
        </button>
        <SpeedSelect
          label="Clip speed"
          value={selected?.rate ?? 1}
          options={CLIP_SPEEDS}
          disabled={!selected}
          testId="clip-speed"
          title={selected ? "Speed of the selected clip" : "Select a clip to change its speed"}
          onChange={(rate) => {
            if (!selected) return
            applyEdit(c.id, (s) => ({ ...s, speeds: setSpeed(s.speeds, selected.startMs, selected.endMs, rate) }))
          }}
        />
        <span className="vsep" />
        <button className="iconbtn" aria-label="Zoom out" disabled={zoom <= 1} onClick={() => registry.update(zoomAtom(c.id), (z) => Math.max(1, z / 1.5))}>
          <Icon name="minus" />
        </button>
        <button className="iconbtn" aria-label="Zoom in" onClick={() => registry.update(zoomAtom(c.id), (z) => Math.min(64, z * 1.5))}>
          <Icon name="plus" />
        </button>
        <div className="spacer" />
        <span className="tnum" style={{ fontSize: 13, color: "var(--muted)" }} data-testid="timeline-stats">
          {cutMs > 0
            ? `${formatClock(edited)} after ${isNormal(speed) ? "cuts" : "edits"} · ${formatClock(cutMs)} cut from ${formatClock(duration)}`
            : isNormal(speed) ? formatClock(duration) : `${formatClock(edited)} after speed changes · ${formatClock(duration)} recorded`}
        </span>
      </div>
      <div className="tlscroll" ref={scrollRef}>
        <div className="tlinner" style={{ width: innerWidth }}>
          <div className="ruler tnum" onPointerDown={startScrub} data-testid="ruler">
            <div className="marker" style={{ left: markerX }} data-testid="marker" data-ms={Math.round(marker)} title="Start marker" />
            {ticks.map((t) => <span key={t} style={{ left: t * pxPerMs }}>{formatClock(t)}</span>)}
          </div>
          <div
            className="track"
            onPointerDown={(e) => {
              if (e.target === e.currentTarget) {
                registry.set(selectedClipAtom(c.id), null)
                startScrub(e)
              }
            }}
          >
            {clipList.map((clip) => (
              <ClipView
                key={`${clip.startMs}-${clip.endMs}`}
                clip={clip}
                left={sourceToEdited(cuts, clip.startMs, speed) * pxPerMs}
                width={Math.max(MIN_CLIP_PX, ((clip.endMs - clip.startMs) / (clip.rate * speed.global)) * pxPerMs)}
                pxPerMs={pxPerMs / (clip.rate * speed.global)}
                frames={frames}
                selected={!!selectedClip && selectedClip.startMs === clip.startMs && selectedClip.endMs === clip.endMs}
                onSelect={(clientX) => {
                  registry.set(selectionAtom(c.id), null)
                  registry.set(selectedClipAtom(c.id), { startMs: clip.startMs, endMs: clip.endMs })
                  seekToX(clientX)
                }}
              />
            ))}
            {cuts.map((cut) => (
              <span
                key={`${cut.startMs}`}
                className="cutmark"
                data-testid="cutmark"
                style={{ left: sourceToEdited(cuts, cut.startMs, speed) * pxPerMs }}
                title={`Cut: ${formatClock(cut.endMs - cut.startMs)}`}
              />
            ))}
          </div>
          <div className="playhead" style={{ left: playheadX }} data-testid="playhead">
            <span className="grab" onPointerDown={startScrub} aria-hidden="true" />
          </div>
        </div>
      </div>
    </section>
  )
}

const ClipView = ({
  clip,
  left,
  width,
  pxPerMs,
  frames,
  selected,
  onSelect
}: {
  clip: Clip
  left: number
  width: number
  /** Pixels per millisecond of this clip's source, which is narrower where it's sped up. */
  pxPerMs: number
  frames: ReadonlyArray<{ t: number; url: string | null }>
  selected: boolean
  onSelect: (clientX: number) => void
}) => {
  const c = useEditor()
  const [dragPx, setDragPx] = useState<{ edge: "start" | "end"; px: number } | null>(null)

  const frameW = Math.round(FRAME_H * (c.recording.screen.width / Math.max(1, c.recording.screen.height) || 16 / 9))
  const tiles = useMemo(() => {
    if (frames.length === 0) return []
    const n = Math.max(1, Math.ceil(width / (frameW + 2)))
    return Array.from({ length: n }, (_, j) => {
      const t = clip.startMs + (j * (frameW + 2)) / pxPerMs
      let best = frames[0]!
      for (const f of frames) if (Math.abs(f.t - t) < Math.abs(best.t - t)) best = f
      return best.url
    })
  }, [frames, width, frameW, pxPerMs, clip.startMs])

  const wave = useMemo(() => {
    if (!c.audio) return ""
    const a = Math.floor((clip.startMs / 1000) * TRANSCRIBE_RATE)
    const b = Math.min(c.audio.length, Math.ceil((clip.endMs / 1000) * TRANSCRIBE_RATE))
    const buckets = Math.max(1, Math.min(2000, Math.floor(width / 3)))
    const p = peaks(c.audio.subarray(a, Math.max(a, b)), buckets)
    let d = ""
    for (let i = 0; i < buckets; i++) {
      const x = ((i + 0.5) * 100) / buckets
      const h = Math.max(0.8, p[i]! * 18)
      d += `M${x.toFixed(2)} ${(20 - h).toFixed(1)}V${(20 + h).toFixed(1)}`
    }
    return d
  }, [c.audio, clip.startMs, clip.endMs, width])

  const startTrim = (e: React.PointerEvent, edge: "start" | "end") => {
    e.preventDefault()
    e.stopPropagation()
    const startX = e.clientX
    let px = 0
    const move = (ev: PointerEvent) => {
      px = ev.clientX - startX
      setDragPx({ edge, px })
    }
    const up = () => {
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", up)
      setDragPx(null)
      const deltaMs = px / pxPerMs
      if (Math.abs(deltaMs) < 1) return
      const target = edge === "start" ? clip.startMs + deltaMs : clip.endMs + deltaMs
      const bounded = boundTrim(c.cuts, c.splits, clip, edge, target, c.recording.durationMs)
      // Part brought back by moving an edge outward gets the clip's speed.
      const grown = edge === "start" ? (bounded < clip.startMs ? [bounded, clip.startMs] : null) : (bounded > clip.endMs ? [clip.endMs, bounded] : null)
      applyEdit(c.id, (s) => ({
        ...s,
        cuts: trimClip(s.cuts, clip, edge, bounded, c.recording.durationMs),
        speeds: grown && clip.rate !== 1 ? setSpeed(s.speeds, grown[0]!, grown[1]!, clip.rate) : s.speeds
      }))
      registry.set(selectedClipAtom(c.id), null)
    }
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", up)
  }

  const shiftL = dragPx?.edge === "start" ? dragPx.px : 0
  const shiftR = dragPx?.edge === "end" ? dragPx.px : 0
  return (
    <div
      className={`clip${selected ? " on" : ""}`}
      data-testid="clip"
      data-start={clip.startMs}
      data-end={clip.endMs}
      data-rate={clip.rate}
      style={{ left: left + shiftL, width: Math.max(MIN_CLIP_PX, width - shiftL + shiftR) }}
      onMouseDown={(e) => {
        if (e.button === 0) onSelect(e.clientX)
      }}
    >
      {clip.rate !== 1 && <span className="rate" data-testid="clip-rate">{formatRate(clip.rate)}</span>}
      <div className="film" aria-hidden="true">
        {tiles.map((u, j) => (u ? <img key={j} src={u} alt="" style={{ width: frameW }} /> : <i key={j} style={{ width: frameW }} />))}
      </div>
      <svg className="wave" viewBox="0 0 100 40" preserveAspectRatio="none" aria-hidden="true">
        <path d={wave} style={{ stroke: selected ? "var(--accent)" : "var(--muted)", strokeWidth: 2, vectorEffect: "non-scaling-stroke", strokeLinecap: "round" }} />
      </svg>
      {selected && (
        <>
          <span className="trim l" data-testid="trim-start" onPointerDown={(e) => startTrim(e, "start")} aria-hidden="true"><i /></span>
          <span className="trim r" data-testid="trim-end" onPointerDown={(e) => startTrim(e, "end")} aria-hidden="true"><i /></span>
        </>
      )}
    </div>
  )
}

/**
 * Limits a trim so an edge can't pass the other edge of its clip, and can only
 * move outward into a neighboring cut, not into a neighboring clip.
 */
const boundTrim = (
  cuts: ReadonlyArray<{ startMs: number; endMs: number }>,
  splits: ReadonlyArray<number>,
  clip: Clip,
  edge: "start" | "end",
  target: number,
  durationMs: number
) => {
  const MIN = 100
  if (edge === "start") {
    const before = cuts.find((c) => Math.abs(c.endMs - clip.startMs) < 1)
    const min = before ? before.startMs : Math.max(0, ...splits.filter((s) => s <= clip.startMs), clip.startMs === 0 ? 0 : clip.startMs)
    return Math.max(min, Math.min(clip.endMs - MIN, target))
  }
  const after = cuts.find((c) => Math.abs(c.startMs - clip.endMs) < 1)
  const max = after ? after.endMs : clip.endMs >= durationMs ? durationMs : clip.endMs
  return Math.min(max, Math.max(clip.startMs + MIN, target))
}
