/**
 * Anthropic Provider - Claude-powered LLM implementation
 */
import Anthropic from "@anthropic-ai/sdk"
import { ProviderInterface } from "./interface.js"

const MODEL_MAP = {
  research: "claude-haiku-4-5-20251001",
  summary: "claude-haiku-4-5-20251001",
  analysisPrimary: "claude-sonnet-4-5-20250929",
  analysisFallback: "claude-haiku-4-5-20251001",
  code: "claude-haiku-4-5-20251001",
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

function withTimeout(promise, timeoutMs) {
  return Promise.race([promise, new Promise((_, reject) =>
    setTimeout(() => { const e = new Error("LLM timeout"); e.code="LLM_TIMEOUT"; e.status=408; reject(e) }, timeoutMs)
  )])
}

function isTransient(err) {
  const s = err?.status
  if ([408,409,429,500,502,503,504].includes(s)) return true
  const m = String(err?.message||"").toLowerCase()
  return m.includes("timeout")||m.includes("temporar")||m.includes("rate limit")||m.includes("overloaded")||m.includes("network")
}

export class AnthropicProvider extends ProviderInterface {
  constructor(config={}) {
    super()
    this.apiKey = config.apiKey || ""
    this.requestTimeoutMs = config.requestTimeoutMs || 20000
    this.maxRetries = config.maxRetries || 2
    this.retryBaseDelayMs = config.retryBaseDelayMs || 500
    this._client = null
  }

  get client() {
    if (!this._client && this.apiKey) this._client = new Anthropic({ apiKey: this.apiKey })
    return this._client
  }

  get name() { return "anthropic" }
  get capabilities() { return ["research","summary","analysis","code"] }

  async healthCheck() {
    try {
      if (!this.apiKey || !this.client) return false
      await this.client.messages.create({ model: MODEL_MAP.research, max_tokens: 1, messages: [{role:"user",content:"ping"}] })
      return true
    } catch { return false }
  }

  _buildPayload(capability, input) {
    const systems = {
      research: "You are a research assistant. Provide thorough, well-organized analysis.",
      summary: "You are a summarization expert. Condense text into key insights.",
      analysis: "You are a strategic analyst. Provide deep, structured analysis.",
      code: "You are a senior software engineer. Write clean, production-ready code.",
    }
    return {
      model: capability==="analysis" ? MODEL_MAP.analysisPrimary : MODEL_MAP[capability]||MODEL_MAP.research,
      max_tokens: capability==="analysis" ? 4096 : 2048,
      system: systems[capability]||systems.research,
      messages: [{ role: "user", content: input }],
    }
  }

  async _sendMessage(payload, options={}) {
    const tMs = options.timeoutMs ?? this.requestTimeoutMs
    const maxR = options.maxRetries ?? this.maxRetries
    const baseD = options.baseDelayMs ?? this.retryBaseDelayMs
    let attempt = 0
    while (true) {
      try { return await withTimeout(this.client.messages.create(payload), tMs) }
      catch(err) {
        if (!isTransient(err)) throw err
        if (attempt >= maxR) throw err
        const d = baseD * 2**attempt
        console.warn("Anthropic retry", {attempt: attempt+1, delayMs: d})
        await sleep(d)
        attempt++
      }
    }
  }

  async _call(capability, input, options) {
    const start = Date.now()
    const r = await this._sendMessage(this._buildPayload(capability, input), options)
    return { content: r.content[0]?.text||"", model: r.model, provider: "anthropic",
      latencyMs: Date.now()-start,
      usage: r.usage ? { inputTokens: r.usage.input_tokens, outputTokens: r.usage.output_tokens } : undefined }
  }

  async research(input, options) { return this._call("research", input, options) }
  async summary(input, options) { return this._call("summary", input, options) }
  async code(input, options) { return this._call("code", input, options) }

  async analysis(input, options) {
    try { return await this._call("analysis", input, options) }
    catch(err) {
      console.warn("Analysis fallback to Haiku:", err.message)
      const fb = { model: MODEL_MAP.analysisFallback, max_tokens: 2048,
        system: "You are a strategic analyst.", messages: [{role:"user",content:input}] }
      const r = await this._sendMessage(fb, {...options, maxRetries:0})
      const start = Date.now()
      return { content: r.content[0]?.text||"", model: r.model, provider: "anthropic",
        latencyMs: Date.now()-start, fallbackUsed: true }
    }
  }
}
