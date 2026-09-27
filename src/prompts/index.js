/**
 * Prompt Template Loader — StellarMind
 * Loads and renders versioned prompt templates.
 * Stellar Wave bounty #24
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PROMPTS_DIR = path.dirname(fileURLToPath(import.meta.url))

const CACHE = new Map()

/**
 * Load a prompt template from disk.
 * Templates support {variable} placeholders.
 * @param {string} name — template filename without .txt extension
 * @returns {string} raw template
 */
function loadTemplate(name) {
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
function render(name, variables = {}) {
  let template = loadTemplate(name)
  for (const [key, value] of Object.entries(variables)) {
    template = template.replace(new RegExp(`\\{${key}\\}`, 'g'), String(value))
  }
  return template
}

/**
 * Stable revision of a prompt: the same rendered content always yields the same
 * digest, different content yields a different one. Recorded next to results so a
 * stored output can be traced back to the exact prompt that produced it, without
 * keeping the prompt text (or anything secret) in the metadata.
 * @param {string} renderedPrompt — the prompt exactly as it was sent
 * @returns {string} 16 hex characters
 */
function revision(renderedPrompt) {
  return crypto
    .createHash('sha256')
    .update(String(renderedPrompt), 'utf8')
    .digest('hex')
    .slice(0, 16)
}

/**
 * Render a template and return the prompt together with its revision and source
 * template name, which is what callers should persist per step.
 * @param {string} name — template name
 * @param {Object} variables — key-value pairs to substitute
 * @returns {{prompt: string, revision: string, template: string}}
 */
function renderWithRevision(name, variables = {}) {
  const prompt = render(name, variables)
  return { prompt, revision: revision(prompt), template: name }
}

/**
 * List all available prompt templates.
 */
function listTemplates() {
  return fs
    .readdirSync(PROMPTS_DIR)
    .filter((f) => f.endsWith('.txt'))
    .map((f) => f.replace('.txt', ''))
}

/**
 * Reload all templates (clears cache).
 */
function reloadAll() {
  CACHE.clear()
}

export { loadTemplate, render, renderWithRevision, revision, listTemplates, reloadAll }
