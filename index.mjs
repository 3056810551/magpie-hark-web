import { spawn } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { dataDir, enginePort } from "./engine/paths.mjs"
import { VERSION } from "./engine/version.mjs"

const PROVIDER = "hark-web"
const MODEL = "hark"
const CONTROL_TIMEOUT_MS = 10_000
const ENGINE_START_MS = 20_000
const LOGIN_LIMIT_MS = 18 * 60_000
const REFRESH_LEAD_MS = 10 * 60_000
const CONTEXT_TOKENS = 128_000
const OUTPUT_TOKENS = 16_000
const HERE = path.dirname(fileURLToPath(import.meta.url))
const ENGINE_MAIN = path.join(HERE, "engine", "main.mjs")
const ICON = (() => {
  try {
    return `data:image/svg+xml;base64,${readFileSync(path.join(HERE, "icon.svg")).toString("base64")}`
  } catch {
    return ""
  }
})()

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function current(version) {
  if (!version) return false
  const a = version.split(".").map(Number)
  const b = VERSION.split(".").map(Number)
  for (let i = 0; i < 3; i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0)
  return true
}

function originFrom(value) {
  return String(value).trim().replace(/\/+$/, "").replace(/\/v1$/, "")
}

function isOurs(input) {
  const id = input?.model?.providerID || input?.provider?.info?.id || input?.message?.model?.providerID || ""
  return id === PROVIDER || id === `${PROVIDER}-plugin`
}

function handleOf(auth) {
  const value = auth?.type === "api" ? auth.key : auth?.type === "oauth" ? auth.refresh || auth.access : ""
  return typeof value === "string" ? value.trim() : ""
}

function engineHeaders(key, handle) {
  const headers = {}
  if (handle) headers["x-hark-account"] = handle
  if (key) headers.authorization = `Bearer ${key}`
  return headers
}

function structured(windows) {
  return Array.isArray(windows) && windows.length > 0 && windows.every((item) => {
    return item && typeof item.name === "string" && item.name.trim() !== "" && typeof item.used === "number" && item.used >= 0 && item.used <= 100
  })
}

