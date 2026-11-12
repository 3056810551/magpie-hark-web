// Helper to import Hark session from an already logged-in Chrome or raw cookie string.
import path from "node:path"
import { dataDir } from "./paths.mjs"
import { Store, parseCookieString } from "./store.mjs"
import { renewSession } from "./hark.mjs"
import { CDP, httpJSON } from "./cdp.mjs"

export async function importFromCDP(port = 9222, site = "https://hark.com") {
  const version = await httpJSON(`http://127.0.0.1:${port}/json/version`, 3000)
  if (!version?.webSocketDebuggerUrl) throw new Error(`No Chrome debugging port reachable at 127.0.0.1:${port}`)
  const browser = await CDP.connect(version.webSocketDebuggerUrl)
  try {
    const list = await browser.send("Storage.getCookies").catch(() => ({ cookies: [] }))
    const cookies = {}
    const exp = {}
    const host = new URL(site).hostname
    for (const c of list.cookies || []) {
      if (c.domain && (c.domain === host || c.domain.endsWith(`.${host}`))) {
        cookies[c.name] = c.value
        if (Number.isFinite(c.expires) && c.expires > 0) exp[c.name] = c.expires
      }
    }
    if (!cookies["__Secure-hark.session_token"]) {
      throw new Error(`Chrome 在 127.0.0.1:${port} 上没有找到 Hark 的登录会话 (__Secure-hark.session_token)`)
    }
    return { cookies, exp }
  } finally {
    browser.close()
  }
}

export async function importSession({ cookieString, cdpPort, site = "https://hark.com" }) {
  let sessionData
  if (cookieString) {
    sessionData = parseCookieString(cookieString)
  } else if (cdpPort) {
    sessionData = await importFromCDP(cdpPort, site)
  } else {
    // Try probing common debug ports 9222
    try {
      sessionData = await importFromCDP(9222, site)
    } catch {
      throw new Error("请提供 Cookie 字符串，或确保 Chrome 以 --remote-debugging-port 启动")
    }
  }

  const renewed = await renewSession(site, sessionData.cookies, sessionData.exp)
  const dir = dataDir()
  const store = new Store(path.join(dir, "accounts.json"))
  const saved = store.add(renewed.cookies, renewed.cookies_exp, renewed.label, renewed.userId)
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
