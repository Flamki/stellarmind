/**
 * Prompt Template Loader — StellarMind
 * Loads and renders versioned prompt templates.
 * Stellar Wave bounty #24
 */

const fs = require('fs');
const path = require('path');

const PROMPTS_DIR = path.join(__dirname);

const CACHE = new Map();

/**
 * Load a prompt template from disk.
 * Templates support {variable} placeholders.
 * @param {string} name — template filename without .txt extension
 * @returns {string} raw template
 */
function loadTemplate(name) {
  if (CACHE.has(name)) return CACHE.get(name);
  const filePath = path.join(PROMPTS_DIR, `${name}.txt`);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Prompt template not found: ${name}.txt`);
  }
  const content = fs.readFileSync(filePath, 'utf8');
  CACHE.set(name, content);
  return content;
}

/**
 * Render a prompt template with variables.
 * @param {string} name — template name
 * @param {Object} variables — key-value pairs to substitute
 * @returns {string} rendered prompt
 */
function render(name, variables = {}) {
  let template = loadTemplate(name);
  for (const [key, value] of Object.entries(variables)) {
    template = template.replace(new RegExp(`\\{${key}\\}`, 'g'), String(value));
  }
  return template;
}

/**
 * List all available prompt templates.
 */
function listTemplates() {
  return fs.readdirSync(PROMPTS_DIR)
    .filter(f => f.endsWith('.txt'))
    .map(f => f.replace('.txt', ''));
}

/**
 * Reload all templates (clears cache).
 */
function reloadAll() {
  CACHE.clear();
}

module.exports = { loadTemplate, render, listTemplates, reloadAll };
