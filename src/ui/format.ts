export const formatBytes = (bytes: number): string => {
  if (bytes < 1000) return `${bytes} B`
  const units = ["KB", "MB", "GB", "TB"]
  let v = bytes / 1000
  let i = 0
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000
    i++
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`
}

export const formatDate = (ms: number, now = Date.now()): string => {
  const d = new Date(ms)
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const diffDays = Math.round((day(new Date(now)) - day(d)) / 86_400_000)
  if (diffDays === 0) return `Today, ${time}`
  if (diffDays === 1) return `Yesterday, ${time}`
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(d.getFullYear() !== new Date(now).getFullYear() ? { year: "numeric" } : {}) })
}

export const defaultTitle = (ms: number) =>
  `Recording ${new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`
