import { useAtomValue } from "@effect/atom-react"
import { Effect } from "effect"
import { useEffect, useRef, useState } from "react"
import { Capture } from "../../services/Capture.ts"
import { run } from "../../services/runtime.ts"
import { useEditor } from "../editorState.ts"
import { Icon } from "../Icon.tsx"
import { startTake } from "../retake.ts"
import { useDevices, useStream } from "../screens/Record.tsx"
import { settingsAtom } from "../state.ts"
import { BlurredVideo } from "./BlurredVideo.tsx"
import { Dialog } from "./Dialog.tsx"

/** Sets up a new camera and voice take for a recording that is already saved. */
export const RetakeDialog = ({ onClose }: { onClose: () => void }) => {
  const c = useEditor()
  const settings = useAtomValue(settingsAtom)
  const [devices, reloadDevices] = useDevices()
  const [cameraId, setCameraId] = useState(settings.cameraId)
  const [micId, setMicId] = useState(settings.micId)
  const [keep, setKeep] = useState(!c.recording.screenAudioMuted)
  const camera = useStream(
    () => cameraId === "none" ? null : run(Effect.gen(function*() { return yield* (yield* Capture).openCamera(cameraId) })),
    [cameraId],
    reloadDevices
  )
  const videoRef = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    if (videoRef.current) videoRef.current.srcObject = camera
  }, [camera])

  const hasOld = c.recording.hasCamera || c.recording.cameraAudio
  const nothing = cameraId === "none" && micId === "none"
  const waiting = cameraId !== "none" && !camera

  const start = () => {
    // The preview's tracks stop when the dialog closes, so the take gets its own copy.
    const stream = camera?.clone() ?? null
    onClose()
    void startTake(c, { camera: stream, micId, keepScreenAudio: c.recording.hasAudio && keep })
  }

  return (
    <Dialog
      title={hasOld ? "Re-record camera and voice" : "Add camera and voice"}
      subtitle="The video plays from the beginning, skipping the parts you cut. Your camera and microphone record along with it."
      onClose={onClose}
      testId="retake"
    >
      <div className="camrow">
        <div style={{ flex: 1, minWidth: 220, display: "flex", flexDirection: "column", gap: 14 }}>
          <div className="field">
            <label htmlFor="retake-cam">Camera</label>
            <div className="selwrap">
              <select className="sel" id="retake-cam" value={cameraId} onChange={(e) => setCameraId(e.target.value)}>
                <option value="default">{devices.cameras[0] ? `Default (${devices.cameras[0].label})` : "Default camera"}</option>
                {devices.cameras.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
                <option value="none">No camera</option>
              </select>
              <Icon name="chevron" />
            </div>
          </div>
          <div className="field">
            <label htmlFor="retake-mic">Microphone</label>
            <div className="selwrap">
              <select className="sel" id="retake-mic" value={micId} onChange={(e) => setMicId(e.target.value)}>
                <option value="default">{devices.mics[0] ? `Default (${devices.mics[0].label})` : "Default microphone"}</option>
                {devices.mics.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
                <option value="none">No microphone</option>
              </select>
              <Icon name="chevron" />
            </div>
          </div>
        </div>
        <div className="campreview retake-preview">
          {cameraId === "none"
            ? <span className="muted">No camera</span>
            : (
              <BlurredVideo videoRef={videoRef} blur={c.recording.overlay.blur}>
                <video ref={videoRef} autoPlay muted playsInline data-testid="retake-camera-preview" />
              </BlurredVideo>
            )}
        </div>
      </div>
      {c.recording.hasAudio && (
        <label className="check">
          <input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} data-testid="keep-screen-audio" />
          <span>
            <b style={{ fontWeight: 550 }}>Keep the original sound</b>
            <br />
            <span className="muted" style={{ fontSize: 13 }}>
              Turn this off to replace your original narration. If it's on, use headphones so your microphone doesn't pick it up.
            </span>
          </span>
        </label>
      )}
      <p className="sub" style={{ margin: 0 }}>
        {hasOld ? "This replaces the camera and voice you have now. " : ""}
        Your cuts stay, and the transcript is made again from the new sound.
      </p>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" onClick={start} disabled={nothing || waiting}>
          <Icon name="record" />Start recording
        </button>
      </div>
    </Dialog>
  )
}
