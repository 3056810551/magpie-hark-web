// Helper to import Hark session from an already logged-in Chrome or raw cookie string.
import path from "node:path"
import { dataDir } from "./paths.mjs"
import { Store, parseCookieString } from "./store.mjs"
import { renewSession } from "./hark.mjs"
import { findExistingBrowser } from "./browser.mjs"

export async function importFromCDP(port, site = "https://hark.com") {
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
    for (const c of list.cookies || []) {
      if (c.domain && (c.domain === host || c.domain.endsWith(`.${host}`))) {
        cookies[c.name] = c.value
        if (Number.isFinite(c.expires) && c.expires > 0) exp[c.name] = c.expires
      }
    }
    if (!cookies["__Secure-hark.session_token"]) {
      throw new Error(`Chrome (${source}) 上没有找到 Hark 的登录会话 (__Secure-hark.session_token)`)
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
    try {
      sessionData = await importFromCDP(undefined, site)
    } catch {
      throw new Error("请提供 Cookie 字符串，或确保 Chrome 开启了远程调试 (chrome://inspect/#remote-debugging)")
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
