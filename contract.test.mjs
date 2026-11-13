import assert from "node:assert/strict"
import { createServer } from "node:http"
import { once } from "node:events"
import test from "node:test"

import { HarkWebPlugin } from "./index.mjs"

function listen() {
  const seen = []
  let mode = "ok"
  const server = createServer((req, res) => {
    const chunks = []
    req.on("data", (c) => chunks.push(c))
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8")
      seen.push({
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization || "",
        account: req.headers["x-hark-account"] || "",
        session: req.headers["x-hark-session"] || "",
        body,
      })
      if (req.url === "/mode") {
        mode = body.trim() || "ok"
        res.writeHead(204)
        res.end()
        return
      }
      if (mode === "401") {
        const payload = JSON.stringify({ error: { message: "session refused", type: "authentication_error" } })
        res.writeHead(401, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) })
        res.end(payload)
        return
      }
      if (mode === "429") {
        const payload = JSON.stringify({ error: { message: "account busy", type: "rate_limit_error" } })
        res.writeHead(429, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) })
        res.end(payload)
        return
      }
      if (req.url === "/v1/session/refresh") {
        const payload = JSON.stringify({ expires: 1800000000000 })
        res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) })
        res.end(payload)
        return
      }
      if (req.url === "/v1/import") {
        const payload = JSON.stringify({ ok: true, account: { handle: "hark-imported-1", expires: 1800000000000, label: "Cookie User" } })
        res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) })
        res.end(payload)
        return
      }
      if (req.url === "/v1/usage") {
        const payload = JSON.stringify(mode === "card"
          ? { plan: "Hark Pro · 已就绪", windows: [{ name: "每日 Token", used: 10 }], user: "杨剑华", until: "2026-12-12T11:29:41.000Z" }
          : { error: "no structured quota" })
        res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) })
        res.end(payload)
        return
      }
      const stream = body.includes('"stream":true') || body.includes('"stream": true')
      if (stream) {
        const payload = [
          'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","created":0,"model":"hark","choices":[{"index":0,"delta":{"content":"hark-ok"},"finish_reason":null}]}',
          "",
          'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","created":0,"model":"hark","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
          "",
          "data: [DONE]",
          "",
          "",
        ].join("\n")
        res.writeHead(200, { "content-type": "text/event-stream", "content-length": Buffer.byteLength(payload) })
        res.end(payload)
        return
      }
      const payload = JSON.stringify({
        id: "chatcmpl-test",
        object: "chat.completion",
        created: 0,
        model: "hark",
        choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "hark-ok" } }],
      })
      res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) })
      res.end(payload)
    })
  })
  return {
    server,
    seen,
    setMode: async (next) => { mode = next },
  }
}

async function boot() {
  const fake = listen()
  fake.server.listen(0, "127.0.0.1")
  await once(fake.server, "listening")
  const { port } = fake.server.address()
  process.env.HARK_WEB_ENGINE = `http://127.0.0.1:${port}`
  process.env.HARK_WEB_ENGINE_KEY = "engine-test-key"
  const hooks = await HarkWebPlugin()
  const loaded = await hooks.auth.loader(async () => ({ type: "api", key: "acct-handle-1" }))
  return {
    ...fake,
    port,
    url: `http://127.0.0.1:${port}/v1/chat/completions`,
    hooks,
    loaded,
    close: async () => {
      fake.server.close()
      await once(fake.server, "close")
      delete process.env.HARK_WEB_ENGINE
      delete process.env.HARK_WEB_ENGINE_KEY
    },
  }
}

test("forwards the named account and streams without content-length", async () => {
  const env = await boot()
  try {
    const res = await env.loaded.fetch(env.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "hark", stream: true, messages: [{ role: "user", content: "hi" }] }),
    })
    assert.equal(res.status, 200)
    assert.equal(res.headers.get("x-magpie-sign-in"), "kept")
    assert.equal(res.headers.get("content-length"), null)
    const text = await res.text()
    assert.match(text, /hark-ok/)
    assert.equal(env.seen.length, 1)
    assert.equal(env.seen[0].account, "acct-handle-1")
    assert.equal(env.seen[0].authorization, "Bearer engine-test-key")
  } finally {
    await env.close()
  }
})

