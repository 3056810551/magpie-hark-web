// Watches the parent process (e.g. Magpie or OpenCode) and triggers clean exit when it stops.
export function parentAlive(pid) {
  const n = Number(pid)
  if (!(Number.isInteger(n) && n > 0)) return true
  try {
    process.kill(n, 0)
    return true
  } catch (err) {
    return err.code !== "ESRCH"
  }
}

export function watchParent(pid, gone, { everyMs = 10_000, alive = parentAlive } = {}) {
  const n = Number(pid)
  if (!(Number.isInteger(n) && n > 0) || n === process.pid) return null
  if (!alive(n)) {
    gone()
    return null
  }
  const timer = setInterval(() => {
    if (alive(n)) return
    clearInterval(timer)
    gone()
  }, everyMs)
  timer.unref?.()
  return timer
}
