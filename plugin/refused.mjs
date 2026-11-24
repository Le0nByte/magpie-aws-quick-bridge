// 被上游拒绝的 refresh token 记在磁盘上（而不是内存里）。
//
// magpie 的插件宿主是按次拉起的：内存里的 Map 在下一次 auth.refresh 时已经是新进程，
// 记不住任何东西，于是「每 10 秒重试一次」根本停不下来。落盘按 token 指纹记，
// 30 分钟内直接跳过续期，不打网络、也不再写日志。
import { createHash } from "node:crypto"
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export const home = () => process.env.AWS_QUICK_BRIDGE_HOME || join(homedir(), ".aws-quick-bridge")
const file = () => join(home(), "refresh-refused.json")
const MAX_ENTRIES = 16
const KEEP_MS = 7 * 24 * 60 * 60_000

const key = (token) => createHash("sha256").update(String(token ?? "")).digest("hex").slice(0, 16)

function readAll() {
  try {
    const value = JSON.parse(readFileSync(file(), "utf8"))
    return value && typeof value === "object" && value.entries && typeof value.entries === "object" ? value : { entries: {} }
  } catch {
    return { entries: {} }
  }
}

export function get(token) {
  const entry = readAll().entries[key(token)]
  return entry && Number.isFinite(entry.at) ? entry : null
}

export function clear(token) {
  const db = readAll()
  if (!db.entries[key(token)]) return
  delete db.entries[key(token)]
  write(db)
}

export function set(token, error) {
  const db = readAll()
  const now = Date.now()
  db.entries[key(token)] = { at: now, error: String(error ?? "").slice(0, 300) }
  for (const [k, v] of Object.entries(db.entries)) {
    if (!v || now - Number(v.at) > KEEP_MS) delete db.entries[k]
  }
  const keys = Object.keys(db.entries)
  if (keys.length > MAX_ENTRIES) {
    keys.sort((a, b) => (db.entries[a].at ?? 0) - (db.entries[b].at ?? 0))
    for (const k of keys.slice(0, keys.length - MAX_ENTRIES)) delete db.entries[k]
  }
  write(db)
}

function write(db) {
  try {
    mkdirSync(home(), { recursive: true, mode: 0o700 })
    const tmp = `${file()}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(db, null, 2) + "\n", { mode: 0o600 })
    try { chmodSync(tmp, 0o600) } catch {}
    renameSync(tmp, file())
  } catch {
    // 落不了盘就退化成内存行为，不影响正确性
  }
}
