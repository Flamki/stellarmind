/**
 * OpenAI Provider - Placeholder for future multi-LLM support
 */
import { ProviderInterface } from './interface.js'
const PLACEHOLDER = {
  content: 'OpenAI provider is not yet configured. Set OPENAI_API_KEY and install openai npm package.',
  model: 'openai-placeholder', provider: 'openai', latencyMs: 0,
}
export class OpenAIProvider extends ProviderInterface {
  constructor(apiKey) { super(); this.apiKey = apiKey||''; this._configured = !!apiKey }
  get name() { return 'openai' }
  get capabilities() { return ['research','summary','analysis','code'] }
  async healthCheck() { return this._configured }
  async research(i,o) { return this._configured ? (()=>{throw new Error('Not implemented')})() : PLACEHOLDER }
  async summary(i,o) { return this._configured ? (()=>{throw new Error('Not implemented')})() : PLACEHOLDER }
  async analysis(i,o) { return this._configured ? (()=>{throw new Error('Not implemented')})() : PLACEHOLDER }
  async code(i,o) { return this._configured ? (()=>{throw new Error('Not implemented')})() : PLACEHOLDER }
}
export function createOpenAIProvider(apiKey) { return apiKey ? new OpenAIProvider(apiKey) : null }