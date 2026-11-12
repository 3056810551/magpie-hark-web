// Find and start a Chromium-family browser on macOS, Windows or Linux.
import { spawn } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readlinkSync } from "node:fs"
import { rm } from "node:fs/promises"
import { createServer } from "node:net"
import path from "node:path"
import { CDP, httpJSON } from "./cdp.mjs"

export function browserCandidates(platform = process.platform, env = process.env) {
  if (platform === "darwin") {
    const apps = [
      ["Google Chrome", "Google Chrome"],
      ["Microsoft Edge", "Microsoft Edge"],
      ["Chromium", "Chromium"],
      ["Brave Browser", "Brave Browser"],
    ]
    const roots = ["/Applications", path.join(env.HOME || "", "Applications")]
    return roots.flatMap((root) => apps.map(([app, bin]) => path.join(root, `${app}.app`, "Contents", "MacOS", bin)))
  }
  if (platform === "win32") {
    const roots = [env.PROGRAMFILES, env["PROGRAMFILES(X86)"], env.LOCALAPPDATA].filter(Boolean)
    const rels = [
      ["Google", "Chrome", "Application", "chrome.exe"],
      ["Microsoft", "Edge", "Application", "msedge.exe"],
      ["Chromium", "Application", "chrome.exe"],
      ["BraveSoftware", "Brave-Browser", "Application", "brave.exe"],
    ]
    return rels.flatMap((root) => roots.map((root) => path.win32.join(root, ...rel)))
  }
  const names = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge", "microsoft-edge-stable", "brave-browser"]
  const dirs = (env.PATH || "/usr/bin:/usr/local/bin").split(path.delimiter).concat(["/usr/bin", "/snap/bin", "/opt/google/chrome"])
  return [...new Set(dirs)].flatMap((dir) => names.map((name) => path.join(dir, name))).concat(["/opt/google/chrome/chrome"])
}

export function findBrowser(env = process.env, platform = process.platform, exists = existsSync) {
  const own = (env.HARK_WEB_CHROME || "").trim()
  if (own) return exists(own) ? own : null
  return browserCandidates(platform, env).find((p) => exists(p)) ?? null
}

export function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

export function browserArgs({ port, profileDir, headless, hidden = false, proxy, url = "about:blank" }) {
  const args = [
    `--remote-debugging-port=${port}`,
    "--remote-debugging-address=127.0.0.1",
    "--remote-allow-origins=*",
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-features=OptimizationGuideModelDownloading,OptimizationHintsFetching,OptimizationTargetPrediction,OptimizationHints,Translate,MediaRouter",
    "--disable-sync",
    "--disable-domain-reliability",
    "--disable-dev-shm-usage",
    "--autoplay-policy=no-user-gesture-required",
    "--window-size=1280,900",
    "--proxy-bypass-list=<-loopback>",
    "--use-mock-keychain",
    "--password-store=basic",
  ]
  if (headless) args.push("--headless=new", "--disable-gpu")
  else {
    args.push("--disable-background-mode", "--new-window")
    if (hidden) args.push("--window-position=-32000,-32000")
  }
  if (proxy === "direct") args.push("--no-proxy-server")
  else if (proxy) args.push(`--proxy-server=${String(proxy).replace(/\/+$/, "")}`)
  if (process.platform === "linux" && typeof process.getuid === "function" && process.getuid() === 0) args.push("--no-sandbox")
  args.push(url)
  return args
}

function inUse(dir) {
  try {
    const pid = Number(readlinkSync(path.join(dir, "SingletonLock")).split("-").pop())
    if (!(pid > 0)) return false
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err.code === "EPERM"
  }
}

export function sweepProfiles(root) {
  let names = []
  try {
    names = readdirSync(root).filter((n) => n.startsWith("run-"))
  } catch {
    return Promise.resolve()
  }
  return Promise.all(names.map((n) => path.join(root, n)).filter((dir) => !inUse(dir))
    .map((dir) => rm(dir, { recursive: true, force: true }).catch(() => {})))
}

const STDERR_LIMIT = 4096

function startFailure({ code, signal, stderr }) {
  const status = signal ? `signal ${signal}` : `code ${code ?? "unknown"}`
  const detail = String(stderr || "").trim().split(/\r?\n/).filter(Boolean).slice(-3).join(" | ")
  return new Error(`browser exited during start (${status})${detail ? `: ${detail}` : ""}`)
}

export async function launchBrowser({
  executable,
  profileDir,
  temporary = false,
  headless = true,
  hidden = false,
  proxy = "",
  url = "about:blank",
  port,
  waitMs = 30_000,
  connectPort = null,
}) {
  if (connectPort) {
    const v = await httpJSON(`http://127.0.0.1:${connectPort}/json/version`, 3000)
    if (!v?.webSocketDebuggerUrl) throw new Error(`Cannot connect to existing browser on port ${connectPort}`)
    const browser = await CDP.connect(v.webSocketDebuggerUrl)
    return { proc: null, port: connectPort, browser, profileDir: "", close: () => { browser.close() } }
  }

  if (!executable) throw new Error("没找到 Chrome、Edge 或 Chromium；装一个，或用 HARK_WEB_CHROME 指定路径")
  mkdirSync(profileDir, { recursive: true })
  port ??= await freePort()
  if (temporary) {
    sweepProfiles(profileDir)
    profileDir = mkdtempSync(path.join(profileDir, "run-"))
  }
  const cleanup = async () => {
    if (temporary) await rm(profileDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {})
  }
  let proc
  try {
    proc = spawn(executable, browserArgs({ port, profileDir, headless, hidden, proxy, url }), {
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: headless || hidden,
    })
  } catch (err) {
    await cleanup()
    throw err
  }
  let stderr = ""
  proc.stderr?.setEncoding("utf8")
  proc.stderr?.on("error", () => {})
  proc.stderr?.on("data", (chunk) => {
    if (stderr.length < STDERR_LIMIT) stderr += chunk
  })
  const stderrDone = new Promise((resolve) => {
    if (!proc.stderr) return resolve()
    proc.stderr.once("close", resolve)
    proc.stderr.once("error", resolve)
  })
  let exited = false
  let exitInfo = {}
  let spawnError = null
  proc.on("error", (err) => { spawnError = err })
  proc.on("exit", (code, signal) => {
    exited = true
    exitInfo = { code, signal }
  })
  let closing
  const close = (browser) => closing ??= stopBrowser(proc, browser).finally(cleanup)
  const started = Date.now()
  let last = null
  while (Date.now() - started < waitMs) {
    if (spawnError || exited) {
      if (exited) await Promise.race([stderrDone, new Promise((r) => setTimeout(r, 200))])
      await close()
      throw spawnError || startFailure({ ...exitInfo, stderr })
    }
    try {
      const v = await httpJSON(`http://127.0.0.1:${port}/json/version`, 1500)
      if (v?.webSocketDebuggerUrl) {
        const browser = await CDP.connect(v.webSocketDebuggerUrl)
        return { proc, port, browser, profileDir, close: () => close(browser) }
      }
    } catch (err) {
      last = err
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  await close()
  throw new Error(`browser did not open its debugging port: ${last?.message ?? "timeout"}`)
}

export function stopBrowser(proc, browser) {
  if (!proc || !proc.pid || proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve()
  const gone = new Promise((resolve) => proc.once("exit", resolve))
  try {
    browser?.send("Browser.close", {}, 3000).catch(() => {})
  } catch {}
  const kill = setTimeout(() => {
    try { proc.kill() } catch {}
  }, 3000)
  return gone.finally(() => clearTimeout(kill))
}
