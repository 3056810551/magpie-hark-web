import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { devToolsActivePortCandidates, findExistingBrowser, parseDevToolsActivePort } from "../engine/browser.mjs"
import { CDP } from "../engine/cdp.mjs"
import { buildPrompt } from "../engine/prompt.mjs"
import { functions, parseCalls, toolsPrompt } from "../engine/tools.mjs"
import { POLL_JS, expiryMs, parseSetCookies, settle, usageCard } from "../engine/hark.mjs"
import { dataDir, engineKey, writePrivate } from "../engine/paths.mjs"
import { Store, parseCookieString } from "../engine/store.mjs"
import { VERSION } from "../engine/version.mjs"

test("prompt: a lone user message goes as is; history becomes formatted turns", () => {
  const lone = buildPrompt([{ role: "user", content: "hello" }])
  assert.equal(lone.full, "hello")
  assert.equal(lone.last, "hello")
  assert.equal(lone.turns, 1)

  const multi = buildPrompt([
    { role: "system", content: "You are a helpful assistant" },
    { role: "user", content: "question" },
    { role: "assistant", content: "answer" },
    { role: "user", content: "followup" },
  ])
  assert.match(multi.full, /背景与任务设定：/)
  assert.match(multi.full, /用户：\nquestion/)
  assert.match(multi.full, /助手：\nanswer/)
  assert.match(multi.full, /用户：\nfollowup/)
  assert.equal(multi.last, "followup")
  assert.equal(multi.turns, 3)
})

test("tools: prompt generation and parsing tool_call blocks", () => {
  const tools = [
    {
      type: "function",
      function: {
        name: "get_weather",
        description: "Get weather for city",
        parameters: {
          type: "object",
          properties: {
            city: { type: "string", description: "City name" },
          },
          required: ["city"],
        },
      },
    },
  ]
  const prompt = toolsPrompt(tools, "auto")
  assert.match(prompt, /get_weather/)
  assert.match(prompt, /City name/)

  const rawAssistant = '让我为你查询天气：\n```tool_call\n{"name": "get_weather", "arguments": {"city": "Tokyo"}}\n```\n请稍候。'
  const parsed = parseCalls(rawAssistant, tools)
  assert.equal(parsed.calls.length, 1)
  assert.equal(parsed.calls[0].name, "get_weather")
  assert.deepEqual(JSON.parse(parsed.calls[0].arguments), { city: "Tokyo" })
  assert.match(parsed.text, /让我为你查询天气：/)
  assert.match(parsed.text, /请稍候。/)
})

test("settle: streams delta and settles on final", () => {
  let sent = ""
  const step1 = settle(sent, "Hello")
  assert.equal(step1.delta, "Hello")
  sent = step1.sent

  const step2 = settle(sent, "Hello world!")
  assert.equal(step2.delta, " world!")
  sent = step2.sent

  const step3 = settle(sent, "Hello world!", true)
  assert.equal(step3.delta, "")
})

