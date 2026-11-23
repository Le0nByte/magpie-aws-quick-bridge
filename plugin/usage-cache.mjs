// 额度缓存：magpie 读额度（auth.usage）时有等待上限，AWS 这条链路慢一点
// （代理抖、profile/usage 排队）就会让账号卡片变成“暂时无法获取最新额度”。
// 这里把上一次读到的数字留在本地，钩子超时/失败时直接回旧的，界面上继续有数字。
//
// 文件：$AWS_QUICK_BRIDGE_HOME/usage-cache.json，默认 ~/.aws-quick-bridge/，
// 只有额度数字（没有 token），0600。
import { createHash } from "node:crypto"
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export const home = () => process.env.AWS_QUICK_BRIDGE_HOME || join(homedir(), ".aws-quick-bridge")
const file = () => join(home(), "usage-cache.json")
const MAX_ENTRIES = 32

function readAll() {
  try {
    const value = JSON.parse(readFileSync(file(), "utf8"))
    return value && typeof value === "object" && value.accounts && typeof value.accounts === "object" ? value : { accounts: {} }
  } catch {
    return { accounts: {} }
  }
}

// { at, value } for the account, or null.
export function get(key) {
  const entry = readAll().accounts[key]
  return entry && entry.value && typeof entry.value === "object" ? entry : null
}

export function set(key, value) {
  const db = readAll()
  db.accounts[key] = { at: Date.now(), value }
  const keys = Object.keys(db.accounts)
  if (keys.length > MAX_ENTRIES) for (const old of keys.slice(0, keys.length - MAX_ENTRIES)) delete db.accounts[old]
  try {
    mkdirSync(home(), { recursive: true, mode: 0o700 })
    const tmp = `${file()}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(db, null, 2) + "\n", { mode: 0o600 })
    try { chmodSync(tmp, 0o600) } catch {}
    renameSync(tmp, file())
  } catch {
    // 落不了盘不影响内存里的这一次结果
  }
}

// 缓存按「租户|账号|access token 指纹」分：换了 token（续期或换个账号）不会
// 命中上一次的数字，免得把别人的/过期的额度显示出来。fingerprint 是 SHA-256
// 前 12 个十六进制字符，不是 token 本身。
export const keyOf = (auth) =>
  `${String(auth?.tenantUrl ?? "").replace(/\/+$/, "")}|${auth?.accountId ?? ""}|${fingerprint(auth?.access)}`

const fingerprint = (access) => (typeof access === "string" && access ? createHash("sha256").update(access).digest("hex").slice(0, 12) : "")