test("401 is marked expired and 429 stays an OpenAI error", async () => {
  const env = await boot()
  try {
    await env.setMode("401")
    const expired = await env.loaded.fetch(env.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "hark", stream: false, messages: [{ role: "user", content: "hi" }] }),
    })
    assert.equal(expired.status, 401)
    assert.equal(expired.headers.get("x-magpie-sign-in"), "expired")

    await env.setMode("429")
    const busy = await env.loaded.fetch(env.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "hark", stream: false, messages: [{ role: "user", content: "hi" }] }),
    })
    assert.equal(busy.status, 429)
    assert.equal(busy.headers.get("x-magpie-sign-in"), null)
  } finally {
    await env.close()
  }
})

test("chat.headers sets x-hark-session", async () => {
  const env = await boot()
  try {
    const output = { headers: {} }
    await env.hooks["chat.headers"]({ model: { providerID: "hark-web" }, sessionID: "ses-123" }, output)
    assert.equal(output.headers["x-hark-session"], "ses-123")
  } finally {
    await env.close()
  }
})

test("refresh exchanges only expiry and a refusal expires the sign-in", async () => {
  const env = await boot()
  try {
    const fresh = await env.hooks.auth.refresh({ type: "api", key: "acct-handle-1" })
    assert.equal(fresh.expires, 1800000000000)
    await env.setMode("401")
    await assert.rejects(() => env.hooks.auth.refresh({ type: "api", key: "acct-handle-1" }), (err) => {
      assert.equal(err.signIn, "expired")
      return true
    })
  } finally {
    await env.close()
  }
})

test("usage card shows account and structured windows", async () => {
  const env = await boot()
  try {
    await env.setMode("card")
    const card = await env.hooks.auth.usage(async () => ({ type: "api", key: "acct-handle-1" }))
    assert.equal(card.signIn, "kept")
    assert.equal(card.plan, "Hark Pro · 已就绪")
    assert.equal(card.windows[0].name, "每日 Token")
    assert.equal(card.windows[0].used, 10)
  } finally {
    await env.close()
  }
})

test("config registers provider and models", async () => {
  const env = await boot()
  try {
    const cfg = {}
    await env.hooks.config(cfg)
    assert.ok(cfg.provider["hark-web"])
    assert.ok(cfg.provider["hark-web"].models.hark)
    assert.equal(cfg.provider["hark-web"].models.hark.tool_call, true)
  } finally {
    await env.close()
  }
})

test("cookie string key imports once and caches resolved handle across requests", async () => {
  const env = await boot()
  try {
    const cookieKey = "__Secure-hark.session_token=raw-tok; hark_region=US"
    const cookieAuth = async () => ({ type: "api", key: cookieKey })
    const loader = await env.hooks.auth.loader(cookieAuth)

    await loader.fetch(env.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "hark", stream: false, messages: [{ role: "user", content: "hi" }] }),
    })
    await loader.fetch(env.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "hark", stream: false, messages: [{ role: "user", content: "hi again" }] }),
    })
    await env.hooks.auth.usage(cookieAuth)

    const imports = env.seen.filter((r) => r.url === "/v1/import")
    const chats = env.seen.filter((r) => r.url === "/v1/chat/completions")
    const usages = env.seen.filter((r) => r.url === "/v1/usage")
    assert.equal(imports.length, 1)
    assert.equal(chats.length, 2)
    assert.equal(usages.length, 1)
    assert.equal(chats[0].account, "hark-imported-1")
    assert.equal(chats[1].account, "hark-imported-1")
    assert.equal(usages[0].account, "hark-imported-1")

    // On 401, cached handle invalidates so a subsequent call can re-import
    await env.setMode("401")
    const expired = await loader.fetch(env.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "hark", stream: false, messages: [{ role: "user", content: "expired" }] }),
    })
    assert.equal(expired.status, 401)
    await env.setMode("ok")
    await loader.fetch(env.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "hark", stream: false, messages: [{ role: "user", content: "reimport" }] }),
    })
    assert.equal(env.seen.filter((r) => r.url === "/v1/import").length, 2)
  } finally {
    await env.close()
  }
})
