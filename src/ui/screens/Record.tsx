import { RegistryContext, useAtomValue } from "@effect/atom-react"
import { Effect } from "effect"
import { useEffect, useRef, useState } from "react"
import { createRoot } from "react-dom/client"
import type { SourceType } from "../../domain/schema.ts"
import { formatClock } from "../../domain/transcriptFormat.ts"
import { Capture, type Devices } from "../../services/Capture.ts"
import { run } from "../../services/runtime.ts"
import { Nav } from "../App.tsx"
import { Icon, type IconName } from "../Icon.tsx"
import {
  askCancel,
  askRestart,
  cancelSession,
  dismissConfirm,
  elapsedAtom,
  pauseSession,
  restartSession,
  resumeSession,
  sessionAtom,
  setPipMounter,
  startSession,
  stopSession
} from "../recording.ts"
import { registry, settingsAtom, updateSettings } from "../state.ts"

const SOURCES: ReadonlyArray<{ value: SourceType; title: string; desc: string; icon: IconName }> = [
  { value: "browser", title: "Browser tab", desc: "Best for web app demos. Can include the tab's sound.", icon: "tab" },
  { value: "window", title: "Window", desc: "One app window, even when it's behind others.", icon: "window" },
  { value: "monitor", title: "Entire screen", desc: "Everything on one display. Can include system sound.", icon: "screen" }
]

// The floating controls render in their own React root inside the Picture-in-Picture window.
setPipMounter((win) => {
  const host = win.document.createElement("div")
  win.document.body.style.margin = "0"
  win.document.body.appendChild(host)
  const root = createRoot(host)
  root.render(
    <RegistryContext.Provider value={registry}>
      <FloatingControls />
    </RegistryContext.Provider>
  )
  return () => root.unmount()
})

export const Record = () => {
  const session = useAtomValue(sessionAtom)
  if (session.phase === "setup" || session.phase === "starting") return <Setup starting={session.phase === "starting"} />
  return <RecordingView />
}

const useDevices = () => {
  const [devices, setDevices] = useState<Devices>({ cameras: [], mics: [] })
  useEffect(() => {
    const load = () => void run(Effect.gen(function*() { return yield* (yield* Capture).devices })).then(setDevices)
    load()
    navigator.mediaDevices?.addEventListener("devicechange", load)
    return () => navigator.mediaDevices?.removeEventListener("devicechange", load)
  }, [])
  return [devices, () => void run(Effect.gen(function*() { return yield* (yield* Capture).devices })).then(setDevices)] as const
}

const useStream = (open: () => Promise<MediaStream> | null, deps: ReadonlyArray<unknown>, onOpen?: () => void) => {
  const [stream, setStream] = useState<MediaStream | null>(null)
  useEffect(() => {
    let alive = true
    let s: MediaStream | null = null
    const p = open()
    if (!p) {
      setStream(null)
      return
    }
    p.then((x) => {
      if (!alive) return x.getTracks().forEach((t) => t.stop())
      s = x
      setStream(x)
      onOpen?.()
    }, () => setStream(null))
    return () => {
      alive = false
      s?.getTracks().forEach((t) => t.stop())
    }
  }, deps)
  return stream
}

const MicMeter = ({ stream }: { stream: MediaStream | null }) => {
  const [level, setLevel] = useState(0)
  useEffect(() => {
    if (!stream || stream.getAudioTracks().length === 0) return
    const ctx = new AudioContext()
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 1024
    ctx.createMediaStreamSource(stream).connect(analyser)
    const data = new Float32Array(analyser.fftSize)
    let raf = 0
    const tick = () => {
      analyser.getFloatTimeDomainData(data)
      let sum = 0
      for (const v of data) sum += v * v
      const db = 20 * Math.log10(Math.sqrt(sum / data.length) || 1e-6)
      setLevel(Math.max(0, Math.min(12, Math.round((db + 60) / 4))))
      raf = requestAnimationFrame(tick)
    }
    tick()
    return () => {
      cancelAnimationFrame(raf)
      void ctx.close()
    }
  }, [stream])
  return (
    <div className="meter" aria-label="Microphone level" role="img">
      {Array.from({ length: 12 }, (_, i) => <i key={i} className={i < level ? "lit" : ""} />)}
    </div>
  )
}

