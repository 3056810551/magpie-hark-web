// Sign-in in a visible browser window.
import { randomBytes } from "node:crypto"
import { rmSync } from "node:fs"
import path from "node:path"
import { launchBrowser } from "./browser.mjs"
import { ESSENTIAL, renewSession } from "./hark.mjs"

export function noDesktop(platform = process.platform, env = process.env) {
  return platform === "linux" && !env.DISPLAY && !env.WAYLAND_DISPLAY
}

export class Logins {
  constructor({
    site,
    executable,
    dir,
    proxy = "",
    fetchImpl = fetch,
    everyMs = 2000,
    limitMs = 15 * 60_000,
    headless = false,
    onDone,
  }) {
    this.site = site.replace(/\/+$/, "")
    this.host = new URL(this.site).hostname
    Object.assign(this, { executable, dir, proxy, fetchImpl, everyMs, limitMs, headless, onDone })
    this.runs = new Map()
  }

  stopAll() {
    for (const run of this.runs.values()) run.stop?.()
  }

  async cookies(browser) {
    const list = await browser.send("Storage.getCookies").catch(() => ({ cookies: [] }))
    const cookies = {}
    const exp = {}
    for (const c of list.cookies || []) {
      if (c.domain && (c.domain === this.host || c.domain.endsWith(`.${this.host}`))) {
        cookies[c.name] = c.value
        if (Number.isFinite(c.expires) && c.expires > 0) exp[c.name] = c.expires
      }
    }
    return { cookies, exp }
  }

  async start() {
    const id = randomBytes(9).toString("base64url")
    const profileDir = path.join(this.dir, id)
    const run = { status: "starting" }
    this.runs.set(id, run)

    if (!this.headless && noDesktop()) {
      Object.assign(run, {
        status: "failed",
        error: "这台 Linux 没有图形桌面（DISPLAY / WAYLAND_DISPLAY 都没设），弹不出登录窗口；请在有桌面的会话里登录",
      })
      return id
    }

    let opened
    try {
      opened = await launchBrowser({
        executable: this.executable,
        profileDir,
        headless: this.headless,
        proxy: this.proxy,
        url: `${this.site}/chat`,
      })
    } catch (err) {
      Object.assign(run, { status: "failed", error: `打不开浏览器: ${err.message}` })
      return id
    }

    run.status = "pending"
    run.step = "等你在窗口里登录 Hark"

    let closed = false
    const close = () => {
      if (closed) return
      closed = true
      clearInterval(timer)
      opened.close().then(() => rmSync(profileDir, { recursive: true, force: true, maxRetries: 3 })).catch(() => {})
    }

    const finish = (fields) => {
      if (run.status !== "pending") return
      Object.assign(run, fields)
      close()
    }

    run.stop = () => finish({ status: "failed", error: "引擎停止了，登录没有完成" })
    opened.proc?.on("exit", () => {
      if (!closed) finish({ status: "failed", error: "登录窗口在登录完成前被关掉了" })
    })

    const started = Date.now()
    let busy = false
    const timer = setInterval(async () => {
      if (busy || run.status !== "pending") return
      if (Date.now() - started > this.limitMs) return finish({ status: "failed", error: "登录超时" })
      busy = true
      try {
        const got = await this.cookies(opened.browser)
        if (ESSENTIAL.every((n) => got.cookies[n])) {
          run.step = "正在向 Hark 确认会话"
          const renewed = await renewSession(this.site, got.cookies, got.exp, {
            fetchImpl: this.fetchImpl,
            getPage: async () => {
              const { targetInfos } = await opened.browser.send("Target.getTargets").catch(() => ({ targetInfos: [] }))
              const tgt = (targetInfos || []).find((t) => t.type === "page" && String(t.url || "").startsWith(this.site))
              if (!tgt) return null
              const ses = await opened.browser.attach(tgt.targetId, { timeoutMs: 15_000 })
              await ses.send("Network.enable").catch(() => {})
              return { page: ses, release: () => ses.close() }
            },
          })
          close()
          run.step = "已确认会话，正在保存账号"
          try {
            const saved = await this.onDone(renewed.cookies, renewed.cookies_exp, renewed.label, renewed.userId)
            finish({ status: "done", handle: saved.handle, expires: saved.expires, label: saved.label })
          } catch (err) {
            finish({ status: "failed", error: err.message })
          }
        }
      } catch (err) {
        // Ignored while waiting
      } finally {
        busy = false
      }
    }, this.everyMs)

    return id
  }

  get(id) {
    return this.runs.get(id) || null
  }
}
