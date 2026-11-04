import { useAtomValue } from "@effect/atom-react"
import { Icon } from "./Icon.tsx"
import { onLinkClick, useRoute } from "./router.ts"
import { dismissToast, toastsAtom } from "./state.ts"
import { Editor } from "./screens/Editor.tsx"
import { Library } from "./screens/Library.tsx"
import { Record } from "./screens/Record.tsx"
import { SettingsScreen } from "./screens/Settings.tsx"

/** Chromium has every API Weave needs: MediaRecorder, WebCodecs, OPFS and Document Picture-in-Picture. */
export const isSupportedBrowser = () => {
  const brands = (navigator as Navigator & { userAgentData?: { brands: Array<{ brand: string }> } }).userAgentData?.brands
  const chromium = brands ? brands.some((b) => b.brand === "Chromium") : /Chrome\//.test(navigator.userAgent)
  return chromium && typeof MediaRecorder !== "undefined" && typeof VideoEncoder !== "undefined"
}

export const Nav = ({ current }: { current: "library" | "settings" | "record" }) => (
  <header className="nav">
    <a className="logo" href="/" onClick={onLinkClick("/")}>
      <span className="dot" aria-hidden="true" />Weave
    </a>
    <a className={`navlink${current === "library" ? " on" : ""}`} href="/" onClick={onLinkClick("/")}>Library</a>
    <a className={`navlink${current === "settings" ? " on" : ""}`} href="/settings" onClick={onLinkClick("/settings")}>Settings</a>
    <div className="spacer" />
    {current !== "record" && (
      <a className="btn primary" href="/record" onClick={onLinkClick("/record")}>
        <Icon name="record" />New recording
      </a>
    )}
  </header>
)

const Toasts = () => {
  const toasts = useAtomValue(toastsAtom)
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div className="toast" key={t.id}>
          <span>{t.text}</span>
          <button onClick={() => dismissToast(t.id)} aria-label="Dismiss">
            <Icon name="close" size={16} />
          </button>
        </div>
      ))}
    </div>
  )
}

const UnsupportedNotice = () =>
  isSupportedBrowser() ? null : (
    <div className="banner warn" style={{ margin: "16px 24px 0" }} role="note">
      <Icon name="alert" style={{ color: "var(--accent)" }} />
      <span>
        Weave is built for Chrome, Edge, and other Chromium browsers. In this browser, recording, transcription, or export may not work.
      </span>
    </div>
  )

export const App = () => {
  const route = useRoute()
  return (
    <>
      {route.name !== "editor" && <UnsupportedNotice />}
      {route.name === "library" && <Library />}
      {route.name === "record" && <Record />}
      {route.name === "settings" && <SettingsScreen />}
      {route.name === "editor" && <Editor key={route.id} id={route.id} />}
      {route.name === "notFound" && (
        <>
          <Nav current="library" />
          <main className="page">
            <h1>Page not found</h1>
            <p className="lede"><a href="/" onClick={onLinkClick("/")}>Go to your library</a></p>
          </main>
        </>
      )}
      <Toasts />
    </>
  )
}
