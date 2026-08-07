/**
 * OpenAI Provider — PLACEHOLDER. Set PROVIDER=openai to activate when implemented.
 */
export const name = 'openai'
export const capabilities = {
  research: { model: 'gpt-4o-mini', label: 'GPT-4o Mini' },
  summary: { model: 'gpt-4o-mini', label: 'GPT-4o Mini' },
  analysis: { model: 'gpt-4o', fallback: 'gpt-4o-mini', label: 'GPT-4o' },
  code: { model: 'gpt-4o-mini', label: 'GPT-4o Mini' },
}
function notYet(mode) { return async () => { throw new Error(`OpenAI ${mode} not implemented. Use PROVIDER=anthropic.`) } }
export const research = notYet('research')
export const summary = notYet('summary')
export const analysis = notYet('analysis')
export const code = notYet('code')
export const isAvailable = () => false
export function setApiKey(_k) {}
export function getProvider() {
  return { name, capabilities, research, summary, analysis, code, setApiKey, isAvailable }
}
