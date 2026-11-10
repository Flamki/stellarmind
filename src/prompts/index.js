/**
 * Prompt Template Loader & Revision Tracker — StellarMind
 * Loads, renders, and computes reproducible content digests for versioned prompts.
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const PROMPTS_DIR = path.dirname(__filename)

const CACHE = new Map()

export const PROMPT_SCHEMA_VERSION = '1.0.0'

export const AGENT_PROMPT_TEMPLATES = {
  orchestrator:
    'You are a task orchestrator for an AI agent marketplace. Break this task into 2-3 subtasks and choose which agents to use.',
  'research-bot':
    'You are a research agent. Research this topic thoroughly but concisely (4-5 sentences with key facts and data points): {topic}',
  'summary-bot':
    'You are a summarization agent. Summarize the following text in 2-3 clear, concise sentences capturing the key points:\n\n{text}',
  'analyst-bot': `You are a strategic analysis agent. Provide a structured analysis of the following topic. Include:
1. **Key Findings** (3-4 bullet points)
2. **Risks** (2-3 potential concerns)
3. **Opportunities** (2-3 actionable opportunities)

Topic: {topic}`,
  'code-bot':
    'You are a code assistant agent. Help with the following code task. Be concise and provide working code:\n\n{prompt}',
}

/**
 * Compute a deterministic SHA-256 content digest for a prompt string.
 * @param {string} content
 * @returns {string}
 */
export function computePromptDigest(content) {
  const normalized = String(content ?? '')
    .replace(/\r\n/g, '\n')
    .trim()
  const hash = crypto.createHash('sha256').update(normalized, 'utf8').digest('hex')
  return `sha256:${hash.slice(0, 12)}`
}

/**
 * Build a reproducible prompt revision record from template name and content.
 * @param {string} templateName
 * @param {string} content
 * @param {string} [version]
 */
export function buildPromptRevision(templateName, content, version = PROMPT_SCHEMA_VERSION) {
  const name = templateName || 'inline'
  const digest = computePromptDigest(content)
  return {
    template: name,
    version,
    digest,
    revision: `${name}@${version}#${digest}`,
  }
}

/**
 * Return the prompt revision metadata for a registered agent or custom template override.
 * @param {string} agentId
 * @param {string} [customContent]
 */
export function getAgentPromptRevision(agentId, customContent) {
  const templateContent =
    customContent !== undefined ? customContent : AGENT_PROMPT_TEMPLATES[agentId] || String(agentId)
  return buildPromptRevision(agentId || 'unknown', templateContent)
}

/**
 * Load a prompt template from disk.
 * Templates support {variable} placeholders.
 * @param {string} name — template filename without .txt extension
 * @returns {string} raw template
 */
export function loadTemplate(name) {
  if (CACHE.has(name)) return CACHE.get(name)
  const filePath = path.join(PROMPTS_DIR, `${name}.txt`)
  if (!fs.existsSync(filePath)) {
    throw new Error(`Prompt template not found: ${name}.txt`)
  }
  const content = fs.readFileSync(filePath, 'utf8')
  CACHE.set(name, content)
  return content
}

/**
 * Render a prompt template with variables.
 * @param {string} name — template name
 * @param {Object} variables — key-value pairs to substitute
 * @returns {string} rendered prompt
 */
export function render(name, variables = {}) {
  let template = loadTemplate(name)
  for (const [key, value] of Object.entries(variables)) {
    template = template.replace(new RegExp(`\\{${key}\\}`, 'g'), String(value))
  }
  return template
}

/**
 * List all available prompt templates.
 */
export function listTemplates() {
  return fs
    .readdirSync(PROMPTS_DIR)
    .filter((f) => f.endsWith('.txt'))
    .map((f) => f.replace('.txt', ''))
}

/**
 * Reload all templates (clears cache).
 */
export function reloadAll() {
  CACHE.clear()
}
