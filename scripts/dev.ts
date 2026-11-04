/**
 * Development server: builds into dist/, rebuilds when a file in src/ changes,
 * and reloads open pages.
 */
import { watch } from "node:fs"
import { join } from "node:path"
import { build, root } from "./build.ts"
import { serve } from "./serve.ts"

let version = 0
const clients = new Set<ReadableStreamDefaultController<string>>()
const reloadScript =
  `<script>(() => { const es = new EventSource("/__reload"); let v; es.onmessage = (e) => { if (v !== undefined && v !== e.data) location.reload(); v = e.data } })()</script>`

const rebuild = async () => {
  const started = performance.now()
  try {
    await build({ minify: false })
    version++
    for (const c of clients) c.enqueue(`data: ${version}\n\n`)
    console.log(`Rebuilt in ${Math.round(performance.now() - started)} ms`)
  } catch (e) {
    console.error(e)
  }
}

await rebuild()

const server = serve({
  inject: reloadScript,
  extra: (req) => {
    if (new URL(req.url).pathname !== "/__reload") return undefined
    let self: ReadableStreamDefaultController<string>
    const stream = new ReadableStream<string>({
      start(c) {
        self = c
        clients.add(c)
        c.enqueue(`data: ${version}\n\n`)
      },
      cancel() {
        clients.delete(self)
      }
    })
    return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } })
  }
})
console.log(`Weave dev server at ${server.url}`)

let timer: ReturnType<typeof setTimeout> | undefined
watch(join(root, "src"), { recursive: true }, () => {
  clearTimeout(timer)
  timer = setTimeout(rebuild, 100)
})
