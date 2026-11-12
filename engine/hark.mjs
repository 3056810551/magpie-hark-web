// Drives hark.com's web chat for one named account at a time per page.
import { randomUUID } from "node:crypto"
import { CDP } from "./cdp.mjs"
import { launchBrowser } from "./browser.mjs"

export const ESSENTIAL = ["__Secure-hark.session_token"]

export class AuthError extends Error {}
export class GenerationError extends Error {}
export class QuotaError extends GenerationError {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36"

export function cookieHeader(cookies) {
  return Object.entries(cookies || {}).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join("; ")
}

export function parseSetCookies(lines, now = Date.now()) {
  const cookies = {}
  const exp = {}
  for (const line of lines || []) {
    const [pair, ...attrs] = String(line).split(";")
    const at = pair.indexOf("=")
    if (at <= 0) continue
    const name = pair.slice(0, at).trim()
    const value = pair.slice(at + 1).trim()
    if (value) cookies[name] = value
    for (const attr of attrs) {
      const [k, ...rest] = attr.split("=")
      const key = k.trim().toLowerCase()
      const v = rest.join("=").trim()
      if (key === "max-age" && /^-?\d+$/.test(v)) exp[name] = Math.floor(now / 1000) + Number(v)
      else if (key === "expires" && !(name in exp)) {
        const t = Date.parse(v)
        if (Number.isFinite(t)) exp[name] = Math.floor(t / 1000)
      }
    }
  }
  return { cookies, exp }
}

export function expiryMs(exp) {
  const pos = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 0)
  const vals = Object.values(exp || {}).map(pos).filter(Boolean)
  return vals.length ? Math.min(...vals) * 1000 : Date.now() + 30 * 86_400_000
}

export async function renewSession(site, cookies, expires, { fetchImpl = fetch } = {}) {
  let cur = { ...(cookies || {}) }
  const exp = { ...(expires || {}) }
  const headers = {
    "user-agent": UA,
    origin: site,
    referer: `${site}/chat`,
    "sec-fetch-site": "same-origin",
    "sec-fetch-mode": "cors",
    "sec-fetch-dest": "empty",
    cookie: cookieHeader(cur),
  }
  let res
  try {
    res = await fetchImpl(`${site}/api/auth/get-session`, { headers, redirect: "manual", signal: AbortSignal.timeout(12_000) })
  } catch (err) {
    throw new GenerationError(`/api/auth/get-session 网络请求失败 (${err?.name || "Error"})；请检查网络或代理`)
  }
  if (res.status === 401) throw new AuthError("会话认证失败 (/api/auth/get-session HTTP 401)，需要重新登录")
  if (res.status !== 200) {
    throw new GenerationError(`/api/auth/get-session HTTP ${res.status}：上游请求未成功`)
  }
  let body
  try {
    body = await res.json()
  } catch {
    throw new GenerationError("/api/auth/get-session 返回的不是 JSON；会话状态未确认")
  }
  if (!body || !body.user) {
    throw new GenerationError("/api/auth/get-session 没有返回有效会话；请在官网检查账号状态")
  }
  const set = parseSetCookies(typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [])
  cur = { ...cur, ...set.cookies }
  Object.assign(exp, set.exp)
  const user = body.user || {}
  const session = body.session || {}
  const label = user.name ? `${user.name}${user.email ? ` (${user.email})` : ""}` : (user.email || user.id || "Hark 用户")
  const expAt = session.expiresAt ? Date.parse(session.expiresAt) : expiryMs(exp)
  return {
    cookies: cur,
    cookies_exp: exp,
    label,
    userId: user.id || "",
    expiresAt: Number.isFinite(expAt) ? expAt : Date.now() + 30 * 86_400_000,
  }
}

export async function fetchBillingSummary(site, cookies, { fetchImpl = fetch } = {}) {
  const headers = {
    "user-agent": UA,
    origin: site,
    referer: `${site}/chat`,
    "sec-fetch-site": "same-origin",
    "sec-fetch-mode": "cors",
    "sec-fetch-dest": "empty",
    cookie: cookieHeader(cookies),
  }
  try {
    const res = await fetchImpl(`${site}/api/billing/summary`, { headers, signal: AbortSignal.timeout(10_000) })
    if (res.ok) return await res.json()
  } catch {}
  return null
}

