// Loopback HTTP surface of the hark-web engine.
import http from "node:http"
import { randomUUID, timingSafeEqual } from "node:crypto"
import { AuthError, expiryMs, QuotaError, renewSession } from "./hark.mjs"
import { buildPrompt, PromptError } from "./prompt.mjs"
import { functions, parseCalls, TOOLS_REMINDER, toolsPrompt } from "./tools.mjs"
import { importSession } from "./import-chrome.mjs"
import { VERSION } from "./version.mjs"

export { VERSION }
export const MODEL = "hark"
const USAGE_STALE_MS = 15 * 60_000

class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

function same(a, b) {
  const x = Buffer.from(String(a))
  const y = Buffer.from(String(b))
  return x.length === y.length && timingSafeEqual(x, y)
}

function json(res, status, body) {
  const data = JSON.stringify(body)
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(data) })
  res.end(data)
}

function fail(res, status, message) {
  json(res, status, { error: { message, type: status === 401 ? "authentication_error" : status === 429 ? "rate_limit_error" : "engine_error" } })
}

async function body(req, limit = 8 << 20) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new HttpError(413, "request too large")
    chunks.push(chunk)
  }
  if (!size) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"))
  } catch {
    throw new HttpError(400, "invalid JSON body")
  }
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c])

function loginPage(state) {
  const done = state?.status === "done"
  const failed = state?.status === "failed" || !state
  const title = done ? "登录完成" : failed ? "登录没有完成" : "请在弹出的浏览器窗口登录 hark.com"
  const note = done
    ? "可以关掉这个页面，回到 Magpie。"
    : failed
      ? esc(state?.error || "找不到这次登录，请回到 Magpie 重新发起。")
      : `这个页面只显示进度。请在引擎打开的 Chrome/Edge 窗口里完成登录 Hark。${esc(state?.step || "")}。登录成功后窗口会自动关闭，页面会自动更新。`
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>hark-web 登录</title>
${done || failed ? "" : '<meta http-equiv="refresh" content="2">'}
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{color-scheme:light dark;font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:Canvas;color:CanvasText}
main{max-width:30rem;padding:2rem}
h1{font-size:1.25rem;margin:0 0 .5rem;font-weight:600}
p{margin:0;opacity:.75}
.dot{display:inline-block;width:.6rem;height:.6rem;border-radius:50%;margin-right:.5rem;vertical-align:middle;background:${done ? "#2f9e44" : failed ? "#e03131" : "#f59f00"}}
</style></head><body><main><h1><span class="dot"></span>${title}</h1><p>${note}</p></main></body></html>`
}

export function createServer({
  hark,
  logins,
  store,
  key,
  port = 18622,
  log = () => {},
  onActivity = () => {},
  onShutdown = () => {},
  site = "https://hark.com",
}) {
  const busy = new Set()

  function authorize(req) {
    const header = String(req.headers.authorization || "")
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : ""
    if (!token || !same(token, key)) throw new HttpError(401, "bad engine key")
  }

  function account(req) {
    const id = String(req.headers["x-hark-account"] || "").trim()
    if (!id) throw new HttpError(400, "missing X-Hark-Account")
    const item = store.get(id)
    if (!item) throw new HttpError(401, "unknown account; sign in again")
    return item
  }

  async function chat(req, res, meta) {
    const payload = await body(req)
    const acct = account(req)
    meta.account = acct.id
    let prompt
    try {
      prompt = buildPrompt(payload.messages)
    } catch (err) {
      if (err instanceof PromptError) throw new HttpError(400, err.message)
      throw err
    }
    const toolNote = toolsPrompt(payload.tools, payload.tool_choice)
    if (toolNote) {
      prompt = {
        ...prompt,
        full: `${prompt.full}\n\n${toolNote}`,
        last: prompt.last && `${prompt.last}\n\n${TOOLS_REMINDER}`,
      }
    }
    if (busy.has(acct.id)) throw new HttpError(429, "account busy")
    busy.add(acct.id)
    const session = String(req.headers["x-hark-session"] || "").trim()
    meta.session = session
    const stream = payload.stream !== false
    const id = `chatcmpl-${randomUUID()}`
    const created = Math.floor(Date.now() / 1000)
    const ac = new AbortController()
    res.on("close", () => { if (!res.writableFinished) ac.abort() })

    let started = false
    let text = ""
    const chunk = (delta, finish = null) =>
      `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: MODEL, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
    const begin = () => {
      if (started) return
      res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" })
      res.write(chunk({ role: "assistant", content: "" }))
      started = true
    }

    try {
      const fullReply = await hark.chatStream(acct, prompt.full, {
        lastPrompt: prompt.last,
        signal: ac.signal,
        tools: payload.tools,
        toolChoice: payload.tool_choice,
        onChunk: (delta) => {
          text += delta
          if (stream) {
            begin()
            res.write(chunk({ content: delta }))
          }
        },
      })

      const whole = fullReply || text
      const { calls, text: cleanText } = toolNote ? parseCalls(whole, payload.tools) : { calls: [], text: whole }
      const toolCalls = calls.map((c) => ({
        id: `call_${randomUUID().replaceAll("-", "").slice(0, 24)}`,
        type: "function",
        function: c,
      }))
      const finish = toolCalls.length ? "tool_calls" : "stop"

      if (!stream) {
        const message = { role: "assistant", content: toolCalls.length ? cleanText || null : whole }
        if (toolCalls.length) message.tool_calls = toolCalls
        json(res, 200, { id, object: "chat.completion", created, model: MODEL, choices: [{ index: 0, message, finish_reason: finish }] })
        return
      }

      begin()
      if (toolCalls.length) {
        toolCalls.forEach((c, index) => {
          res.write(chunk({ tool_calls: [{ index, id: c.id, type: "function", function: { name: c.function.name, arguments: "" } }] }))
          res.write(chunk({ tool_calls: [{ index, function: { arguments: c.function.arguments } }] }))
        })
      }
      res.write(chunk({}, finish))
      res.end("data: [DONE]\n\n")
    } catch (err) {
      if (err instanceof AuthError) throw new HttpError(401, err.message)
      if (err instanceof QuotaError) throw new HttpError(429, err.message)
      if (!started) throw new HttpError(503, err.message || "engine unavailable")
      res.end(`data: ${JSON.stringify({ error: { message: err.message, type: "engine_error" } })}\n\n`)
    } finally {
      busy.delete(acct.id)
    }
  }

  async function refresh(req, res, meta) {
    const acct = account(req)
    meta.account = acct.id
    try {
      const renewed = typeof hark.renewAccount === "function"
        ? await hark.renewAccount(acct)
        : await renewSession(site, acct.cookies, acct.cookies_exp, { fetchImpl: hark.fetchImpl })
      store.update(acct.id, renewed.cookies, renewed.cookies_exp, renewed.userId)
      json(res, 200, { expires: expiryMs(renewed.cookies_exp) })
    } catch (err) {
      if (err instanceof AuthError) throw new HttpError(401, err.message)
      throw new HttpError(503, err.message)
    }
  }

  const routes = {
    "GET /v1/health": (req, res) => json(res, 200, { ok: true, engine: "hark-web", version: VERSION, accounts: store.count() }),
    "GET /v1/models": (req, res) => {
      authorize(req)
      json(res, 200, {
        object: "list",
        data: [
          { id: MODEL, object: "model", owned_by: "hark.com" },
          { id: "hark-chat", object: "model", owned_by: "hark.com" },
        ],
      })
    },
    "POST /v1/chat/completions": async (req, res, meta) => {
      authorize(req)
      await chat(req, res, meta)
    },
    "POST /v1/session/refresh": async (req, res, meta) => {
      authorize(req)
      await refresh(req, res, meta)
    },
    "GET /v1/usage": async (req, res, meta) => {
      authorize(req)
      const acct = account(req)
      meta.account = acct.id
      let u = hark.usageOf(acct.id)
      if (!u || Date.now() - u.at > USAGE_STALE_MS) {
        u = await hark.readUsage(acct, { maxAgeMs: USAGE_STALE_MS })
      }
      const expires = expiryMs(acct.cookies_exp)
      json(res, 200, {
        plan: `${u?.plan || "Hark"} · 已就绪`,
        windows: u?.windows || [],
        ...(acct.label ? { user: acct.label } : {}),
        ...(expires ? { until: new Date(expires).toISOString() } : {}),
      })
    },
    "POST /v1/shutdown": (req, res) => {
      authorize(req)
      json(res, 200, { ok: true })
      res.once("finish", () => onShutdown())
    },
    "POST /v1/login": async (req, res) => {
      authorize(req)
      const id = await logins.start()
      json(res, 200, { id, url: `http://127.0.0.1:${port}/login/${id}` })
    },
    "POST /v1/import": async (req, res, meta) => {
      authorize(req)
      const payload = await body(req)
      let saved
      try {
        saved = await importSession({
          cookieString: payload.cookieString,
          cdpPort: payload.cdpPort,
          site,
          store,
          fetchImpl: hark.fetchImpl,
        })
      } catch (err) {
        throw new HttpError(400, err.message)
      }
      meta.account = saved.handle
      if (saved.changed) await hark.closeAccount?.(saved.handle).catch(() => {})
      json(res, 200, { ok: true, account: saved })
    },
  }

  const server = http.createServer(async (req, res) => {
    const t0 = Date.now()
    onActivity()
    const url = new URL(req.url, "http://127.0.0.1")
    const meta = { account: "", session: "", reason: "", timing: "" }
    try {
      const route = routes[`${req.method} ${url.pathname}`]
      let m
      if (route) await route(req, res, meta)
      else if (req.method === "GET" && (m = url.pathname.match(/^\/v1\/login\/([\w-]+)$/))) {
        authorize(req)
        const state = logins.get(m[1])
        if (!state) throw new HttpError(404, "no such login")
        json(res, 200, state)
      } else if (req.method === "GET" && (m = url.pathname.match(/^\/login\/([\w-]+)$/))) {
        const html = loginPage(logins.get(m[1]))
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" })
        res.end(html)
      } else throw new HttpError(404, "not found")
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500
      meta.reason = err.message
      if (!res.headersSent) fail(res, status, err.message)
      else res.end()
    } finally {
      onActivity()
      const at = new Date().toTimeString().slice(0, 8)
      const who = meta.account ? ` account=${meta.account}` : ""
      const ses = meta.session ? ` session=${meta.session.slice(0, 12)}` : ""
      log(`${at} ${res.statusCode} ${req.method} ${url.pathname}${who}${ses} ${Date.now() - t0}ms${meta.reason ? ` reason=${meta.reason}` : ""}`)
    }
  })

  server.requestTimeout = 0
  server.headersTimeout = 30_000
  return server
}
