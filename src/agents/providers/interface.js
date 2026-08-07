/**
 * Provider Interface - Multi-LLM abstraction layer
 */
export class ProviderInterface {
  async research(input, options) { throw new Error('Not implemented: research()') }
  async summary(input, options) { throw new Error('Not implemented: summary()') }
  async analysis(input, options) { throw new Error('Not implemented: analysis()') }
  async code(input, options) { throw new Error('Not implemented: code()') }
  get name() { throw new Error('Not implemented: name') }
  async healthCheck() { throw new Error('Not implemented: healthCheck()') }
  get capabilities() { return [] }
}