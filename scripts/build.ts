/**
 * Builds the static app into dist/: the page from src/index.html, the two
 * workers, and the ONNX Runtime files the transcription worker loads.
 */
import { cp, mkdir, readdir, rm } from "node:fs/promises"
import { join } from "node:path"

export const root = join(import.meta.dir, "..")
export const dist = join(root, "dist")

export const build = async (options: { minify?: boolean; outdir?: string } = {}) => {
  const outdir = options.outdir ?? dist
  const minify = options.minify ?? true
  await rm(outdir, { recursive: true, force: true })
  await mkdir(outdir, { recursive: true })

  const page = await Bun.build({
    entrypoints: [join(root, "src/index.html")],
    outdir,
    minify,
    publicPath: "/",
    sourcemap: "linked",
    target: "browser",
    define: { "process.env.NODE_ENV": JSON.stringify(minify ? "production" : "development") }
  })
  if (!page.success) throw new AggregateError(page.logs, "Page build failed")

  const workers = await Bun.build({
    entrypoints: [join(root, "src/workers/transcribe.worker.ts"), join(root, "src/workers/export.worker.ts")],
    outdir: join(outdir, "workers"),
    naming: "[name].[ext]",
    minify,
    sourcemap: "linked",
    target: "browser",
    format: "esm"
  })
  if (!workers.success) throw new AggregateError(workers.logs, "Worker build failed")
  // transcribe.worker.js -> transcribe.js, as the app expects.
  for (const name of await readdir(join(outdir, "workers"))) {
    if (name.includes(".worker.")) {
      const to = name.replace(".worker.", ".")
      await Bun.write(join(outdir, "workers", to), Bun.file(join(outdir, "workers", name)))
      await rm(join(outdir, "workers", name))
    }
  }

  // ONNX Runtime Web loads its WASM files at run time. Serve them from Weave instead of a CDN.
  // The plain build runs on the CPU; the JSPI build adds WebGPU. Both fit Cloudflare's 25 MiB asset limit.
  const ortDir = join(root, "node_modules/onnxruntime-web/dist")
  await mkdir(join(outdir, "ort"), { recursive: true })
  for (const name of ["ort-wasm-simd-threaded.mjs", "ort-wasm-simd-threaded.wasm", "ort-wasm-simd-threaded.jspi.mjs", "ort-wasm-simd-threaded.jspi.wasm"]) {
    await cp(join(ortDir, name), join(outdir, "ort", name))
  }

  // Inter, served from Weave itself. Only the variable-weight upright files are used.
  const fontDir = join(root, "node_modules/@fontsource-variable/inter")
  await mkdir(join(outdir, "fonts"), { recursive: true })
  const fontCss = (await Bun.file(join(fontDir, "wght.css")).text()).replaceAll("url(./files/", "url(/fonts/")
  await Bun.write(join(outdir, "fonts/inter.css"), fontCss)
  for (const name of await readdir(join(fontDir, "files"))) {
    if (name.endsWith("-wght-normal.woff2")) await cp(join(fontDir, "files", name), join(outdir, "fonts", name))
  }
  await cp(join(fontDir, "LICENSE"), join(outdir, "fonts/LICENSE.txt"))
  const indexPath = join(outdir, "index.html")
  const html = await Bun.file(indexPath).text()
  await Bun.write(
    indexPath,
    html.replace("<head>", `<head><link rel="preload" href="/fonts/inter-latin-wght-normal.woff2" as="font" type="font/woff2" crossorigin><link rel="stylesheet" href="/fonts/inter.css">`)
  )
  await cp(join(root, "src/favicon.svg"), join(outdir, "favicon.svg"))
  // Headers for Cloudflare Workers static assets: cross-origin isolation, so
  // ONNX Runtime can use threads. scripts/serve.ts sends the same ones locally.
  await Bun.write(
    join(outdir, "_headers"),
    "/*\n  Cross-Origin-Opener-Policy: same-origin\n  Cross-Origin-Embedder-Policy: credentialless\n"
  )
  await checkAssetSizes(outdir)
  return outdir
}

/** Cloudflare refuses any static asset over 25 MiB, so fail the build first. */
const checkAssetSizes = async (dir: string) => {
  const limit = 25 * 1024 * 1024
  for (const name of await readdir(dir, { recursive: true })) {
    const f = Bun.file(join(dir, name))
    if ((await f.exists()) && f.size > limit) throw new Error(`${name} is ${(f.size / 1048576).toFixed(1)} MiB; Cloudflare's limit is 25 MiB.`)
  }
}

if (import.meta.main) {
  const started = performance.now()
  await build()
  console.log(`Built dist/ in ${Math.round(performance.now() - started)} ms`)
}
