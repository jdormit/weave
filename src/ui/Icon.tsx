import type { ReactElement } from "react"

const paths: Record<string, ReactElement> = {
  record: <circle cx="12" cy="12" r="6" fill="currentColor" stroke="none" />,
  more: (
    <>
      <circle cx="5" cy="12" r="1.2" fill="currentColor" />
      <circle cx="12" cy="12" r="1.2" fill="currentColor" />
      <circle cx="19" cy="12" r="1.2" fill="currentColor" />
    </>
  ),
  alert: <><circle cx="12" cy="12" r="9" /><path d="M12 7.5v5.5M12 16.5v.01" /></>,
  tab: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 9.5h18M8 5v4.5" /></>,
  window: <><rect x="4" y="5" width="16" height="14" rx="2" /><path d="M4 9h16" /><path d="M7 7h.01M9.5 7h.01" /></>,
  screen: <><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></>,
  chevron: <path d="M6 9l6 6 6-6" />,
  back: <path d="M15 6l-6 6 6 6" />,
  pause: <path d="M9 6v12M15 6v12" />,
  play: <path d="M8 5.5v13l10-6.5z" fill="currentColor" />,
  restart: <><path d="M4 12a8 8 0 1 0 2.4-5.7" /><path d="M4 4v4.5h4.5" /></>,
  stop: <rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor" />,
  trash: <path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" />,
  undo: <><path d="M9 14L4 9l5-5" /><path d="M4 9h11a5 5 0 0 1 0 10h-3" /></>,
  redo: <><path d="M15 14l5-5-5-5" /><path d="M20 9H9a5 5 0 0 0 0 10h3" /></>,
  cleanup: <path d="M4 6h16M4 12h10M4 18h5" />,
  download: <path d="M12 4v11M7 10l5 5 5-5M5 20h14" />,
  split: <path d="M12 3v18M8 8l-4 4 4 4M16 8l4 4-4 4" />,
  minus: <path d="M5 12h14" />,
  plus: <path d="M5 12h14M12 5v14" />,
  close: <path d="M6 6l12 12M18 6L6 18" />,
  check: <path d="M5 12l5 5 9-10" />,
  circle: <circle cx="12" cy="12" r="8" />,
  rounded: <rect x="4" y="5" width="16" height="14" rx="4" />,
  hide: <path d="M3 3l18 18M10.6 6.1A9.8 9.8 0 0 1 12 6c5 0 8.5 4 9.5 6a13 13 0 0 1-2.6 3.4M6.5 7.5A13 13 0 0 0 2.5 12c1 2 4.5 6 9.5 6a9.5 9.5 0 0 0 4.4-1.1" />,
  camera: <><rect x="3" y="7" width="13" height="10" rx="2" /><path d="M16 11l5-3v8l-5-3" /></>,
  restore: <><path d="M3 12a9 9 0 1 0 3-6.7" /><path d="M3 4v5h5" /></>
}

export type IconName = keyof typeof paths

export const Icon = ({ name, size, style }: { name: IconName; size?: number; style?: React.CSSProperties }) => (
  <svg className="ico" viewBox="0 0 24 24" aria-hidden="true" style={size ? { width: size, height: size, ...style } : style}>
    {paths[name]}
  </svg>
)
