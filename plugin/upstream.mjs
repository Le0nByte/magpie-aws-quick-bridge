// One chat turn over the Amazon Quick bidi WebSocket, ported from
// aws-quickwork-2api's internal/proxy/upstream.go.
//
// A turn names its thread. Amazon Quick keeps a thread's history and its
// custom_prompt, so a later turn on another connection continues it by
// naming the same thread_id.

import { argumentString, callId, titleFor, uuid } from "./messages.mjs"
import { GATEWAY_WS_PATH } from "./oauth.mjs"
import { aidpDecode, aidpEncode, gatewayDecode, gatewayEncode, isGatewayProvider } from "./wire.mjs"

const DEFAULT_WS_PATH = "/streaming/quickwork-chat-bidirectional-stream"
const READ_IDLE_MS = 2 * 60_000
const AFTER_COMPLETE_MS = 5_000
const HANDSHAKE_MS = 20_000
// A proxy that answers nothing can leave the dial hanging for minutes, all of
// it before a single byte is sent. Past this the dial counts as a transport
// failure the caller may retry.
const DIAL_MS = 20_000
const PING_MS = 25_000

const TERMINAL = new Set(["turn_completed", "turn_aborted", "turn_ended", "stream_ended", "chat_complete"])
const FAILURES = new Set(["error", "session_error", "stream_error", "turn_failed"])

export class UpstreamError extends Error {
  // kind: "handshake" (status is the HTTP status the upgrade got, 0 when
  // unknown), "upstream" (an error event), "too_large" (the frame is over
  // Amazon Quick's size limit), "blocked" (a guardrail), "timeout",
  // "transport"
  constructor(kind, message, status = 0) {
    super(message)
    this.kind = kind
    this.status = status
  }
}

// Amazon Quick refuses a user_message over 64 KB (FrameTooLarge). Measured
// against a real account, it counts the UTF-8 bytes of the message's JSON,
// whatever the transport wraps it in and the same for the text and the
// custom prompt: 65250 bytes were taken and 65300 refused, so it adds some
// 260 bytes of its own before comparing with 65536. For an organization's
// transport, which was not measured, the whole frame is counted.
export const frameBytes = (gateway, value) => (gateway ? encodeFrame(gateway, value).byteLength : Buffer.byteLength(JSON.stringify(value)))

// The user_message of a turn, shared with the code that fits a turn into a
// frame.
export function userMessage(session, cfg, input) {
  const payload = {
    text: input.reminder ? `${input.prompt}\n\n${input.reminder}` : input.prompt,
    send_origin: "programmatic",
    had_physical_input: false,
    surfaceType: session.surface,
    outpostId: session.outpostId,
    appVersion: cfg.appVersion,
    traceId: uuid(),
    message_id: uuid(),
    thread_id: input.threadId,
    // "auto" is the smart mode with Amazon Quick's own routing on
    agent_mode: input.model === "auto" ? "smart" : input.model,
    user_timezone: cfg.timezone,
    user_locale: cfg.locale,
    chat_agent_id: null,
    auto_routing: input.model === "auto",
    web_search_enabled: input.webSearch === true,
    pre_approved_tools: [],
    preload_skills: [],
    panel_edits: [],
    // custom_prompt carries the caller's instructions and stays with the
    // thread; null leaves the thread's as it is. Amazon Quick ignores a
    // system_prompt field on this frame.
    custom_prompt: String(input.systemPrompt ?? "").trim() ? input.systemPrompt : null,
    // an incognito thread stays out of Amazon Quick's chat list and memory
    incognito: !cfg.keepSessions,
  }
  if (input.thinkingEffort && input.thinkingEffort !== "off") payload.thinking_effort = input.thinkingEffort
  if (input.attachments?.length) payload.attachments = input.attachments
  return { type: "user_message", payload }
}

export const encodeFrame = (gateway, value) => (gateway ? gatewayEncode(JSON.stringify(value)) : aidpEncode(JSON.stringify(value)))

