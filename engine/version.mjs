import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

export const VERSION = (() => {
  try {
    const pkg = JSON.parse(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"))
    return pkg.version || "0.1.0"
  } catch {
    return "0.1.0"
  }
})()