const Setup = ({ starting }: { starting: boolean }) => {
  const settings = useAtomValue(settingsAtom)
  const [devices, reloadDevices] = useDevices()
  const camera = useStream(
    () => settings.cameraId === "none" ? null : run(Effect.gen(function*() { return yield* (yield* Capture).openCamera(settings.cameraId) })),
    [settings.cameraId],
    reloadDevices
  )
  const mic = useStream(
    () => settings.micId === "none" ? null : run(Effect.gen(function*() { return yield* (yield* Capture).openMic(settings.micId) })),
    [settings.micId],
    reloadDevices
  )
  const videoRef = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    if (videoRef.current) videoRef.current.srcObject = camera
  }, [camera])
  const audioLabel = settings.source === "browser" ? "Include tab sound" : settings.source === "monitor" ? "Include system sound" : null

  const start = () => {
    // Release the preview devices; recording opens its own.
    camera?.getTracks().forEach((t) => t.stop())
    void startSession(settings)
  }

  return (
    <>
      <Nav current="record" />
      <main className="page" style={{ maxWidth: 1040, paddingTop: 40 }}>
        <h1 style={{ marginBottom: 4 }}>New recording</h1>
        <p className="lede" style={{ marginBottom: 32 }}>Weave remembers these choices for next time.</p>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 40 }}>
          <form style={{ flex: "1 1 520px", minWidth: 0, display: "flex", flexDirection: "column", gap: 32 }} onSubmit={(e) => e.preventDefault()}>
            <fieldset style={{ border: 0, margin: 0, padding: 0 }}>
              <legend className="legend">What to share</legend>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12 }}>
                {SOURCES.map((s) => (
                  <label key={s.value} className={`choice${settings.source === s.value ? " on" : ""}`}>
                    <input
                      className="sr"
                      type="radio"
                      name="source"
                      value={s.value}
                      checked={settings.source === s.value}
                      onChange={() => updateSettings((x) => ({ ...x, source: s.value }))}
                    />
                    <span className="ring" aria-hidden="true" />
                    <Icon name={s.icon} />
                    <span className="t">{s.title}</span>
                    <span className="d">{s.desc}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            <fieldset style={{ border: 0, margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 16 }}>
              <legend className="legend">Camera and sound</legend>
              <div className="field">
                <label htmlFor="cam">Camera</label>
                <div className="selwrap">
                  <select
                    className="sel"
                    id="cam"
                    value={settings.cameraId}
                    onChange={(e) => updateSettings((x) => ({ ...x, cameraId: e.target.value }))}
                  >
                    <option value="default">{devices.cameras[0] ? `Default (${devices.cameras[0].label})` : "Default camera"}</option>
                    {devices.cameras.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
                    <option value="none">No camera</option>
                  </select>
                  <Icon name="chevron" />
                </div>
              </div>
              <div className="field">
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <label htmlFor="mic">Microphone</label>
                  <MicMeter stream={mic} />
                </div>
                <div className="selwrap">
                  <select
                    className="sel"
                    id="mic"
                    value={settings.micId}
                    onChange={(e) => updateSettings((x) => ({ ...x, micId: e.target.value }))}
                  >
                    <option value="default">{devices.mics[0] ? `Default (${devices.mics[0].label})` : "Default microphone"}</option>
                    {devices.mics.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
                    <option value="none">No microphone</option>
                  </select>
                  <Icon name="chevron" />
                </div>
              </div>
              {audioLabel
                ? (
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={settings.includeSystemAudio}
                      onChange={(e) => updateSettings((x) => ({ ...x, includeSystemAudio: e.target.checked }))}
                    />
                    <span>
                      <b style={{ fontWeight: 550 }}>{audioLabel}</b>
                      <br />
                      <span className="muted" style={{ fontSize: 13 }}>Mixed with your microphone into one audio track.</span>
                    </span>
                  </label>
                )
                : <p className="muted" style={{ margin: 0, fontSize: 13 }}>Browsers can't record a single window's sound. Your microphone is still recorded.</p>}
            </fieldset>
          </form>
          <aside style={{ flex: "0 1 380px", minWidth: 280, display: "flex", flexDirection: "column", gap: 16 }}>
            <div className="legend" style={{ margin: 0 }}>Camera preview</div>
            <div className="campreview">
              {settings.cameraId === "none"
                ? <span className="muted">No camera</span>
                : <video ref={videoRef} autoPlay muted playsInline data-testid="camera-preview" />}
              <span style={{ position: "absolute", left: 12, bottom: 10, fontSize: 12, color: "var(--muted)" }}>
                You can move, resize, or hide it after recording.
              </span>
            </div>
            <button className="btn primary big" type="button" style={{ width: "100%" }} onClick={start} disabled={starting}>
              <Icon name="record" />{starting ? "Waiting for the browser…" : "Start recording"}
            </button>
            <p style={{ margin: 0, fontSize: 13, lineHeight: 1.5, color: "var(--muted)" }}>
              Next, your browser asks which {settings.source === "browser" ? "tab" : settings.source === "window" ? "window" : "screen"} to share.
              Recording starts after a 3-second countdown. Everything stays on this device.
            </p>
          </aside>
        </div>
      </main>
    </>
  )
}

const CameraBubble = ({ size, dim }: { size: number; dim?: boolean }) => {
  const session = useAtomValue(sessionAtom)
  const ref = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    if (ref.current) ref.current.srcObject = session.cameraStream
  }, [session.cameraStream])
  if (!session.cameraStream) return null
  return <video ref={ref} className="pipcam" style={{ width: size, height: size, opacity: dim ? 0.45 : 1 }} autoPlay muted playsInline />
}

/** Countdown, timer, and buttons. Used in the floating window and in Weave's own tab. */
const Controls = ({ compact }: { compact: boolean }) => {
  const s = useAtomValue(sessionAtom)
  const elapsed = useAtomValue(elapsedAtom)
  if (s.phase === "countdown") {
    return (
      <>
        <div className="countdown tnum" data-testid="countdown">{s.count}</div>
        <p style={{ margin: 0, fontSize: 14, color: "var(--muted)" }}>Recording starts in {s.count} second{s.count === 1 ? "" : "s"}</p>
        <button className="btn" type="button" onClick={() => void cancelSession()}>Cancel</button>
      </>
    )
  }
  if (s.phase === "saving") {
    return <p style={{ margin: 0, fontSize: 15, fontWeight: 550 }}>Saving your recording…</p>
  }
  if (s.phase === "confirmRestart" || s.phase === "confirmCancel") {
    const restart = s.phase === "confirmRestart"
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 12, maxWidth: 360, width: "100%" }} role="alertdialog" aria-labelledby="confirm-title">
        {compact && <CameraBubble size={96} dim />}
        <h2 id="confirm-title" style={{ margin: 0, fontSize: 17, fontWeight: 650 }}>{restart ? "Restart this take?" : "Cancel this recording?"}</h2>
        <p style={{ margin: 0, fontSize: 13, lineHeight: 1.5, color: "var(--muted)" }}>
          {restart
            ? `The ${formatClock(elapsed)} you've recorded will be deleted. Your screen stays shared, and a new countdown starts.`
            : `The ${formatClock(elapsed)} you've recorded will be deleted, and nothing is saved.`}
        </p>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn" type="button" style={{ flex: 1 }} onClick={() => void dismissConfirm()}>Keep going</button>
          <button className="btn primary" type="button" style={{ flex: 1 }} onClick={() => void (restart ? restartSession() : cancelSession())}>
            {restart ? "Restart" : "Delete recording"}
          </button>
        </div>
      </div>
    )
  }
  const paused = s.phase === "paused"
  return (
    <>
      {compact && <CameraBubble size={132} dim={paused} />}
      <div className="time tnum" style={{ fontSize: compact ? 26 : 40, color: paused ? "var(--muted)" : undefined }} data-testid="elapsed">
        {paused ? <Icon name="pause" size={16} /> : <span className="rec" aria-hidden="true" />}
        {formatClock(elapsed)}
        {paused && <span style={{ fontSize: 13, fontWeight: 550 }}>Paused</span>}
      </div>
      <div className="ctls" style={{ maxWidth: compact ? undefined : 420 }}>
        {paused
          ? <button className="ctl primary" type="button" onClick={() => void resumeSession()}><Icon name="play" />Resume</button>
          : <button className="ctl" type="button" onClick={() => void pauseSession()}><Icon name="pause" />Pause</button>}
        <button className="ctl" type="button" onClick={() => void askRestart()}><Icon name="restart" />Restart</button>
        <button className={`ctl${paused ? "" : " primary"}`} type="button" onClick={() => void stopSession()}><Icon name="stop" />Stop</button>
        <button className="ctl quiet" type="button" aria-label="Cancel and discard" onClick={() => void askCancel()}><Icon name="trash" />Cancel</button>
      </div>
    </>
  )
}

const FloatingControls = () => (
  <div className="pipbody">
    <Controls compact />
  </div>
)

const RecordingView = () => {
  const s = useAtomValue(sessionAtom)
  const what = s.surfaceType === "browser" ? "tab" : s.surfaceType === "window" ? "window" : "screen"
  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      <header className="nav" style={{ height: 44 }}>
        <span className="logo"><span className="dot" aria-hidden="true" />Weave</span>
      </header>
      <main
        style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 14, padding: 24, textAlign: "center" }}
        data-testid="recording-view"
        data-phase={s.phase}
      >
        {s.phase !== "countdown" && s.phase !== "saving" && (
          <p style={{ margin: 0, fontSize: 15, fontWeight: 550 }}>
            Recording your {what}{s.surfaceLabel ? ` "${s.surfaceLabel}"` : ""}
          </p>
        )}
        <Controls compact={!s.pip} />
        {s.pip && s.phase !== "saving" && (
          <p className="muted" style={{ margin: 0, fontSize: 13, maxWidth: 380, lineHeight: 1.5 }}>
            The controls are also in the floating window. Keep this tab open until you stop.
          </p>
        )}
      </main>
    </div>
  )
}
