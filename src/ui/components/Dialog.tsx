import { useEffect, useId, useRef, type ReactNode } from "react"
import { Icon } from "../Icon.tsx"

/** A modal dialog. Escape and clicking outside close it. */
export const Dialog = ({
  title,
  subtitle,
  onClose,
  wide,
  children,
  testId
}: {
  title: string
  subtitle?: ReactNode
  onClose: () => void
  wide?: boolean
  children: ReactNode
  testId?: string
}) => {
  const id = useId()
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null
    ref.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener("keydown", onKey, true)
    return () => {
      window.removeEventListener("keydown", onKey, true)
      prev?.focus?.()
    }
  }, [onClose])
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className={`dialog${wide ? " wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={id}
        tabIndex={-1}
        ref={ref}
        data-testid={testId}
      >
        <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
          <div style={{ flex: 1 }}>
            <h2 id={id}>{title}</h2>
            {subtitle && <p className="sub">{subtitle}</p>}
          </div>
          <button className="iconbtn" aria-label="Close" onClick={onClose}>
            <Icon name="close" />
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}

export const ConfirmDialog = ({
  title,
  body,
  confirm,
  danger,
  onConfirm,
  onCancel
}: {
  title: string
  body: ReactNode
  confirm: string
  danger?: boolean
  onConfirm: () => void
  onCancel: () => void
}) => (
  <Dialog title={title} onClose={onCancel}>
    <p className="sub">{body}</p>
    <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
      <button className="btn" onClick={onCancel}>Cancel</button>
      <button className={`btn ${danger ? "primary" : "primary"}`} onClick={onConfirm}>{confirm}</button>
    </div>
  </Dialog>
)
