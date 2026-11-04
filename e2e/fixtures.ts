import { test as base, chromium, type BrowserContext, type Page } from "@playwright/test"
import { mkdirSync } from "node:fs"
import { join } from "node:path"

export const root = join(import.meta.dirname, "..")
export const speechFile = join(root, "e2e/fixtures/speech.wav")
export const downloadsDir = join(root, "e2e/.downloads")

const baseURL = `http://localhost:${Number(process.env.E2E_PORT ?? 4173)}`

/**
 * One browser page for the whole run. Tests run in order and share the
 * recording made by the first one, like a person working through the app.
 */
export const test = base.extend<{ page: Page }, { app: { context: BrowserContext; page: Page } }>({
  app: [
    async ({}, use) => {
      mkdirSync(downloadsDir, { recursive: true })
      // A fresh browser each run. (A persistent profile would keep the model
      // cache, but headless Chromium crashes saving large downloads into one.)
      const browser = await chromium.launch({
        executablePath: process.env.PW_CHROMIUM_PATH || undefined,
        headless: process.env.HEADED ? false : true,
        downloadsPath: downloadsDir,
        args: [
          "--use-fake-device-for-media-stream",
          "--use-fake-ui-for-media-stream",
          "--auto-select-desktop-capture-source=Entire screen",
          `--use-file-for-fake-audio-capture=${speechFile}`,
          "--autoplay-policy=no-user-gesture-required"
        ]
      })
      const context = await browser.newContext({
        baseURL,
        viewport: { width: 1440, height: 900 },
        permissions: ["camera", "microphone"],
        acceptDownloads: true
      })
      // Headless Chromium's WebGPU is a slow software adapter; use WASM like the design says.
      await context.addInitScript(() => {
        try {
          localStorage.setItem("weave.forceWasm", "1")
        } catch {}
      })
      const page = await context.newPage()
      page.on("pageerror", (e) => console.log(`[pageerror] ${e.message}`))
      page.on("crash", () => console.log("[crash] the page crashed"))
      page.on("console", (m) => {
        if (m.type() === "error") console.log(`[console.error] ${m.text().slice(0, 400)}`)
      })
      await use({ context, page })
      await browser.close()
    },
    { scope: "worker" }
  ],
  page: async ({ app }, use) => {
    await use(app.page)
  }
})

export { expect } from "@playwright/test"

/** Reads a record from Weave's IndexedDB. */
export const readDb = (page: Page, store: "recordings" | "transcripts" | "edits", key: string) =>
  page.evaluate(
    ([store, key]) =>
      new Promise<any>((resolve, reject) => {
        const req = indexedDB.open("weave")
        req.onsuccess = () => {
          const tx = req.result.transaction(store!, "readonly")
          const get = tx.objectStore(store!).get(key!)
          get.onsuccess = () => resolve(get.result)
          get.onerror = () => reject(get.error)
        }
        req.onerror = () => reject(req.error)
      }),
    [store, key] as const
  )

export const allRecordings = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<Array<any>>((resolve, reject) => {
        const req = indexedDB.open("weave")
        req.onupgradeneeded = () => {
          req.result.createObjectStore("recordings", { keyPath: "id" })
          req.result.createObjectStore("transcripts", { keyPath: "recordingId" })
          req.result.createObjectStore("edits", { keyPath: "recordingId" })
        }
        req.onsuccess = () => {
          const get = req.result.transaction("recordings", "readonly").objectStore("recordings").getAll()
          get.onsuccess = () => resolve(get.result)
          get.onerror = () => reject(get.error)
        }
        req.onerror = () => reject(req.error)
      })
  )

/** Files in OPFS under recordings/, as { folder: [file names] }. */
export const opfsFiles = (page: Page) =>
  page.evaluate(async () => {
    const out: Record<string, Array<string>> = {}
    const root = await navigator.storage.getDirectory()
    let dir: FileSystemDirectoryHandle
    try {
      dir = await root.getDirectoryHandle("recordings")
    } catch {
      return out
    }
    for await (const [name, handle] of (dir as any).entries()) {
      out[name] = []
      if (handle.kind === "directory") for await (const f of handle.keys()) out[name]!.push(f)
    }
    return out
  })

/** Deletes every recording, transcript and edit, but keeps the downloaded models. */
export const resetAppData = async (page: Page) => {
  await page.goto("/")
  await page.evaluate(async () => {
    await new Promise<void>((resolve) => {
      const req = indexedDB.deleteDatabase("weave")
      req.onsuccess = req.onerror = req.onblocked = () => resolve()
    })
    const root = await navigator.storage.getDirectory()
    try {
      await root.removeEntry("recordings", { recursive: true })
    } catch {}
    localStorage.removeItem("weave.settings.v1")
  })
  await page.reload()
}