export const HarkWebPlugin = async (_input, options) => {
  const opt = options && typeof options === "object" ? options : {}
  const external = () => Boolean(opt.engine || process.env.HARK_WEB_ENGINE)
  const engineOrigin = () => originFrom(opt.engine || process.env.HARK_WEB_ENGINE || `http://127.0.0.1:${enginePort()}`)
  const engineBaseURL = () => `${engineOrigin()}/v1`
  const engineKey = () => {
    const own = String(opt.key ?? process.env.HARK_WEB_ENGINE_KEY ?? "").trim()
    if (own || external()) return own
    const file = path.join(dataDir(), "engine.key")
    return existsSync(file) ? readFileSync(file, "utf8").trim() : ""
  }

  async function running() {
    try {
      const res = await fetch(`${engineOrigin()}/v1/health`, { signal: AbortSignal.timeout(1500) })
      const body = res.ok ? await res.json() : null
      return body?.engine === "hark-web" ? String(body.version || "?") : ""
    } catch {
      return ""
    }
  }

  async function retire() {
    await fetch(`${engineOrigin()}/v1/shutdown`, {
      method: "POST",
      headers: engineHeaders(engineKey(), ""),
      signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
    }).catch(() => {})
    const end = Date.now() + 8000
    while (Date.now() < end && (await running())) await sleep(250)
  }

  let starting = null
  let checkedAt = 0
  function ensureEngine({ force = false } = {}) {
    if (external()) return Promise.resolve(true)
    if (!force && Date.now() - checkedAt < 30_000) return Promise.resolve(true)
    starting ??= (async () => {
      const version = await running()
      if (current(version)) return true
      if (version) await retire()
      const child = spawn(process.execPath, [ENGINE_MAIN], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        env: { ...process.env, NODE_USE_ENV_PROXY: "1", HARK_WEB_PARENT_PID: String(process.pid) },
      })
      child.on("error", () => {})
      child.unref()
      const end = Date.now() + ENGINE_START_MS
      while (Date.now() < end) {
        await sleep(300)
        if (current(await running())) return true
      }
      return false
    })().then((ok) => {
      if (ok) checkedAt = Date.now()
      starting = null
      return ok
    })
    return starting
  }

  async function control(pathname, method, handle, bodyPayload = null) {
    if (!(await ensureEngine())) return null
    try {
      const headers = engineHeaders(engineKey(), handle)
      if (bodyPayload) headers["content-type"] = "application/json"
      return await fetch(`${engineOrigin()}${pathname}`, {
        method,
        headers,
        ...(bodyPayload ? { body: JSON.stringify(bodyPayload) } : {}),
        signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
      })
    } catch {
      checkedAt = 0
      return null
    }
  }

  async function browserLogin() {
    const res = await control("/v1/login", "POST", "")
    if (!res?.ok) throw new Error(res ? `hark-web 引擎没能开始登录（HTTP ${res.status}）` : "hark-web 引擎没有启动；日志在数据目录的 engine.log")
    const { id, url } = await res.json()
    return {
      url,
      instructions: "在弹出的浏览器窗口里登录 Hark。登录后窗口会自动关闭，引擎再发一条测试消息，账号能回答才算登录成功。",
      method: "auto",
      async callback() {
        const end = Date.now() + LOGIN_LIMIT_MS
        while (Date.now() < end) {
          await sleep(1500)
          const poll = await control(`/v1/login/${id}`, "GET", "")
          if (!poll) continue
          if (!poll.ok) return { type: "failed", error: `hark-web 登录状态读不到（HTTP ${poll.status}）` }
          const state = await poll.json()
          if (state.status === "done") {
            const expires = Number.isFinite(state.expires) ? state.expires : Date.now() + 30 * 86_400_000
            return {
              type: "success",
              refresh: state.handle,
              access: state.handle,
              expires,
              ...(state.label ? { accountId: state.label } : {}),
              ...(state.label?.includes("@") ? { email: state.label } : {}),
            }
          }
          if (state.status === "failed") return { type: "failed", error: `Hark 登录：${state.error || "没有完成"}` }
        }
        return { type: "failed", error: "Hark 登录：没有在时限内完成" }
      },
    }
  }

  if (!external()) ensureEngine().catch(() => {})

  const importedHandles = new Map()
  const importingHandles = new Map()
  async function resolveHandle(raw) {
    if (!raw || !(raw.includes("=") || raw.includes(";"))) return raw
    if (importedHandles.has(raw)) return importedHandles.get(raw)
    if (importingHandles.has(raw)) return importingHandles.get(raw)
    const pending = (async () => {
      const imp = await control("/v1/import", "POST", "", { cookieString: raw })
      if (imp?.ok) {
        const body = await imp.json().catch(() => null)
        if (body?.account?.handle) {
          importedHandles.set(raw, body.account.handle)
          return body.account.handle
        }
      }
      return raw
    })().finally(() => importingHandles.delete(raw))
    importingHandles.set(raw, pending)
    return pending
  }

  return {
    config: async (cfg) => {
      cfg.provider ??= {}
      const was = cfg.provider[PROVIDER] ?? {}
      cfg.provider[PROVIDER] = {
        name: "Hark Web",
        npm: "@ai-sdk/openai-compatible",
        api: engineBaseURL(),
        ...was,
        models: {
          [MODEL]: {
            name: "Hark",
            reasoning: false,
            attachment: false,
            tool_call: true,
            modalities: { input: ["text"], output: ["text"] },
            limit: { context: CONTEXT_TOKENS, output: OUTPUT_TOKENS },
            cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
          },
          "hark-chat": {
            name: "Hark Chat",
            reasoning: false,
            attachment: false,
            tool_call: true,
            modalities: { input: ["text"], output: ["text"] },
            limit: { context: CONTEXT_TOKENS, output: OUTPUT_TOKENS },
            cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
          },
          ...(was.models ?? {}),
        },
      }
    },

    auth: {
      provider: PROVIDER,
      maxConcurrency: 1,
      ...(ICON ? { icon: ICON } : {}),
      refreshLead: REFRESH_LEAD_MS,
      methods: [
        { type: "oauth", label: "hark.com（浏览器登录）", authorize: browserLogin },
        { type: "api", label: "账号 ID 或 Cookie（高级/导入）", placeholder: "hark-xxxxxxxxxxxx 或粘贴 Cookie" },
      ],
      async refresh(auth) {
        const rawHandle = handleOf(auth)
        if (!rawHandle) throw Object.assign(new Error("hark-web account has no engine handle"), { signIn: "expired" })
        const handle = await resolveHandle(rawHandle)
        const res = await control("/v1/session/refresh", "POST", handle)
        if (!res) throw new Error("engine unreachable")
        if (res.status === 401) {
          if (handle !== rawHandle) importedHandles.delete(rawHandle)
          throw Object.assign(new Error("session refused"), { signIn: "expired" })
        }
        if (!res.ok) throw new Error("session refresh unavailable")
        const body = await res.json()
        if (typeof body.expires !== "number" || !Number.isFinite(body.expires)) {
          throw new Error("session refresh returned no expiry")
        }
        return auth?.type === "oauth" ? { access: handle, refresh: handle, expires: body.expires } : { expires: body.expires }
      },
      async usage(getAuth) {
        const rawHandle = handleOf(await getAuth())
        if (!rawHandle) return { error: "hark-web account has no engine handle", signIn: "expired" }
        const handle = await resolveHandle(rawHandle)

        const res = await control("/v1/usage", "GET", handle)
        if (!res) return { error: "engine unreachable" }
        if (res.status === 401) {
          if (handle !== rawHandle) importedHandles.delete(rawHandle)
          return { error: "session refused", signIn: "expired" }
        }
        let body = {}
        try {
          body = await res.json()
        } catch {
          body = {}
        }
        if (!res.ok) return { error: "usage unavailable" }
        const text = (v) => (typeof v === "string" && v.trim() ? v.trim() : "")
        const card = {
          ...(text(body.plan) ? { plan: text(body.plan) } : {}),
          ...(text(body.user) ? { user: text(body.user) } : {}),
          ...(text(body.until) ? { until: text(body.until) } : {}),
        }
        if (structured(body.windows)) return { ...card, windows: body.windows, signIn: "kept" }
        if (card.plan) return { ...card, windows: [], signIn: "kept" }
        return { error: text(body.error) || "no structured quota" }
      },
      async loader(getAuth) {
        return {
          baseURL: engineBaseURL(),
          async fetch(input, init) {
            const auth = await getAuth()
            const rawHandle = handleOf(auth)
            if (!rawHandle) throw Object.assign(new Error("hark-web account has no engine handle"), { signIn: "expired" })
            const handle = await resolveHandle(rawHandle)

            const incoming = new Headers(init?.headers)
            const send = async () => {
              await ensureEngine()
              const headers = new Headers(engineHeaders(engineKey(), handle))
              for (const name of ["content-type", "accept", "x-hark-session"]) {
                const value = incoming.get(name)
                if (value) headers.set(name, value)
              }
              return fetch(input, { method: init?.method, headers, body: init?.body, signal: init?.signal })
            }
            let res
            try {
              res = await send()
            } catch (err) {
              if (external() || init?.signal?.aborted || !(await ensureEngine({ force: true }))) throw err
              res = await send()
            }
            const out = new Headers(res.headers)
            out.delete("content-length")
            if (res.status === 401) {
              if (handle !== rawHandle) importedHandles.delete(rawHandle)
              out.set("x-magpie-sign-in", "expired")
            } else if (res.ok) out.set("x-magpie-sign-in", "kept")
            return new Response(res.body, { status: res.status, statusText: res.statusText, headers: out })
          },
        }
      },
    },

    "chat.headers": async (input, output) => {
      if (!isOurs(input)) return
      if (input.sessionID) output.headers["x-hark-session"] = input.sessionID
    },
  }
}

export default HarkWebPlugin