test("paths: dataDir per OS and private files", () => {
  const win = dataDir({ APPDATA: "C:\\Users\\test\\AppData\\Roaming" }, "win32")
  assert.equal(win, "C:\\Users\\test\\AppData\\Roaming\\hark-web")

  const mac = dataDir({}, "darwin", "/Users/test")
  assert.equal(mac, "/Users/test/Library/Application Support/hark-web")

  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "hark-test-"))
  try {
    const key1 = engineKey(tmpDir)
    assert.ok(key1 && key1.length >= 32)
    const key2 = engineKey(tmpDir)
    assert.equal(key1, key2)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test("store: add, update, retrieve, deduplicate, and parse cookies", () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "hark-store-"))
  const file = path.join(tmpDir, "accounts.json")
  try {
    const store = new Store(file)
    const saved = store.add({ session: "s1" }, { session: 1800000000 }, "User 1", "uid-100")
    assert.ok(saved.handle.startsWith("hark-"))
    assert.equal(store.count(), 1)

    // Deduplicate on same userId
    const updated = store.add({ session: "s2" }, { session: 1800000000 }, "User 1 New", "uid-100")
    assert.equal(updated.handle, saved.handle)
    assert.equal(store.count(), 1)
    assert.equal(store.get(saved.handle).cookies.session, "s2")

    // Cookie string parser
    const parsed = parseCookieString("__Secure-hark.session_token=abc123xyz; hark_region=US")
    assert.equal(parsed.cookies["__Secure-hark.session_token"], "abc123xyz")
    assert.equal(parsed.cookies.hark_region, "US")
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test("usage: transforms Hark billing summary into structured windows", () => {
  const summary = {
    plan: { id: "pro", name: "Hark Pro" },
    meters: {
      harkTokens: {
        dailyLimit: 8000000,
        dailyUsed: 800000,
        dailyResetsAt: "2026-11-13T11:30:27Z",
        poolLimit: 40000000,
        poolUsed: 4000000,
        poolResetsAt: "2026-12-12T11:29:41Z",
      },
    },
  }
  const card = usageCard(summary)
  assert.equal(card.plan, "Hark Pro")
  assert.equal(card.windows.length, 2)
  assert.equal(card.windows[0].name, "每日 Token")
  assert.equal(card.windows[0].used, 10)
  assert.equal(card.windows[1].name, "周期额度池")
  assert.equal(card.windows[1].used, 10)
})

test("browser: parseDevToolsActivePort and candidate paths", () => {
  assert.equal(parseDevToolsActivePort(""), null)
  assert.equal(parseDevToolsActivePort("notaport\n/devtools/browser/abc"), null)
  assert.equal(parseDevToolsActivePort("9222\nrelative"), null)

  const parsed = parseDevToolsActivePort("9222\r\n/devtools/browser/1234-5678\r\n")
  assert.deepEqual(parsed, {
    port: 9222,
    wsPath: "/devtools/browser/1234-5678",
    wsUrl: "ws://127.0.0.1:9222/devtools/browser/1234-5678",
  })

  const win = devToolsActivePortCandidates("win32", { LOCALAPPDATA: "C:\\Users\\Demo\\AppData\\Local" })
  assert.ok(win.some((p) => p.endsWith("Google\\Chrome\\User Data\\DevToolsActivePort")))
  const mac = devToolsActivePortCandidates("darwin", { HOME: "/Users/demo" })
  assert.ok(mac.some((p) => p === "/Users/demo/Library/Application Support/Google/Chrome/DevToolsActivePort"))
  const lin = devToolsActivePortCandidates("linux", { HOME: "/home/demo", XDG_CONFIG_HOME: "/home/demo/.cfg" })
  assert.ok(lin.some((p) => p === "/home/demo/.cfg/google-chrome/DevToolsActivePort"))
})

function startMockCdpServer(onJsonMessage, { jsonVersion = false } = {}) {
  const encodeTextFrame = (text) => {
    const payload = Buffer.from(text, "utf8")
    if (payload.length < 126) return Buffer.concat([Buffer.from([0x81, payload.length]), payload])
    const hdr = Buffer.alloc(4)
    hdr[0] = 0x81
    hdr[1] = 126
    hdr.writeUInt16BE(payload.length, 2)
    return Buffer.concat([hdr, payload])
  }

  const sockets = new Set()
  const server = http.createServer((req, res) => {
    if (jsonVersion && req.url === "/json/version") {
      const { port } = server.address()
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/mock` }))
      return
    }
    res.writeHead(404)
    res.end()
  })

  server.on("upgrade", (req, socket) => {
    sockets.add(socket)
    socket.on("close", () => sockets.delete(socket))
    const key = req.headers["sec-websocket-key"]
    const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64")
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    )
    let buf = Buffer.alloc(0)
    const send = (obj) => socket.write(encodeTextFrame(JSON.stringify(obj)))
    socket.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk])
      while (buf.length >= 2) {
        const opcode = buf[0] & 0x0f
        const masked = (buf[1] & 0x80) !== 0
        let len = buf[1] & 0x7f
        let offset = 2
        if (len === 126) {
          if (buf.length < 4) return
          len = buf.readUInt16BE(2)
          offset = 4
        }
        const need = offset + (masked ? 4 : 0) + len
        if (buf.length < need) return
        const maskKey = masked ? buf.subarray(offset, offset + 4) : null
        const dataStart = offset + (masked ? 4 : 0)
        const payload = Buffer.from(buf.subarray(dataStart, dataStart + len))
        if (maskKey) for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i % 4]
        buf = buf.subarray(need)
        if (opcode === 0x8) {
          socket.end()
          return
        }
        if (opcode === 0x1) {
          const msg = JSON.parse(payload.toString("utf8"))
          onJsonMessage(msg, send)
        }
      }
    })
  })

  const closeAll = async () => {
    for (const s of sockets) s.destroy()
    server.closeAllConnections?.()
    await new Promise((r) => server.close(r))
  }

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, close: closeAll }))
  })
}

test("cdp: flattened CDPSession routes commands/events and handles detach", async () => {
  const mock = await startMockCdpServer((msg, send) => {
    if (msg.method === "Target.attachToTarget") {
      assert.equal(msg.params.targetId, "tgt-1")
      assert.equal(msg.params.flatten, true)
      send({ id: msg.id, result: { sessionId: "ses-1" } })
      return
    }
    if (msg.method === "Runtime.evaluate") {
      assert.equal(msg.sessionId, "ses-1")
      send({ method: "Runtime.consoleAPICalled", params: { type: "log" }, sessionId: "ses-1" })
      send({ id: msg.id, result: { result: { value: 42 } }, sessionId: "ses-1" })
      return
    }
    if (msg.method === "Target.detachFromTarget") {
      send({ id: msg.id, result: {} })
    }
  })

  try {
    const client = await CDP.connect(`ws://127.0.0.1:${mock.port}/devtools/browser/mock`)
    const ses = await client.attach("tgt-1")

    const events = []
    ses.on("Runtime.consoleAPICalled", (p) => events.push(p))
    const val = await ses.js("6 * 7")
    assert.equal(val, 42)
    assert.deepEqual(events, [{ type: "log" }])

    let detached = false
    ses.onClose(() => { detached = true })
    ses.close()
    assert.equal(detached, true)
    await assert.rejects(() => ses.send("Page.reload"), /session closed/)
    client.close()
  } finally {
    await mock.close()
  }
})

test("browser: findExistingBrowser connects via DevToolsActivePort when /json/version returns 404", async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "hark-cdp-"))
  const mock = await startMockCdpServer((msg, send) => {
    if (msg.method === "Browser.getVersion") {
      send({ id: msg.id, result: { product: "Chrome/136.0.0.0" } })
    }
  })

  try {
    const activePortFile = path.join(tmpDir, "Google", "Chrome", "User Data", "DevToolsActivePort")
    writePrivate(activePortFile, `${mock.port}\n/devtools/browser/mock\n`)

    const found = await findExistingBrowser({
      connectPort: mock.port,
      platform: "win32",
      env: { LOCALAPPDATA: tmpDir },
    })
    assert.ok(found)
    assert.equal(found.existing, true)
    assert.equal(found.port, mock.port)
    assert.equal(found.source, `DevToolsActivePort:${mock.port}`)
    found.close()

    // Auto-discovery mode (connectPort = null) picks up DevToolsActivePort too
    const autoFound = await findExistingBrowser({
      platform: "win32",
      env: { LOCALAPPDATA: tmpDir },
    })
    assert.ok(autoFound)
    assert.equal(autoFound.existing, true)
    assert.equal(autoFound.port, mock.port)
    assert.equal(autoFound.source, `DevToolsActivePort:${mock.port}`)
    autoFound.close()
  } finally {
    await mock.close()
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test("hark: POLL_JS ignores prior-turn OK and joins multi-entry text + code card", () => {
  const makeEntry = ({ id = null, user = false, bot = false, kind = "text", text = "" }) => {
    const bubble = id ? { getAttribute: (k) => (k === "data-bubble-id" ? id : k === "data-bubble-kind" ? kind : null) } : null
    return {
      innerText: text,
      querySelector: (sel) => {
        if (sel === '[data-testid="message-bubble"]') return bubble
        if (sel === "._151xtfxe") return user ? {} : null
        if (sel === "._151xtfxi, ._151xtfxf") return bot ? {} : null
        if (sel === '[data-testid="message-text"]') return id ? { innerText: text } : null
        return null
      },
    }
  }

  const runPoll = (entries, seenIds, { stop = false } = {}) => {
    const list = {
      scrollHeight: 100,
      clientHeight: 100,
      scrollTop: 0,
      querySelectorAll: (sel) => {
        if (sel === '[data-entry-kind="message"]') return entries
        return []
      },
    }
    const doc = {
      body: list,
      querySelector: (sel) => {
        if (sel === '[data-testid="message-list"]') return list
        if (sel === '[data-testid="send-button"]') return { getAttribute: () => "false", disabled: false }
        if (sel.includes("stop-button")) return stop ? {} : null
        return null
      },
    }
    return JSON.parse(new Function("document", `return ${POLL_JS(seenIds)}`)(doc))
  }

  const oldEntries = [
    makeEntry({ id: "u1", user: true, text: "Reply with just: OK" }),
    makeEntry({ id: "b1", bot: true, kind: "text", text: "OK" }),
  ]

  // Before new user message mounts in DOM, must NOT leak old "OK"
  const beforeMount = runPoll(oldEntries, ["u1", "b1"])
  assert.equal(beforeMount.hasUser, false)
  assert.equal(beforeMount.txt, "")
  assert.equal(beforeMount.streaming, true)

  // New user prompt + intro text bubble + code card (no bubble id) while streaming
  const fullEntries = [
    ...oldEntries,
    makeEntry({ id: "u2", user: true, text: "写一段langchain的基础代码" }),
    makeEntry({ id: "b2", bot: true, kind: "text", text: "这是基础示例：" }),
    makeEntry({ id: null, text: "LangChain\nfrom langchain_openai import ChatOpenAI" }),
  ]
  const mid = runPoll(fullEntries, ["u1", "b1"], { stop: true })
  assert.equal(mid.hasUser, true)
  assert.equal(mid.cnt, 2)
  assert.equal(mid.streaming, true)
  assert.equal(mid.txt, "这是基础示例：\n\nLangChain\nfrom langchain_openai import ChatOpenAI")

  const done = runPoll(fullEntries, ["u1", "b1"], { stop: false })
  assert.equal(done.streaming, false)
  assert.equal(done.txt, "这是基础示例：\n\nLangChain\nfrom langchain_openai import ChatOpenAI")
})
