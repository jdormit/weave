/**
 * Serves dist/ the way the production Worker does: with cross-origin isolation
 * headers, and index.html for app routes.
 */
import { join, normalize } from "node:path"
import { dist } from "./build.ts"

export const isolationHeaders = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "credentialless"
} as const

export const serve = (
  options: { port?: number; dir?: string; inject?: string; extra?: (req: Request) => Response | undefined } = {}
) => {
  const dir = options.dir ?? dist
  return Bun.serve({
    port: options.port ?? Number(process.env.PORT ?? 5173),
    idleTimeout: 0,
    async fetch(req) {
      const extra = options.extra?.(req)
      if (extra) return extra
      const url = new URL(req.url)
      const path = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "")
      let file = Bun.file(join(dir, path))
      const isAsset = /\.[a-z0-9]+$/i.test(path)
      if (!isAsset || !(await file.exists())) {
        if (isAsset) return new Response("Not found", { status: 404, headers: isolationHeaders })
        file = Bun.file(join(dir, "index.html"))
      }
      const headers: Record<string, string> = { ...isolationHeaders }
      if (path.endsWith(".mjs")) headers["Content-Type"] = "text/javascript"
      if (!isAsset && options.inject) {
        const html = (await file.text()).replace("</body>", `${options.inject}</body>`)
        return new Response(html, { headers: { ...headers, "Content-Type": "text/html;charset=utf-8" } })
      }
      return new Response(file, { headers })
    }
  })
}

if (import.meta.main) {
  const server = serve()
  console.log(`Serving dist/ at ${server.url}`)
}
