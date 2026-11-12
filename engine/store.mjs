// Accounts kept by the engine: handle → {cookies, cookies_exp, label, userId, created}.
import { existsSync, readFileSync } from "node:fs"
import { randomBytes } from "node:crypto"
import { expiryMs } from "./hark.mjs"
import { writePrivate } from "./paths.mjs"

export function parseCookieString(raw) {
  const cookies = {}
  const exp = {}
  if (!raw || typeof raw !== "string") return { cookies, exp }
  const s = raw.startsWith("cookie:") ? raw.slice(7) : raw
  const pairs = s.split(";")
  const defaultExp = Math.floor(Date.now() / 1000) + 30 * 86400
  for (const part of pairs) {
    const at = part.indexOf("=")
    if (at <= 0) continue
    const name = part.slice(0, at).trim()
    const val = part.slice(at + 1).trim()
    if (name && val) {
      cookies[name] = val
      exp[name] = defaultExp
    }
  }
  return { cookies, exp }
}

export class Store {
  constructor(file) {
    this.file = file
    this.accounts = {}
    if (existsSync(file)) {
      try {
        const raw = JSON.parse(readFileSync(file, "utf8"))
        if (raw && typeof raw === "object" && !Array.isArray(raw)) this.accounts = raw
      } catch {}
    }
  }

  get(handle) {
    const item = this.accounts[handle]
    return item?.cookies ? {
      id: handle,
      label: item.label || "",
      userId: item.userId || "",
      cookies: item.cookies,
      cookies_exp: item.cookies_exp || {},
      created: item.created || 0,
    } : null
  }

  handles() {
    return Object.keys(this.accounts)
  }

  count() {
    return Object.keys(this.accounts).length
  }

  save() {
    writePrivate(this.file, JSON.stringify(this.accounts, null, 2) + "\n")
  }

  add(cookies, exp = {}, label = "", userId = "") {
    const known = userId && Object.keys(this.accounts).find((h) => this.accounts[h].userId === userId)
    if (known) {
      this.accounts[known] = {
        ...this.accounts[known],
        cookies,
        cookies_exp: exp || {},
        ...(label ? { label } : {}),
        userId,
      }
      this.save()
      return { handle: known, expires: expiryMs(exp), label: this.accounts[known].label, again: true }
    }
    const handle = `hark-${randomBytes(6).toString("hex")}`
    const created = Date.now()
    const name = label || `Hark ${new Date(created).toLocaleString("sv-SE").slice(0, 16)} 登录`
    this.accounts[handle] = { cookies, cookies_exp: exp || {}, label: name, created, userId }
    this.save()
    return { handle, expires: expiryMs(exp), label: name }
  }

  update(handle, cookies, exp = {}, userId = "") {
    if (!this.accounts[handle]) return
    this.accounts[handle] = {
      ...this.accounts[handle],
      cookies,
      cookies_exp: exp || {},
      ...(userId ? { userId } : {}),
    }
    this.save()
  }

  remove(handle) {
    if (!this.accounts[handle]) return
    delete this.accounts[handle]
    this.save()
  }
}