export function usageCard(summary) {
  if (!summary) return { plan: "Hark", windows: [] }
  const planName = summary.plan?.name || "Hark"
  const windows = []
  const ht = summary.meters?.harkTokens
  if (ht) {
    if (typeof ht.dailyLimit === "number" && ht.dailyLimit > 0) {
      windows.push({
        name: "每日 Token",
        used: Math.max(0, Math.min(100, Math.round(((ht.dailyUsed || 0) / ht.dailyLimit) * 100))),
        ...(ht.dailyResetsAt ? { resetsAt: ht.dailyResetsAt } : {}),
        display: `${Math.round((ht.dailyUsed || 0) / 1000)}k / ${Math.round(ht.dailyLimit / 1000)}k tokens`,
      })
    }
    if (typeof ht.poolLimit === "number" && ht.poolLimit > 0) {
      windows.push({
        name: "周期额度池",
        used: Math.max(0, Math.min(100, Math.round(((ht.poolUsed || 0) / ht.poolLimit) * 100))),
        ...(ht.poolResetsAt ? { resetsAt: ht.poolResetsAt } : {}),
        display: `${Math.round((ht.poolUsed || 0) / 1000)}k / ${Math.round(ht.poolLimit / 1000)}k tokens`,
      })
    }
  }
  return { plan: planName, windows }
}

const READY_JS = `(function(){
  if (document.readyState !== 'complete') return 'loading';
  var ta = document.querySelector('textarea');
  if (!ta) return 'no-ta';
  return 'ready';
})()`

const SETTER_JS = (text) => `(function(t){
  var ta = document.querySelector('textarea');
  if (!ta) return 0;
  ta.focus();
  var s = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
  s.call(ta, t);
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  ta.dispatchEvent(new Event('change', { bubbles: true }));
  return (ta.value || '').length;
})(${JSON.stringify(text)})`

const SEND_BUTTON_JS = `(function(){
  var btn = document.querySelector('[data-testid="send-button"]')
    || document.querySelector('[data-composer-send="true"]')
    || Array.from(document.querySelectorAll('button')).find(function(b){
      return /发送|send/i.test(b.getAttribute('aria-label') || '') || /发送|send/i.test(b.innerText || '');
    });
  if (!btn) return 'no-button';
  if (btn.disabled) return 'disabled';
  btn.click();
  return 'clicked';
})()`

const POLL_JS = `(function(){
  var scroller = document.querySelector('[data-testid="message-list"]') || document.body;
  if (scroller && scroller.scrollHeight > scroller.clientHeight + 40) {
    scroller.scrollTop = scroller.scrollHeight;
  }
  var list = document.querySelector('[data-testid="message-list"]');
  if (!list) return JSON.stringify({ cnt: 0, txt: '', streaming: false, done: false });
  
  var entries = Array.from(list.querySelectorAll('[data-entry-kind="message"]'));
  
  // Find the latest user message in the list
  var lastUserIdx = -1;
  for (var i = entries.length - 1; i >= 0; i--) {
    if (entries[i].querySelector('._151xtfxe')) {
      lastUserIdx = i;
      break;
    }
  }
  
  // Only look for bot messages AFTER the latest user message
  var botEntries = [];
  if (lastUserIdx !== -1) {
    for (var j = lastUserIdx + 1; j < entries.length; j++) {
      var isBot = !!entries[j].querySelector('._151xtfxi') || !!entries[j].querySelector('._151xtfxf') || !entries[j].querySelector('._151xtfxe');
      if (isBot) botEntries.push(entries[j]);
    }
  } else {
    botEntries = entries.filter(function(e) {
      return !!e.querySelector('._151xtfxi') || !!e.querySelector('._151xtfxf');
    });
  }
  
  var lastBot = botEntries.length ? botEntries[botEntries.length - 1] : null;
  var bubble = lastBot ? lastBot.querySelector('[data-testid="message-bubble"]') : null;
  var textEl = lastBot ? (lastBot.querySelector('[data-testid="message-text"]') || lastBot) : null;
  
  var kind = bubble ? (bubble.getAttribute('data-bubble-kind') || '') : '';
  var streaming = kind === 'streaming' || (!lastBot && lastUserIdx !== -1);
  var txt = textEl ? (textEl.innerText || '').trim() : '';
  
  var sendBtn = document.querySelector('[data-testid="send-button"]');
  var aria = sendBtn ? (sendBtn.getAttribute('aria-label') || '') : '';
  var btnBusy = sendBtn ? (sendBtn.getAttribute('aria-busy') === 'true' || sendBtn.disabled) : false;
  
  var done = !!(lastBot && !streaming && (kind === 'text' || (aria === '开始听写' && txt.length > 0) || (!btnBusy && txt.length > 0)));
  
  return JSON.stringify({
    cnt: botEntries.length,
    txt: txt,
    streaming: streaming,
    done: done,
    kind: kind
  });
})()`

