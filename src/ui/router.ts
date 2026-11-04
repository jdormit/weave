import { useSyncExternalStore } from "react"

export type Route =
  | { readonly name: "library" }
  | { readonly name: "record" }
  | { readonly name: "editor"; readonly id: string }
  | { readonly name: "settings" }
  | { readonly name: "notFound" }

export const parseRoute = (pathname: string): Route => {
  const path = pathname.replace(/\/+$/, "") || "/"
  if (path === "/") return { name: "library" }
  if (path === "/record") return { name: "record" }
  if (path === "/settings") return { name: "settings" }
  const m = /^\/r\/([^/]+)$/.exec(path)
  if (m) return { name: "editor", id: decodeURIComponent(m[1]!) }
  return { name: "notFound" }
}

const listeners = new Set<() => void>()
const notify = () => listeners.forEach((f) => f())
if (typeof window !== "undefined") window.addEventListener("popstate", notify)

export const navigate = (to: string, options?: { replace?: boolean }) => {
  if (options?.replace) history.replaceState(null, "", to)
  else history.pushState(null, "", to)
  notify()
  window.scrollTo(0, 0)
}

export const useRoute = (): Route =>
  parseRoute(
    useSyncExternalStore(
      (f) => {
        listeners.add(f)
        return () => listeners.delete(f)
      },
      () => location.pathname
    )
  )

/** A link that navigates without reloading. */
export const onLinkClick = (to: string) => (e: React.MouseEvent) => {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
  e.preventDefault()
  navigate(to)
}
