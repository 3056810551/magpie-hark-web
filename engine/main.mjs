// Hark Web Engine process.
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs"
import path from "node:path"
import { findBrowser } from "./browser.mjs"
import { Logins } from "./login.mjs"
import { Hark, QuotaError } from "./hark.mjs"
import { proxiedFetch, resolveProxy } from "./net.mjs"
import { watchParent } from "./parent.mjs"
import { dataDir, engineKey, enginePort } from "./paths.mjs"
import { createServer, VERSION } from "./server.mjs"
import { Store } from "./store.mjs"

const env = process.env
const dir = dataDir(env)
mkdirSync(dir, { recursive: true })
const logFile = path.join(dir, "engine.log")

function log(line) {
  process.stderr.write(line + "\n")
  try {
    if (statSync(logFile, { throwIfNoEntry: false })?.size > 5 << 20) renameSync(logFile, `${logFile}.1`)
    appendFileSync(logFile, line + "\n")
  } catch {}
}

const masked = (url) => String(url).replace(/\/\/[^@/]+@/, "//***@")
const key = engineKey(dir)
const port = enginePort(env)
const site = (env.HARK_WEB_SITE || "https://hark.com").replace(/\/+$/, "")
const proxy = resolveProxy(env)
const fetchImpl = proxiedFetch(proxy)
const executable = findBrowser(env)
const mode = ["headless", "hidden", "show"].includes(env.HARK_WEB_BROWSER) ? env.HARK_WEB_BROWSER : "headless"
const idleMs = (Number(env.HARK_WEB_IDLE_MIN) || 60) * 60_000
const verifyLogin = env.HARK_WEB_VERIFY_LOGIN !== "0"
const connectPort = env.HARK_WEB_CHROME_PORT ? Number(env.HARK_WEB_CHROME_PORT) : null

const store = new Store(path.join(dir, "accounts.json"))
const hark = new Hark({
  site,
  executable,
  profileDir: path.join(dir, "browser"),
  headless: mode === "headless",
  hidden: mode === "hidden",
  proxy,
  connectPort,
  fetchImpl,
  onCookies: (id, cookies, exp, userId) => store.update(id, cookies, exp, userId),
  onLost: (why) => log(`${new Date().toTimeString().slice(0, 8)} browser lost (${why}) — a new one starts with next request`),
})

const logins = new Logins({
  site,
  executable,
  dir: path.join(dir, "login"),
  proxy,
  fetchImpl,
  headless: env.HARK_WEB_LOGIN_HEADLESS === "1",
  onDone: async (cookies, exp, label, userId) => {
    const saved = store.add(cookies, exp, label, userId)
    if (saved.again) await hark.closeAccount(saved.handle).catch(() => {})
    if (verifyLogin) {
      const t0 = Date.now()
      const at = new Date().toTimeString().slice(0, 8)
      try {
        await hark.verify(store.get(saved.handle))
        log(`${at} verify account=${saved.handle} ${Date.now() - t0}ms`)
      } catch (err) {
        log(`${at} verify account=${saved.handle} failed reason=${err.message}`)
        if (!(err instanceof QuotaError)) {
          if (!saved.again) {
            await hark.closeAccount(saved.handle).catch(() => {})
            store.remove(saved.handle)
          }
          throw new Error(`已登录，但账号没有回答测试消息：${err.message}`)
        }
      }
    }
    return saved
  },
})

let lastUse = Date.now()
const server = createServer({
  hark,
  logins,
  store,
  key,
  port,
  site,
  log,
  onActivity: () => { lastUse = Date.now() },
  onShutdown: () => shutdown("asked to stop"),
})

// Auto close idle browser to save RAM
setInterval(() => {
  if (hark.started && Date.now() - lastUse > idleMs) {
    log(`${new Date().toTimeString().slice(0, 8)} idle — browser closed until next request`)
    hark.close()
  }
}, 60_000).unref()

server.on("error", async (err) => {
  if (err.code === "EADDRINUSE") {
    const other = await fetch(`http://127.0.0.1:${port}/v1/health`).then((r) => r.json()).catch(() => null)
    if (other?.engine === "hark-web") {
      log(`another hark-web engine already serves port ${port}; leaving it running`)
      process.exit(0)
    }
    log(`port ${port} is taken by something else; set HARK_WEB_ENGINE_PORT`)
    process.exit(1)
  }
  log(`engine error: ${err.message}`)
  process.exit(1)
})

server.listen(port, "127.0.0.1", () => {
  log(
    `hark-web engine ${VERSION} listening on http://127.0.0.1:${port} · ${store.count()} accounts · ` +
      `browser ${connectPort ? `CDP port ${connectPort}` : executable ? `${path.basename(executable)} (${mode})` : "not found"} · proxy ${masked(proxy)} · data ${dir}`,
  )
})

async function shutdown(why) {
  log(`${new Date().toTimeString().slice(0, 8)} engine stopping (${why})`)
  logins.stopAll()
  await hark.close().catch(() => {})
  process.exit(0)
}

for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => shutdown(sig))

watchParent(env.HARK_WEB_PARENT_PID, () => shutdown("Magpie exited"))
