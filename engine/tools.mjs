// Tool calling over a web chat that has none.
const ARGS_IN_HISTORY = 1500

export function functions(tools) {
  if (!Array.isArray(tools)) return []
  return tools
    .map((t) => (t && typeof t === "object" ? (t.function && typeof t.function === "object" ? t.function : t) : null))
    .filter((f) => f && typeof f.name === "string" && f.name && (f.type === undefined || f.type === "function" || f.parameters))
    .map((f) => ({ name: f.name, description: String(f.description || "").trim(), parameters: f.parameters }))
}

function choice(toolChoice) {
  if (toolChoice === "none" || toolChoice === "required") return toolChoice
  if (toolChoice && typeof toolChoice === "object") return toolChoice.function?.name || toolChoice.name || ""
  return ""
}

function typeOf(spec) {
  if (!spec || typeof spec !== "object") return "any"
  if (Array.isArray(spec.enum)) return spec.enum.map((v) => JSON.stringify(v)).join(" | ")
  if (spec.type === "array") return `array<${typeOf(spec.items)}>`
  return Array.isArray(spec.type) ? spec.type.join(" | ") : spec.type || (spec.properties ? "object" : "any")
}

function params(schema, indent = "   ") {
  const props = schema && typeof schema === "object" ? schema.properties : null
  if (!props || !Object.keys(props).length) return `${indent}（无参数）`
  const required = new Set(Array.isArray(schema.required) ? schema.required : [])
  return Object.entries(props).map(([name, spec]) => {
    const desc = spec && typeof spec === "object" && spec.description ? ` ${String(spec.description).trim()}` : ""
    const line = `${indent}- ${name} (${typeOf(spec)}, ${required.has(name) ? "必填" : "可选"})${desc}`
    const inner = spec?.type === "object" ? spec : spec?.type === "array" && spec.items?.type === "object" ? spec.items : null
    return inner?.properties ? `${line}\n${params(inner, indent + "  ")}` : line
  }).join("\n")
}

export function toolsPrompt(tools, toolChoice) {
  const list = functions(tools)
  const pick = choice(toolChoice)
  if (!list.length || pick === "none") return ""
  const lines = [
    "【客户端工具说明】",
    "这段对话来自用户本机的一个客户端。用户的文件、项目和命令行都在他自己的电脑上；客户端可以替你在用户电脑上执行下面这些工具。需要时输出一个 tool_call 代码块，块里只有一个 JSON 对象，客户端执行后会把结果发回给你：",
    "```tool_call",
    '{"name": "工具名", "arguments": {参数}}',
    "```",
    "一次需要多个就输出多个代码块。工具调用一定要放在代码块里，参数必须是合法 JSON，按下面每个工具的参数说明填写。不需要工具时直接用自然语言回答。",
    "不要让用户自己去运行命令、复制粘贴结果：需要用户电脑上的什么信息或操作，就直接调用工具。",
  ]
  if (pick === "required") lines.push("这一轮必须至少调用一个工具。")
  else if (pick) lines.push(`这一轮必须调用工具 ${pick}。`)
  lines.push("", "可用工具：")
  list.forEach((f, i) => {
    lines.push(`${i + 1}. ${f.name}${f.description ? ` — ${f.description}` : ""}`, "   参数：", params(f.parameters, "   "))
  })
  return lines.join("\n")
}

export const TOOLS_REMINDER = "（用户电脑上的操作仍然用 tool_call 代码块请求客户端执行。）"

export function callsAsText(toolCalls) {
  return toolCalls.map((c) => {
    const name = c?.function?.name || c?.name || ""
    let args = c?.function?.arguments ?? c?.arguments ?? "{}"
    if (typeof args !== "string") args = JSON.stringify(args)
    if (args.length > ARGS_IN_HISTORY) args = args.slice(0, ARGS_IN_HISTORY) + "…（已截断）"
    return "```tool_call\n" + `{"name": ${JSON.stringify(name)}, "arguments": ${args}}` + "\n```"
  }).join("\n")
}

const TAG = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g
const FENCE = /```([A-Za-z_]*)[ \t]*([\s\S]*?)```/g
const LABEL = /(?:^|\n)[ \t]*tool_call[ \t]*\r?\n[ \t]*/g

function asCall(obj, names, requireArgs = false) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null
  const fn = obj.function && typeof obj.function === "object" ? obj.function : null
  const name = obj.name || obj.tool || fn?.name
  if (typeof name !== "string" || !names.has(name)) return null
  if (requireArgs && !("arguments" in obj || "parameters" in obj || "args" in obj || (fn && "arguments" in fn))) return null
  let args = obj.arguments ?? obj.parameters ?? obj.args ?? fn?.arguments ?? {}
  if (typeof args === "string") {
    try {
      args = JSON.parse(args)
    } catch {
      return null
    }
  }
  return { name, arguments: typeof args === "object" && args ? JSON.stringify(args) : "{}" }
}

function parseJSON(raw) {
  const s = String(raw || "").trim()
  if (!s) return null
  try {
    return JSON.parse(s)
  } catch {}
  const m = s.match(/\{[\s\S]*\}/)
  if (m) {
    try {
      return JSON.parse(m[0])
    } catch {}
  }
  return null
}

export function parseCalls(text, tools) {
  const names = new Set(functions(tools).map((f) => f.name))
  if (!names.size) return { text, calls: [] }
  const calls = []
  const matches = []
  for (const m of text.matchAll(TAG)) {
    const call = asCall(parseJSON(m[1]), names)
    if (call) {
      matches.push({ start: m.index, end: m.index + m[0].length, call })
    }
  }
  for (const m of text.matchAll(FENCE)) {
    if (matches.some((x) => m.index >= x.start && m.index < x.end)) continue
    const tag = (m[1] || "").toLowerCase()
    const isTool = tag === "tool_call" || tag === "tool" || tag === "json" || tag === ""
    if (!isTool) continue
    const call = asCall(parseJSON(m[2]), names, tag === "json" || tag === "")
    if (call) {
      matches.push({ start: m.index, end: m.index + m[0].length, call })
    }
  }
  for (const m of text.matchAll(LABEL)) {
    if (matches.some((x) => m.index >= x.start && m.index < x.end)) continue
    const rest = text.slice(m.index + m[0].length)
    const jsonMatch = rest.match(/^[ \t]*\{[\s\S]*?\}/)
    if (jsonMatch) {
      const call = asCall(parseJSON(jsonMatch[0]), names)
      if (call) {
        matches.push({ start: m.index, end: m.index + m[0].length + jsonMatch[0].length, call })
      }
    }
  }
  if (!matches.length) return { text, calls: [] }
  matches.sort((a, b) => a.start - b.start)
  let cleaned = ""
  let cursor = 0
  for (const match of matches) {
    cleaned += text.slice(cursor, match.start)
    cursor = match.end
    calls.push(match.call)
  }
  cleaned += text.slice(cursor)
  return { text: cleaned.trim(), calls }
}
