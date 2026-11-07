import { useAtomValue } from "@effect/atom-react"
import { Effect } from "effect"
import { useEffect, useRef, useState, type CSSProperties } from "react"
import { editedDuration, sourceToEdited } from "../../domain/editList.ts"
import type { BlurStrength, Overlay } from "../../domain/schema.ts"
import { formatClock } from "../../domain/transcriptFormat.ts"
import { Player } from "../../services/Player.ts"
import { run } from "../../services/runtime.ts"
import { overlayRect } from "../../workers/exportProtocol.ts"
import { playheadAtom, playingAtom, takeAtom, useEditor, type Take } from "../editorState.ts"
import { cancelTake, stopTake } from "../retake.ts"
import { jumpToEnd, jumpToStart, markerAtom, moveBy, returnToMarker, togglePlay } from "../transport.ts"
import { Icon } from "../Icon.tsx"
import { BlurredVideo } from "./BlurredVideo.tsx"
import { SpeedSelect } from "./SpeedSelect.tsx"
import { GLOBAL_SPEEDS } from "../../domain/speed.ts"
import { applyEdit, registry, updateRecording } from "../state.ts"

export const Preview = ({ style }: { style?: CSSProperties }) => {
  const c = useEditor()
  const screenRef = useRef<HTMLVideoElement>(null)
  const cameraRef = useRef<HTMLVideoElement>(null)
  const voiceRef = useRef<HTMLAudioElement>(null)
  const liveRef = useRef<HTMLVideoElement>(null)
  const take = useAtomValue(takeAtom(c.id))
  const inTake = take !== null
  const [cameraActive, setCameraActive] = useState(true)
  const stageWrapRef = useRef<HTMLDivElement>(null)
  const playing = useAtomValue(playingAtom(c.id))
  const playhead = useAtomValue(playheadAtom(c.id))
  const [box, setBox] = useState({ w: 0, h: 0 })
  const aspect = c.recording.screen.width > 0 ? c.recording.screen.width / c.recording.screen.height : 16 / 9

  // Fit the stage inside the available space at the video's aspect ratio.
  useEffect(() => {
    const el = stageWrapRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect()
      const w = Math.min(r.width, r.height * aspect)
      setBox({ w, h: w / aspect })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [aspect])

  // Attach the player once both videos exist. While a take records, the old camera is left out.
  const cameraKind = inTake || !c.cameraUrl ? null : c.recording.hasCamera ? "video" : c.recording.cameraAudio ? "audio" : null
  useEffect(() => {
    const screen = screenRef.current
    if (!screen || !c.screenUrl) return
    let destroyed = false
    let ctl: Awaited<ReturnType<typeof attach>> | null = null
    const attach = () =>
      run(Effect.gen(function*() {
        const camera = cameraKind === "video" ? cameraRef.current : cameraKind === "audio" ? voiceRef.current : null
        return yield* (yield* Player).attach(screen, camera, {
          cuts: c.cuts,
          speed: c.speed,
          mutes: c.mutes,
          timing: c.recording,
          durationMs: c.recording.durationMs
        })
      }))
    void attach().then((p) => {
      if (destroyed) return p.destroy()
      ctl = p
      c.player.current = p
      p.onTime((t) => registry.set(playheadAtom(c.id), t))
      p.onCameraActive(setCameraActive)
      p.onPlayingChange((v) => {
        registry.set(playingAtom(c.id), v)
        // Like a DAW: when playback stops, the playhead goes back to the start marker.
        if (!v) returnToMarker(c)
      })
      p.seek(registry.get(markerAtom(c.id)))
    })
    return () => {
      destroyed = true
      ctl?.destroy()
      if (c.player.current === ctl) c.player.current = null
    }
  }, [c.screenUrl, c.cameraUrl, cameraKind, c.recording.cameraSegments, c.recording.cameraOffsetMs])

  // The screen's own sound plays unless it was muted, or a take is recording without it.
  const screenMuted = take ? !take.keepScreenAudio : c.recording.screenAudioMuted
  useEffect(() => {
    if (screenRef.current) screenRef.current.muted = screenMuted
  }, [screenMuted, c.screenUrl])

  // The live camera while a take records.
  useEffect(() => {
    if (liveRef.current) liveRef.current.srcObject = take?.camera ?? null
  }, [take?.camera])

  // Keep the player's cuts, speeds and mutes current.
  useEffect(() => {
    c.player.current?.setCuts(c.cuts)
  }, [c.cuts, c.player.current])
  useEffect(() => {
    c.player.current?.setSpeed(c.speed)
  }, [c.speed, c.player.current])
  useEffect(() => {
    c.player.current?.setMutes(c.mutes)
  }, [c.mutes, c.player.current])

  const total = editedDuration(c.cuts, c.recording.durationMs, c.speed)
  const now = Math.min(total, sourceToEdited(c.cuts, playhead, c.speed))

  return (
    <section aria-label="Preview" className="preview" style={style}>
      <div className="stage-wrap" ref={stageWrapRef}>
        <div className="stage" style={{ width: box.w, height: box.h }} data-testid="stage">
          {c.screenUrl && (
            <video
              ref={screenRef}
              className="screen"
              src={c.screenUrl}
              preload="auto"
              playsInline
              data-testid="screen-video"
              onClick={() => !inTake && togglePlay(c)}
            />
          )}
          {cameraKind === "video" && (
            <Bubble overlay={c.recording.overlay} stage={box} aspect={aspect} hidden={!cameraActive}>
              <BlurredVideo videoRef={cameraRef} blur={blurOf(c.recording.overlay)}>
                <video
                  ref={cameraRef}
                  src={c.cameraUrl!}
                  muted={!c.recording.cameraAudio}
                  playsInline
                  preload="auto"
                  data-testid="camera-video"
                />
              </BlurredVideo>
            </Bubble>
          )}
          {cameraKind === "audio" && <audio ref={voiceRef} src={c.cameraUrl!} preload="auto" data-testid="voiceover-audio" />}
          {take?.camera && (
            <Bubble overlay={{ ...c.recording.overlay, visible: true }} stage={box} aspect={aspect}>
              <BlurredVideo videoRef={liveRef} blur={blurOf(c.recording.overlay)}>
                <video ref={liveRef} autoPlay muted playsInline data-testid="live-camera" />
              </BlurredVideo>
            </Bubble>
          )}
          {take?.phase === "countdown" && (
            <div className="take-countdown" data-testid="take-countdown"><div className="countdown">{take.count}</div></div>
          )}
        </div>
      </div>
      {take ? <TakeBar take={take} now={now} total={total} /> : <div className="transport">
        <div className="transport-btns" role="group" aria-label="Playback">
          <button className="iconbtn" aria-label="Jump to start" title="Jump to start (Home)" onClick={() => jumpToStart(c)}>
            <Icon name="toStart" />
          </button>
          <button className="iconbtn" aria-label="Back 5 seconds" title="Back 5 seconds (←)" onClick={() => moveBy(c, -5000)}>
            <Icon name="back5" />
          </button>
          <button
            className="iconbtn playbtn"
            aria-label={playing ? "Stop" : "Play"}
            title={playing ? "Stop and go back to the start marker (Space)" : "Play from the start marker (Space)"}
            onClick={() => togglePlay(c)}
          >
            <Icon name={playing ? "stop" : "play"} />
          </button>
          <button className="iconbtn" aria-label="Forward 5 seconds" title="Forward 5 seconds (→)" onClick={() => moveBy(c, 5000)}>
            <Icon name="fwd5" />
          </button>
          <button className="iconbtn" aria-label="Jump to end" title="Jump to end (End)" onClick={() => jumpToEnd(c)}>
            <Icon name="toEnd" />
          </button>
        </div>
        <span className="tnum" style={{ fontSize: 14, fontWeight: 550 }} data-testid="time">
          <span data-testid="time-now" data-ms={Math.round(now)}>{formatClock(now)}</span>{" "}
          <span style={{ color: "var(--muted)", fontWeight: 400 }}>/ <span data-testid="time-total" data-ms={Math.round(total)}>{formatClock(total)}</span></span>
        </span>
        <SpeedSelect
          label="Speed"
          value={c.speed.global}
          options={GLOBAL_SPEEDS}
          testId="global-speed"
          title="Speed of the whole video. Each clip's own speed is multiplied by it."
          onChange={(rate) => applyEdit(c.id, (s) => ({ ...s, speed: rate }))}
        />
        {cameraKind === "video" && !c.recording.overlay.visible && (
          <button className="btn ghost" onClick={() => updateRecording(c.id, (r) => ({ ...r, overlay: { ...r.overlay, visible: true } }))}>
            <Icon name="camera" />Show camera
          </button>
        )}
        <div className="spacer" />
        <button className="btn ghost" style={{ fontSize: 13 }} onClick={() => window.dispatchEvent(new Event("weave:shortcuts"))}>
          Shortcuts <kbd>?</kbd>
        </button>
      </div>}
    </section>
  )
}

/** Shown in place of the playback buttons while a take records. */
const TakeBar = ({ take, now, total }: { take: Take; now: number; total: number }) => {
  const c = useEditor()
  return (
    <div className="transport" data-testid="take-bar" data-phase={take.phase}>
      <span className="rec" aria-hidden="true" />
      <b style={{ fontWeight: 550, fontSize: 14 }}>
        {take.phase === "countdown" ? "Get ready…" : take.phase === "recording" ? "Recording camera and voice" : "Saving…"}
      </b>
      <span className="tnum" style={{ fontSize: 14 }}>
        {formatClock(now)} <span style={{ color: "var(--muted)" }}>/ {formatClock(total)}</span>
      </span>
      <div className="spacer" />
      {take.phase !== "saving" && (
        <>
          <button className="btn ghost" onClick={() => void cancelTake(c.id)}>Cancel</button>
          <button className="btn primary" onClick={() => void stopTake(c.id)} disabled={take.phase !== "recording"}>
            <Icon name="stop" />Stop and save
          </button>
        </>
      )}
    </div>
  )
}

/** The blur to show for an overlay, or null for none. */
const blurOf = (o: Overlay) => (o.blur ? o.blurStrength : null)

const BLUR_CHOICES: ReadonlyArray<readonly [string, boolean, BlurStrength]> = [
  ["No blur", false, "strong"],
  ["Light blur", true, "light"],
  ["Strong blur", true, "strong"]
]

const MIN_SIZE = 0.1
const MAX_SIZE = 0.8

/** The camera overlay. Drag to move, drag a corner to resize, and pick a shape or hide it. */
const Bubble = ({
  overlay,
  stage,
  aspect,
  hidden,
  children
}: {
  overlay: Overlay
  stage: { w: number; h: number }
  aspect: number
  /** Hidden where the camera has nothing to show at the playhead. */
  hidden?: boolean
  children: React.ReactNode
}) => {
  const c = useEditor()
  const [draft, setDraft] = useState<Overlay | null>(null)
  const [selected, setSelected] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const o = draft ?? overlay
  const rect = overlayRect(o, stage.w || 1, stage.h || 1)

  useEffect(() => {
    if (!selected) return
    const off = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setSelected(false)
    }
    window.addEventListener("pointerdown", off)
    return () => window.removeEventListener("pointerdown", off)
  }, [selected])

  const save = (next: Overlay) => {
    setDraft(null)
    updateRecording(c.id, (r) => ({ ...r, overlay: next }))
  }

  const startDrag = (e: React.PointerEvent, mode: "move" | "nw" | "ne" | "sw" | "se") => {
    e.preventDefault()
    e.stopPropagation()
    setSelected(true)
    const startX = e.clientX
    const startY = e.clientY
    const base = overlay
    const baseRect = overlayRect(base, stage.w, stage.h)
    const widthPerHeight = base.shape === "circle" ? 1 : 4 / 3
    let latest = base
    let moved = false
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - startX
      const dy = ev.clientY - startY
      if (Math.abs(dx) + Math.abs(dy) > 2) moved = true
      if (mode === "move") {
        latest = {
          ...base,
          x: Math.max(0, Math.min(1 - baseRect.w / stage.w, (baseRect.x + dx) / stage.w)),
          y: Math.max(0, Math.min(1 - baseRect.h / stage.h, (baseRect.y + dy) / stage.h))
        }
      } else {
        // Resize from a corner, keeping the opposite corner in place.
        const sx = mode === "ne" || mode === "se" ? 1 : -1
        const sy = mode === "sw" || mode === "se" ? 1 : -1
        const growH = Math.max(sx * dx / widthPerHeight, sy * dy)
        const h = Math.max(MIN_SIZE, Math.min(MAX_SIZE, (baseRect.h + growH) / stage.h)) * stage.h
        const w = h * widthPerHeight
        const x = sx > 0 ? baseRect.x : baseRect.x + baseRect.w - w
        const y = sy > 0 ? baseRect.y : baseRect.y + baseRect.h - h
        latest = {
          ...base,
          size: h / stage.h,
          x: Math.max(0, Math.min(1 - w / stage.w, x / stage.w)),
          y: Math.max(0, Math.min(1 - h / stage.h, y / stage.h))
        }
      }
      setDraft(latest)
    }
    const up = () => {
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", up)
      if (moved) save(latest)
      else setDraft(null)
    }
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", up)
  }

  void aspect
  return (
    <div
      ref={ref}
      className="bubble"
      data-testid="bubble"
      data-shape={o.shape}
      style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h, display: o.visible && !hidden && stage.w > 0 ? undefined : "none" }}
      onPointerDown={(e) => startDrag(e, "move")}
      tabIndex={0}
      role="group"
      aria-label="Camera overlay"
      onKeyDown={(e) => {
        const step = e.shiftKey ? 0.05 : 0.01
        const moves: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }
        const m = moves[e.key]
        if (m) {
          e.preventDefault()
          e.stopPropagation()
          save({ ...overlay, x: Math.max(0, Math.min(1, overlay.x + m[0])), y: Math.max(0, Math.min(1, overlay.y + m[1])) })
        }
      }}
    >
      <div style={{ width: "100%", height: "100%", borderRadius: rect.radius, overflow: "hidden" }}>{children}</div>
      {selected && (
        <>
          <div className="frame" />
          {(["nw", "ne", "sw", "se"] as const).map((k) => (
            <span key={k} className={`handle ${k}`} data-testid={`handle-${k}`} onPointerDown={(e) => startDrag(e, k)} />
          ))}
          <div className="shapebar" role="group" aria-label="Camera shape" onPointerDown={(e) => e.stopPropagation()}>
            <button className={o.shape === "circle" ? "on" : ""} aria-pressed={o.shape === "circle"} onClick={() => save({ ...overlay, shape: "circle" })}>
              <Icon name="circle" />Circle
            </button>
            <button className={o.shape === "rounded" ? "on" : ""} aria-pressed={o.shape === "rounded"} onClick={() => save({ ...overlay, shape: "rounded" })}>
              <Icon name="rounded" />Rounded
            </button>
            <span className="sep" aria-hidden="true" />
            <Icon name="blur" />
            {BLUR_CHOICES.map(([label, blur, strength]) => {
              const on = o.blur === blur && (!blur || o.blurStrength === strength)
              return (
                <button key={label} className={on ? "on" : ""} aria-pressed={on} onClick={() => save({ ...overlay, blur, blurStrength: blur ? strength : overlay.blurStrength })}>
                  {label}
                </button>
              )
            })}
            <span className="sep" aria-hidden="true" />
            <button onClick={() => save({ ...overlay, visible: false })}>
              <Icon name="hide" />Hide
            </button>
          </div>
        </>
      )}
    </div>
  )
}