const SIGNED_OUT_CHECK_JS = `(function(){
  if (window.location.pathname.startsWith('/login') || window.location.pathname.startsWith('/sign-in')) return true;
  if (!document.querySelector('textarea') && !document.querySelector('[data-testid="message-list"]')) return true;
  return false;
})()`
const ZERO_WIDTH = /[\u200b-\u200d\u2060\ufeff]/g
const UNSETTLED_TAIL = /(^|\n)[ \t]*(?:[-*+>#]+|\d+[.)]|`{1,3})?[ \t]*$/

export function settle(sent, txt, final = false) {
  let t = txt.replace(ZERO_WIDTH, "")
  if (!final) {
    const m = t.match(UNSETTLED_TAIL)
    if (m) t = t.slice(0, m.index + m[1].length)
  }
  if (t.startsWith(sent)) return { delta: t.slice(sent.length), sent: t }
  if (t.length <= sent.length) return { delta: "", sent }
  let i = 0
  while (sent[i] === t[i]) i++
  return { delta: t.slice(i), sent: t }
}

const VERIFY_PROMPT = "连通测试，请只回复：OK"

export class Hark {
  constructor({
    site = "https://hark.com",
    executable,
    profileDir,
    headless = true,
    hidden = false,
    proxy = "",
    connectPort = null,
    fetchImpl = fetch,
    firstTokenMs = 90_000,
    chatTimeoutMs = 300_000,
    loadMs = 30_000,
    onCookies = () => {},
    onLost = () => {},
  }) {
    this.site = site.replace(/\/+$/, "")
    this.host = new URL(this.site).hostname
    this.opts = { executable, profileDir, headless, hidden, proxy, connectPort }
    this.fetchImpl = fetchImpl
    this.firstTokenMs = firstTokenMs
    this.chatTimeoutMs = chatTimeoutMs
    this.loadMs = loadMs
    this.onCookies = onCookies
    this.onLost = onLost
    this.accounts = new Map()
    this.usage = new Map()
    this.reading = new Map()
    this.started = null
  }

  usageOf(accountId) {
    return this.usage.get(accountId) || null
  }

  async readUsage(account, { maxAgeMs = 0 } = {}) {
    const had = this.usage.get(account.id)
    if (had && Date.now() - had.at < maxAgeMs) return had
    if (this.reading.has(account.id)) return this.reading.get(account.id)
    const run = (async () => {
      try {
        const summary = await fetchBillingSummary(this.site, account.cookies, { fetchImpl: this.fetchImpl })
        if (summary) {
          const card = { at: Date.now(), user: account.label || "", ...usageCard(summary) }
          this.usage.set(account.id, card)
          return card
        }
      } catch {}
      return had || { at: Date.now(), user: account.label || "", plan: "Hark", windows: [] }
    })().finally(() => this.reading.delete(account.id))
    this.reading.set(account.id, run)
    return run
  }

  async start() {
    if (this.started) return this.started
    this.started = (async () => {
      const b = await launchBrowser({
        executable: this.opts.executable,
        profileDir: this.opts.profileDir,
        headless: this.opts.headless,
        hidden: this.opts.hidden,
        proxy: this.opts.proxy,
        connectPort: this.opts.connectPort,
      })
      b.browser.onClose(() => {
        this.started = null
        this.accounts.clear()
        this.onLost("closed")
      })
      return b
    })()
    return this.started
  }

  async close() {
    const s = this.started
    this.started = null
    if (!s) return
    const b = await s.catch(() => null)
    await b?.close()
  }

  acct(accountId) {
    let a = this.accounts.get(accountId)
    if (!a) {
      a = { contextId: null, home: null, currentSession: null, lastRenew: 0, busy: false }
      this.accounts.set(accountId, a)
    }
    return a
  }

  async closeAccount(accountId) {
    const a = this.accounts.get(accountId)
    if (!a) return
    if (a.home) {
      a.home.page.close()
      a.home = null
    }
    if (a.contextId) {
      const { browser } = await this.start()
      await browser.send("Target.disposeBrowserContext", { browserContextId: a.contextId }).catch(() => {})
      a.contextId = null
    }
  }

  async setCookies(browser, contextId, cookies, expires) {
    const now = Date.now() / 1000
    const secure = this.site.startsWith("https:")
    for (const [name, value] of Object.entries(cookies || {})) {
      if (!value) continue
      const e = Number(expires?.[name])
      const at = Number.isFinite(e) && e > now + 3600 ? e : now + 30 * 86400
      for (const domain of [`.${this.host}`, this.host]) {
        await browser.send("Storage.setCookies", {
          browserContextId: contextId,
          cookies: [{ name, value, domain, path: "/", secure, expires: at }],
        }).catch(() => {})
      }
    }
  }

  async ensurePage(account) {
    const a = this.acct(account.id)
    const { browser, port } = await this.start()
    if (!a.contextId) {
      const ctx = await browser.send("Target.createBrowserContext", { disposeOnDetach: false })
      a.contextId = ctx.browserContextId
      await this.setCookies(browser, a.contextId, account.cookies, account.cookies_exp)
    }
    if (a.home && !a.home.page.closed) return a.home

    const { targetId } = await browser.send("Target.createTarget", {
      url: "about:blank",
      browserContextId: a.contextId,
    })
    const page = await CDP.connect(`ws://127.0.0.1:${port}/devtools/page/${targetId}`, { timeoutMs: 180_000 })
    await Promise.all([
      page.send("Page.enable"),
      page.send("Runtime.enable"),
      page.send("Network.enable"),
      page.send("Page.bringToFront"),
    ])

    await page.send("Page.navigate", { url: `${this.site}/chat` })

    const startWait = Date.now()
    let ready = false
    while (Date.now() - startWait < this.loadMs) {
      const state = await page.js(READY_JS).catch(() => "")
      if (state === "ready") {
        ready = true
        break
      }
      await sleep(500)
    }

    if (!ready) {
      const isSignedOut = await page.js(SIGNED_OUT_CHECK_JS).catch(() => false)
      if (isSignedOut) throw new AuthError("检测到未登录状态，需要重新登录")
      throw new GenerationError("Hark 页面加载超时（输入框未就绪）")
    }

    a.home = { page, targetId }
    return a.home
  }

  async verify(account) {
    const prompt = VERIFY_PROMPT
    let reply = ""
    await this.chatStream(account, prompt, {
      signal: AbortSignal.timeout(60_000),
      onChunk: (delta) => { reply += delta },
    })
    if (!reply.trim()) throw new Error("Hark 账号没有回复测试消息")
    return reply.trim()
  }

  async warm(account) {
    await this.ensurePage(account)
  }

  async chatStream(account, prompt, { signal, onChunk, tools, toolChoice } = {}) {
    const a = this.acct(account.id)
    if (a.busy) throw new GenerationError("账号正忙 (maxConcurrency: 1)")
    a.busy = true
    try {
      const { page } = await this.ensurePage(account)
      if (signal?.aborted) throw new Error("aborted")

      // Check signed out
      const isSignedOut = await page.js(SIGNED_OUT_CHECK_JS).catch(() => false)
      if (isSignedOut) throw new AuthError("检测到未登录状态，需要重新登录")

      // Inject text into textarea
      await page.js(SETTER_JS(prompt))
      await sleep(200)

      // Click send button
      let clicked = false
      for (let i = 0; i < 15; i++) {
        const c = await page.js(SEND_BUTTON_JS)
        if (c === "clicked") {
          clicked = true
          break
        }
        await sleep(150)
      }
      if (!clicked) {
        // Fallback: send Enter key
        for (const type of ["keyDown", "keyUp"]) {
          await page.send("Input.dispatchKeyEvent", {
            type,
            key: "Enter",
            code: "Enter",
            windowsVirtualKeyCode: 13,
            ...(type === "keyDown" ? { text: "\r" } : {}),
          }).catch(() => {})
        }
      }

      let sent = ""
      const start = Date.now()
      let firstTokenReceived = false

      while (Date.now() - start < this.chatTimeoutMs) {
        if (signal?.aborted) throw new Error("aborted")
        await sleep(250)

        const raw = await page.js(POLL_JS).catch(() => null)
        if (!raw) continue

        let poll
        try {
          poll = JSON.parse(raw)
        } catch {
          continue
        }

        if (poll.txt) {
          if (!firstTokenReceived) firstTokenReceived = true
          const s = settle(sent, poll.txt, poll.done)
          if (s.delta) {
            sent = s.sent
            onChunk?.(s.delta)
          }
        } else if (!firstTokenReceived && Date.now() - start > this.firstTokenMs) {
          const isSignedOut = await page.js(SIGNED_OUT_CHECK_JS).catch(() => false)
          if (isSignedOut) throw new AuthError("Hark 登录已失效")
          throw new GenerationError("Hark 首字响应超时")
        }

        if (poll.done) {
          // Send any remaining tail
          const s = settle(sent, poll.txt, true)
          if (s.delta) onChunk?.(s.delta)
          break
        }
      }

      return sent
    } finally {
      a.busy = false
    }
  }
}
