import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { buildPrompt } from "../engine/prompt.mjs"
import { functions, parseCalls, toolsPrompt } from "../engine/tools.mjs"
import { expiryMs, parseSetCookies, settle, usageCard } from "../engine/hark.mjs"
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
