// 独立进程跑浏览器登录（由 plugin/signin.mjs 以 detached 方式拉起）。
//
// 为什么需要它：magpie 的插件宿主是按需拉起、会被回收的，而回环回调服务器活在
// 宿主里。宿主一回收，端口就没了，浏览器带着 ?code= 回来只会看到
// ERR_CONNECTION_REFUSED。把这一步放进独立进程后，宿主死不死都不影响登录完成；
// 完成后的账号记录写在磁盘上，下次点「登录」时插件直接取走，不用再走一遍浏览器。
//
// 用法（内部）：node/bun signin-helper.mjs --record <json> --url <json> --port <n>
//   [--provider social] [--stage prod] [--region us-east-1] [--timeout <ms>]
import fs from "node:fs"
import path from "node:path"
import { browserSignIn } from "./login.mjs"

const argv = process.argv.slice(2)
const arg = (name, fallback = "") => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback
}
const recordPath = arg("--record")
const urlPath = arg("--url")
if (!recordPath || !urlPath) {
  console.error("signin-helper: --record and --url are required")
  process.exit(2)
}

// 原子写，权限只给本人（记录里有 token）
function writeJSON(file, value) {
  try {
    const tmp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 })
    try { fs.chmodSync(tmp, 0o600) } catch {}
    fs.renameSync(tmp, file)
  } catch (e) {
    console.error("signin-helper: cannot write", file, String(e?.message ?? e))
  }
}

const cfg = {
  provider: arg("--provider", "social"),
  stage: arg("--stage", "prod"),
  region: arg("--region", "us-east-1"),
  appVersion: arg("--app-version", "1.2.4660"),
  callbackPort: Number(arg("--port", "18080")) || 0,
  loginTimeoutMs: Number(arg("--timeout", String(30 * 60_000))) || 30 * 60_000,
}

let started
try {
  started = await browserSignIn({ provider: cfg.provider, region: cfg.region }, cfg, {})
} catch (e) {
  writeJSON(recordPath, { type: "failed", error: String(e?.message ?? e), at: new Date().toISOString() })
  process.exit(1)
}
if (!started?.url) {
  writeJSON(recordPath, { type: "failed", error: started?.error || "the sign-in did not start", at: new Date().toISOString() })
  process.exit(1)
}

// 先把地址交出去，插件（或 magpie）才能把浏览器指过来
writeJSON(urlPath, { url: started.url, port: cfg.callbackPort, pid: process.pid, at: new Date().toISOString() })
console.log("[signin-helper] waiting on", started.url)

// login.mjs 的回环服务器是 unref 的（它假定 magpie 宿主在保活）。独立进程没有别的
// 句柄，Node/Bun 会立刻退出 —— 端口随即消失，浏览器回来就是 ERR_CONNECTION_REFUSED。
// 用一个 ref 的定时器占住事件循环，登录结束再清掉。
const keepAlive = setInterval(() => {}, 60_000)

let fields
try {
  fields = await started.callback()
  clearInterval(keepAlive)
} catch (e) {
  clearInterval(keepAlive)
  writeJSON(recordPath, { type: "failed", error: String(e?.message ?? e), at: new Date().toISOString() })
  process.exit(1)
}
if (fields?.type !== "success") {
  writeJSON(recordPath, { type: "failed", error: fields?.error || "the sign-in did not finish", at: new Date().toISOString() })
  process.exit(1)
}
const record = { ...fields }
delete record.type
writeJSON(recordPath, { type: "success", record, at: new Date().toISOString() })
console.log("[signin-helper] signed in:", record.accountId || record.email || "")
