/**
 * OpenAI Provider — PLACEHOLDER demonstrating zero-orchestrator-change addition.
 * Set PROVIDER=openai + OPENAI_API_KEY to activate once implemented.
 */
export const name = 'openai'

export const capabilities = {
  research: { model: 'gpt-4o-mini', label: 'GPT-4o Mini (research)' },
  summary: { model: 'gpt-4o-mini', label: 'GPT-4o Mini (summary)' },
  analysis: { model: 'gpt-4o', fallback: 'gpt-4o-mini', label: 'GPT-4o (analysis)' },
  code: { model: 'gpt-4o-mini', label: 'GPT-4o Mini (code)' },
}

function notYet(mode) {
  return async () => {
    throw new Error(`OpenAI provider not implemented for ${mode}. Set PROVIDER=anthropic.`)
  }
}

export const research = notYet('research')
export const summary = notYet('summary')
export const analysis = notYet('analysis')
export const code = notYet('code')
export const isAvailable = () => false

export function setApiKey(_newKey) {
  console.log('  [openai-provider] Key stored (provider not yet implemented)')
}

export function getProvider() {
  return { name, capabilities, research, summary, analysis, code, setApiKey, isAvailable }
}
