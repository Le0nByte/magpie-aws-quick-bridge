// 把浏览器登录放进独立进程，并把结果留在磁盘上。
//
// 宿主被回收是常态：magpie 的插件宿主按需拉起，登录中途被换掉、插件重载、
// 用户关掉面板都会让宿主里的回环服务器消失。这里改成：
//   1. 宿主要登录 → 检查 ~/.aws-quick-bridge/signin/ 里有没有刚完成的记录（有就直接用）；
//   2. 没有 → detached 拉起 signin-helper.mjs，它自己监听回环端口、自己完成 token 交换；
//   3. 宿主只负责把地址交给 magpie/浏览器，然后等记录文件出现。
// 宿主中途死掉不影响登录：helper 照样跑完并落盘，下次点登录直接取用。
import { spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { randomBytes } from "node:crypto"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const HELPER = path.join(HERE, "signin-helper.mjs")
// 记录 15 分钟内有效：足够 user 点完登录，过期就丢弃，避免拿到旧 token 当新登录
const RECORD_TTL_MS = 15 * 60_000
const URL_WAIT_MS = 20_000

export const signinHome = () => process.env.AWS_QUICK_BRIDGE_HOME || path.join(os.homedir(), ".aws-quick-bridge")
export const signinDir = () => path.join(signinHome(), "signin")

function readJSON(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"))
  } catch {
    return null
  }
}

function remove(file) {
  try { fs.rmSync(file, { force: true }) } catch {}
}

function fresh(file) {
  try {
    return Date.now() - fs.statSync(file).mtimeMs < RECORD_TTL_MS
  } catch {
    return false
  }
}

// 上一次（可能宿主已经死了）登录留下的结果
export function takeFinished() {
  const dir = signinDir()
  let names = []
  try { names = fs.readdirSync(dir) } catch { return null }
  for (const name of names) {
    if (!name.startsWith("record-") || !name.endsWith(".json")) continue
    const file = path.join(dir, name)
    if (!fresh(file)) { remove(file); continue }
    const payload = readJSON(file)
    if (!payload) continue
    remove(file)
    remove(file.replace("record-", "url-"))
    if (payload.type === "success" && payload.record?.access) return { type: "success", record: payload.record }
    if (payload.type === "failed") return { type: "failed", error: String(payload.error || "the sign-in failed") }
  }
  return null
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitFor(file, ms, isAlive) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (fs.existsSync(file)) return readJSON(file)
    if (isAlive && !isAlive()) return null
    await sleep(300)
  }
  return null
}

// 拉起 helper，返回 { url } 或 { error }
export async function startDetached({ provider, stage, region, appVersion, port, timeoutMs, log = () => {} }) {
  const dir = signinDir()
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const id = randomBytes(6).toString("hex")
  const recordPath = path.join(dir, `record-${id}.json`)
  const urlPath = path.join(dir, `url-${id}.json`)
  let child
  try {
    child = spawn(
      process.execPath,
      [HELPER, "--record", recordPath, "--url", urlPath,
       "--provider", provider, "--stage", stage, "--region", region,
       "--app-version", appVersion, "--port", String(port ?? 0), "--timeout", String(timeoutMs ?? 30 * 60_000)],
      { detached: true, stdio: "ignore", windowsHide: true, cwd: dir, env: process.env },
    )
    child.unref()
  } catch (e) {
    return { error: `cannot start the sign-in process: ${String(e?.message ?? e)}` }
  }
  const isAlive = () => { try { process.kill(child.pid, 0); return true } catch { return false } }
  const info = await waitFor(urlPath, URL_WAIT_MS, isAlive)
  remove(urlPath)
  if (!info?.url) {
    const failed = readJSON(recordPath)
    remove(recordPath)
    return { error: failed?.error || "the sign-in process did not come up" }
  }
  log(`[signin] helper ${child.pid} serving ${info.url}`)
  return {
    url: info.url,
    // 等 helper 把结果写下来；宿主被杀也无所谓，记录还在磁盘上
    wait: async () => {
      const payload = await waitFor(recordPath, timeoutMs ?? 30 * 60_000)
      remove(recordPath)
      if (!payload) return { type: "failed", error: "the sign-in timed out" }
      if (payload.type !== "success") return { type: "failed", error: String(payload.error || "the sign-in failed") }
      return { type: "success", record: payload.record }
    },
    pid: child.pid,
  }
}