// The account fields the transport needs, merged with handshake defaults.
export function sessionFromAuth(auth, cfg) {
  return {
    jwt: auth?.idToken || auth?.access || "",
    wsHost: auth?.wsHost ?? "",
    wsPath: auth?.wsPath ?? "",
    provider: auth?.quickProvider ?? "social",
    actorArn: auth?.actorArn ?? "",
    surface: cfg.surface,
    outpostId: cfg.outpostId,
    workingSessionId: cfg.workingSessionId,
  }
}

export function dialInfo(sess) {
  if (!sess.jwt) throw new UpstreamError("handshake", "the account has no id_token; sign in again", 401)
  if (!String(sess.wsHost).trim()) throw new UpstreamError("handshake", "the account has no ws_host; sign in again", 401)
  const gateway = isGatewayProvider(sess.provider)

  let host = sess.wsHost.trim().replace(/\/+$/, "")
  if (host.startsWith("https://")) host = "wss://" + host.slice("https://".length)
  else if (!host.startsWith("wss://") && !host.startsWith("ws://")) host = "wss://" + host
  let path = String(sess.wsPath ?? "").trim() || (gateway ? GATEWAY_WS_PATH : DEFAULT_WS_PATH)
  let target
  if (/^https?:\/\//.test(path)) target = path
  else target = host + (path.startsWith("/") ? path : "/" + path)

  let url
  try {
    url = new URL(target)
  } catch {
    throw new UpstreamError("transport", `invalid ws_url ${JSON.stringify(target)}`)
  }
  if (!gateway) {
    if (sess.surface) url.searchParams.set("surfaceType", sess.surface)
    if (sess.outpostId) url.searchParams.set("outpostId", sess.outpostId)
    if (sess.workingSessionId) url.searchParams.set("workingSessionId", sess.workingSessionId)
    // Social AIDP transports take the bearer in the query; enterprise
    // relies on the Authorization header.
    if (String(sess.provider).toLowerCase() === "social") url.searchParams.set("token", sess.jwt)
  }

  const headers = {
    Authorization: `Bearer ${sess.jwt}`,
    Origin: "file://",
    "X-Surface-Type": sess.surface ?? "",
    "X-Outpost-Id": sess.outpostId ?? "",
    "X-Agent-Service-Type": "UNIFIED_QUICK",
  }
  if (sess.workingSessionId) headers["X-Working-Session-Id"] = sess.workingSessionId
  return { url: url.toString(), headers, gateway }
}

// The HTTP status a refused upgrade got. Not every Bun build reports it on
// the WebSocket error, so the upgrade is asked for once more over fetch.
async function upgradeStatus(url, headers, proxy) {
  try {
    const res = await fetch(url.replace(/^ws/, "http"), {
      headers: {
        ...headers,
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64"),
      },
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
      ...(proxy ? { proxy } : {}),
    })
    res.body?.cancel().catch(() => {})
    return res.status === 101 ? 0 : res.status
  } catch {
    return 0
  }
}

function deltaText(payload) {
  if (typeof payload === "string") return payload
  if (!payload || typeof payload !== "object") return ""
  if (typeof payload.delta === "string" && payload.delta) return payload.delta
  return typeof payload.text === "string" ? payload.text : ""
}

function rawText(value) {
  if (value === undefined || value === null) return ""
  return typeof value === "string" ? value : JSON.stringify(value)
}

function errorText(env) {
  const p = env.payload && typeof env.payload === "object" ? env.payload : {}
  for (const s of [p.message, p.error, env.message, env.error, p.code, env.code, env.error_code]) if (typeof s === "string" && s.trim()) return s
  return "unknown upstream error"
}

const present = (v) => v !== undefined && v !== null

// Sends one prompt and resolves with { text, toolCalls, usage }. Text deltas
// and tool calls are reported through onEvent as they arrive:
// { type: "text", text } | { type: "tool_call" | "tool_call_update", toolCall }.
export function chat({ session, cfg, input, signal, onEvent }) {
  const { url, headers, gateway } = dialInfo(session)
  const threadId = String(input.threadId ?? "").trim() || uuid()
  const title = String(input.title ?? "").trim() || titleFor(input.prompt)

  return new Promise((resolve, reject) => {
    const usage = { prompt: 0, completion: 0, total: 0, cacheRead: 0, cacheWrite: 0, model: "" }
    const chunks = new Map()
    const tools = new Map()
    const sent = new Set()
    const partialArgs = new Map()
    let text = ""
    let opened = false
    let settled = false
    let idleTimer = null
    let completeTimer = null
    let pingTimer = null
    let handshakeTimer = null
    let dialTimer = null
    let requestTimer = null

    const options = { headers }
    if (cfg.proxy) options.proxy = cfg.proxy
    let ws
    try {
      ws = new WebSocket(url, options)
    } catch (e) {
      reject(new UpstreamError("transport", `upstream WebSocket dial failed: ${e.message}`))
      return
    }
    ws.binaryType = "arraybuffer"

    const send = (value) => ws.send(encodeFrame(gateway, value))

    const cleanup = () => {
      for (const t of [idleTimer, completeTimer, handshakeTimer, requestTimer, dialTimer]) clearTimeout(t)
      clearInterval(pingTimer)
      signal?.removeEventListener("abort", onAbort)
      try {
        ws.close()
      } catch {}
    }

    const result = () => {
      const toolCalls = []
      for (const tc of tools.values()) {
        if (!tc.name.trim()) tc.name = "unknown"
        if (!tc.arguments.trim()) {
          const partial = (partialArgs.get(tc.id) ?? "").trim()
          let valid = false
          try {
            valid = partial !== "" && JSON.parse(partial) !== undefined
          } catch {}
          tc.arguments = valid ? partial : "{}"
        }
        toolCalls.push({ ...tc })
      }
      return { text, toolCalls, usage }
    }

    const succeed = () => {
      if (settled) return
      settled = true
      const res = result()
      cleanup()
      resolve(res)
    }

    const fail = (error) => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }

    // A dropped connection after the reply started still counts as a reply.
    const dropped = (error) => (text || tools.size ? succeed() : fail(error))

    function onAbort() {
      fail(signal.reason instanceof Error ? signal.reason : new DOMException("The request was aborted", "AbortError"))
    }
    if (signal?.aborted) return onAbort()
    signal?.addEventListener("abort", onAbort, { once: true })

    const armIdle = () => {
      clearTimeout(idleTimer)
      idleTimer = setTimeout(() => dropped(new UpstreamError("timeout", "upstream WebSocket read timed out")), READ_IDLE_MS)
    }

    const emit = (event) => {
      try {
        onEvent?.(event)
      } catch (e) {
        fail(e)
      }
    }
    const emitTool = (tc) => {
      if (sent.has(tc.id)) return
      sent.add(tc.id)
      emit({ type: "tool_call", toolCall: { ...tc } })
    }
    const emitOrUpdate = (tc) => (sent.has(tc.id) ? emit({ type: "tool_call_update", toolCall: { ...tc } }) : emitTool(tc))

    const getTool = (id, name) => {
      id = String(id ?? "").trim() || callId()
      let tc = tools.get(id)
      if (!tc) {
        tc = { id, name: "", arguments: "", result: "", status: "" }
        tools.set(id, tc)
      }
      if (typeof name === "string" && name.trim()) tc.name = name.trim()
      return tc
    }
    const toolId = (p) => p.tool_id || p.tool_call_id || p.toolCallId

    // A long event arrives as _chunked_frame pieces, in any order.
    const chunked = (p) => {
      const { chunk_id: id, chunk_index: index, total_chunks: total, data } = p
      if (typeof id !== "string" || !id || typeof data !== "string") return
      if (!Number.isInteger(index) || !Number.isInteger(total) || total < 1 || total > 4096 || index < 0 || index >= total) return
      let entry = chunks.get(id)
      if (!entry || entry.parts.length !== total) chunks.set(id, (entry = { parts: new Array(total).fill(null), have: 0 }))
      if (entry.parts[index] === null) entry.have++
      entry.parts[index] = data
      if (entry.have < total) return
      chunks.delete(id)
      let env
      try {
        env = JSON.parse(entry.parts.join(""))
      } catch {
        return
      }
      if (env && typeof env === "object") handle(env)
    }

    const handle = (env) => {
      const p = env.payload && typeof env.payload === "object" ? env.payload : {}
      switch (env.type) {
        case "_chunked_frame":
          return chunked(env.payload && typeof env.payload === "object" ? p : env)
        case "thinking_delta": {
          const delta = deltaText(env.payload)
          if (delta) emit({ type: "reasoning", text: delta })
          return
        }
        case "guardrail_blocked":
          return fail(new UpstreamError("blocked", String(p.message || env.message || "Amazon Quick's guardrail blocked the reply")))
        case "text_delta": {
          const delta = deltaText(env.payload)
          if (!delta) return
          text += delta
          emit({ type: "text", text: delta })
          return
        }
        case "text_complete":
          if (!text && typeof p.text === "string" && p.text) {
            text = p.text
            emit({ type: "text", text: p.text })
          }
          return
        case "turn_usage":
          usage.prompt += Number(p.input_tokens) || 0
          usage.completion += Number(p.output_tokens) || 0
          usage.total += Number(p.total_tokens) || 0
          usage.cacheRead += Number(p.cache_read_tokens) || 0
          usage.cacheWrite += Number(p.cache_write_tokens) || 0
          if (typeof p.resolved_model_id === "string") usage.model = p.resolved_model_id
          return
        case "tool_start": {
          const tc = getTool(toolId(p), p.tool_name)
          const args = argumentString(p.arguments)
          if (args !== "{}") tc.arguments = args
          return
        }
        case "tool_arguments":
        case "tool_arguments_edited": {
          const tc = getTool(toolId(p), p.tool_name)
          if (present(p.arguments)) tc.arguments = argumentString(p.arguments)
          emitOrUpdate(tc)
          return
        }
        case "tool_progress": {
          const id = toolId(p)
          const delta = p.input_delta || p.progress?.input_delta
          if (id && typeof delta === "string" && delta) partialArgs.set(id, (partialArgs.get(id) ?? "") + delta)
          return
        }
        case "tool_result": {
          const tc = getTool(toolId(p), p.tool_name)
          if (present(p.arguments)) tc.arguments = argumentString(p.arguments)
          tc.result = p.error ? String(p.error) : rawText(p.result)
          tc.status = p.error ? "error" : String(p.status ?? "")
          emitTool(tc)
          return
        }
        case "tool_error": {
          const tc = getTool(toolId(p), p.tool_name)
          tc.status = "error"
          tc.result = String(p.error || p.message || "")
          emitTool(tc)
          return
        }
        case "tool_complete": {
          const tc = getTool(toolId(p), p.tool_name)
          if (!tc.status) tc.status = "complete"
          emitTool(tc)
          return
        }
        case "tool_call":
        case "tool_call_update": {
          const tc = getTool(toolId(p), p.tool_name || p.title)
          const args = [p.rawInput, p.raw_input, p.arguments].find(present)
          if (present(args)) tc.arguments = argumentString(args)
          emitOrUpdate(tc)
          return
        }
        case "message_complete":
          for (const item of Array.isArray(p.tool_calls) ? p.tool_calls : []) {
            const tc = getTool(item?.id || item?.tool_call_id, item?.name || item?.tool_name || item?.function?.name)
            const args = [item?.arguments, item?.function?.arguments].find(present)
            if (present(args)) tc.arguments = argumentString(args)
            emitTool(tc)
          }
          clearTimeout(completeTimer)
          completeTimer = p.continuation_expected ? null : setTimeout(succeed, AFTER_COMPLETE_MS)
          return
        default:
          if (FAILURES.has(env.type)) {
            const code = String(p.code ?? env.code ?? "")
            if (code === "FrameTooLarge") return fail(new UpstreamError("too_large", errorText(env)))
            return fail(new UpstreamError("upstream", `upstream ${env.type}: ${errorText(env)}`))
          }
          if (TERMINAL.has(env.type)) succeed()
      }
    }

    ws.onopen = () => {
      opened = true
      clearTimeout(handshakeTimer)
      clearTimeout(dialTimer)
      try {
        // The AIDP and Gateway paths use different session_connect shapes.
        if (gateway) send({ type: "session_connect", session_id: session.outpostId })
        else
          send({
            type: "session_connect",
            payload: {
              actor_id: session.actorArn,
              surfaceType: session.surface,
              outpostId: session.outpostId,
              appVersion: cfg.appVersion,
              external_agent_sign_in: 1,
              recents_promotion: 1,
            },
          })
        send({ type: "federate_status", payload: {} })
        // A thread that shows in Amazon Quick's chat list is created with a
        // title; an incognito one starts with its first message.
        if (cfg.keepSessions && !input.resume) send({ type: "session_create", payload: { session_id: threadId, title } })
        send(userMessage(session, cfg, { ...input, threadId }))
      } catch (e) {
        return fail(new UpstreamError("transport", `send user_message: ${e.message}`))
      }
      armIdle()
      // Amazon Quick ends a socket whose client sent no message for 95
      // seconds (IDLE_TIMEOUT), and a WebSocket-level ping does not count:
      // a ping message keeps a long reply alive, the WebSocket ping keeps
      // proxies on the way from closing it.
      pingTimer = setInterval(() => {
        try {
          send({ type: "ping", payload: { timestamp: Date.now() } })
          ws.ping?.("ping")
        } catch {}
      }, cfg.keepaliveMs > 0 ? cfg.keepaliveMs : PING_MS)
    }

    ws.onmessage = (event) => {
      if (settled) return
      armIdle()
      let frames
      try {
        if (typeof event.data === "string") frames = [event.data]
        else frames = gateway ? gatewayDecode(event.data) : aidpDecode(event.data)
      } catch (e) {
        // an event-stream error frame is the service refusing the turn
        if (/^upstream error \[/.test(e.message)) fail(new UpstreamError("upstream", e.message))
        return
      }
      for (const frame of frames) {
        if (settled) return
        let env
        try {
          env = JSON.parse(frame)
        } catch {
          continue
        }
        if (env && typeof env === "object") handle(env)
      }
    }

    let refused = false
    ws.onerror = (event) => {
      const message = String(event?.message || event?.error?.message || "connection error")
      if (!opened) {
        const dialFailed = (status) =>
          fail(new UpstreamError("handshake", `upstream WebSocket dial failed${status ? ` HTTP ${status}` : ""}: ${message}`, status))
        const status = Number(/status code: (\d{3})/.exec(message)?.[1]) || 0
        if (status || !/Expected 101/.test(message)) return dialFailed(status)
        refused = true
        return void upgradeStatus(url, headers, cfg.proxy).then(dialFailed)
      }
      dropped(new UpstreamError("transport", `upstream WebSocket read: ${message}`))
    }

    ws.onclose = (event) => {
      if (refused) return
      if (!opened) return fail(new UpstreamError("handshake", `upstream WebSocket dial failed: closed (${event?.code ?? 0})`))
      dropped(new UpstreamError("transport", `upstream WebSocket read: closed (${event?.code ?? 0}) ${event?.reason ?? ""}`.trim()))
    }

    handshakeTimer = setTimeout(() => fail(new UpstreamError("timeout", "upstream WebSocket handshake timed out")), HANDSHAKE_MS)
    dialTimer = setTimeout(() => {
      if (!opened) fail(new UpstreamError("handshake", "upstream WebSocket dial timed out", 0))
    }, DIAL_MS)
    requestTimer = setTimeout(() => fail(new UpstreamError("timeout", "the upstream request timed out")), cfg.requestTimeoutMs)
  })
}
