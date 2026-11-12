// Minimal Chrome DevTools Protocol client over runtime WebSocket (Node >= 20 or Bun).
export class CDPError extends Error {}

export class CDP {
  static connect(url, { timeoutMs = 90_000 } = {}) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url)
      const timer = setTimeout(() => {
        ws.close()
        reject(new CDPError(`CDP connect timed out: ${url}`))
      }, 15_000)
      ws.addEventListener("open", () => {
        clearTimeout(timer)
        resolve(new CDP(ws, timeoutMs))
      })
      ws.addEventListener("error", () => {
        clearTimeout(timer)
        reject(new CDPError(`CDP connect failed: ${url}`))
      })
    })
  }

  constructor(ws, timeoutMs) {
    this.ws = ws
    this.timeoutMs = timeoutMs
    this.nextId = 0
    this.pending = new Map()
    this.eventListeners = new Map()
    this.closed = false
    this.closers = []
    ws.addEventListener("message", (ev) => {
      let msg
      try {
        msg = JSON.parse(typeof ev.data === "string" ? ev.data : Buffer.from(ev.data).toString("utf8"))
      } catch {
        return
      }
      if (msg.method) {
        const listeners = this.eventListeners.get(msg.method)
        if (listeners) {
          for (const fn of listeners) fn(msg.params)
        }
      }
      const waiter = msg.id != null ? this.pending.get(msg.id) : null
      if (!waiter) return
      this.pending.delete(msg.id)
      clearTimeout(waiter.timer)
      if (msg.error) waiter.reject(new CDPError(`${waiter.method}: ${msg.error.message ?? JSON.stringify(msg.error)}`))
      else waiter.resolve(msg.result ?? {})
    })
    ws.addEventListener("close", () => {
      this.closed = true
      for (const fn of this.closers.splice(0)) fn()
      for (const waiter of this.pending.values()) {
        clearTimeout(waiter.timer)
        waiter.reject(new CDPError(`${waiter.method}: connection closed`))
      }
      this.pending.clear()
    })
  }

  on(method, fn) {
    if (!this.eventListeners.has(method)) this.eventListeners.set(method, new Set())
    this.eventListeners.get(method).add(fn)
  }

  off(method, fn) {
    const set = this.eventListeners.get(method)
    if (set) set.delete(fn)
  }

  send(method, params = {}, timeoutMs = this.timeoutMs) {
    if (this.closed) return Promise.reject(new CDPError(`${method}: connection closed`))
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new CDPError(`CDP ${method} timed out`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer, method })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  async js(expression, { awaitPromise = false, timeoutMs } = {}) {
    const r = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise }, timeoutMs)
    return r.result && "value" in r.result ? r.result.value : undefined
  }

  onClose(fn) {
    if (this.closed) fn()
    else this.closers.push(fn)
  }

  close() {
    this.closed = true
    try {
      this.ws.close()
    } catch {}
  }
}

export async function httpJSON(url, timeoutMs = 5000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  return res.json()
}
