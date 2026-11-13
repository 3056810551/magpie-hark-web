// Helper to import Hark session from an already logged-in Chrome or raw cookie string.
import path from "node:path"
import { dataDir } from "./paths.mjs"
import { Store, parseCookieString } from "./store.mjs"
import { renewSession } from "./hark.mjs"
import { findExistingBrowser } from "./browser.mjs"

async function openCDPConnection(port, site = "https://hark.com") {
  const found = await findExistingBrowser({ connectPort: port })
  if (!found) {
    throw new Error(port ? `No Chrome debugging port reachable at 127.0.0.1:${port}` : "未检测到可复用的 Chrome 远程调试端口")
  }
  const { browser, source } = found
  try {
    const list = await browser.send("Storage.getCookies").catch(() => ({ cookies: [] }))
    const cookies = {}
    const exp = {}
    const host = new URL(site).hostname
    const sorted = [...(list.cookies || [])].sort((a, b) => (a.domain === host ? 1 : 0) - (b.domain === host ? 1 : 0))
    for (const c of sorted) {
      if (c.domain && (c.domain === host || c.domain.endsWith(`.${host}`))) {
        cookies[c.name] = c.value
        if (Number.isFinite(c.expires) && c.expires > 0) exp[c.name] = c.expires
      }
    }
    if (!cookies["__Secure-hark.session_token"]) {
      throw new Error(`Chrome (${source}) 上没有找到 Hark 的登录会话 (__Secure-hark.session_token)`)
    }
    return {
      cookies,
      exp,
      getPage: async () => {
        const { targetInfos } = await browser.send("Target.getTargets").catch(() => ({ targetInfos: [] }))
        const tgt = (targetInfos || []).find((t) => t.type === "page" && String(t.url || "").startsWith(site))
        if (!tgt) return null
        const ses = await browser.attach(tgt.targetId, { timeoutMs: 15_000 })
        await ses.send("Network.enable").catch(() => {})
        return { page: ses, release: () => ses.close() }
      },
      close: () => browser.close(),
    }
  } catch (err) {
    browser.close()
    throw err
  }
}

export async function importFromCDP(port, site = "https://hark.com") {
  const conn = await openCDPConnection(port, site)
  conn.close()
  return { cookies: conn.cookies, exp: conn.exp }
}

export async function importSession({
  cookieString,
  cdpPort,
  site = "https://hark.com",
  store = null,
  fetchImpl = fetch,
} = {}) {
  let sessionData
  let closer = null
  if (cookieString) {
    sessionData = parseCookieString(cookieString)
  } else if (cdpPort) {
    sessionData = await openCDPConnection(cdpPort, site)
    closer = sessionData.close
  } else {
    try {
      sessionData = await openCDPConnection(undefined, site)
      closer = sessionData.close
    } catch {
      throw new Error("请提供 Cookie 字符串，或确保 Chrome 开启了远程调试 (chrome://inspect/#remote-debugging)")
    }
  }

  let renewed
  try {
    renewed = await renewSession(site, sessionData.cookies, sessionData.exp, {
      fetchImpl,
      getPage: sessionData.getPage || null,
    })
  } finally {
    closer?.()
  }
  const targetStore = store || new Store(path.join(dataDir(), "accounts.json"))
  const saved = targetStore.add(renewed.cookies, renewed.cookies_exp, renewed.label, renewed.userId)
  return saved
}

if (process.argv[1]?.endsWith("import-chrome.mjs")) {
  const arg = process.argv[2]
  const port = /^\d+$/.test(arg) ? Number(arg) : undefined
  const cookieString = !port && arg ? arg : undefined

  importSession({ cookieString, cdpPort: port })
    .then((saved) => {
      console.log(`✅ 成功导入 Hark 账号！`)
      console.log(`账号标识: ${saved.handle}`)
      console.log(`用户名称: ${saved.label}`)
      console.log(`有效期至: ${new Date(saved.expires).toLocaleString()}`)
    })
    .catch((err) => {
      console.error(`❌ 导入失败: ${err.message}`)
      process.exit(1)
    })
}
