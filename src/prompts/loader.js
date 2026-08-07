import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const PROMPTS_DIR = join(dirname(__filename), '..', 'prompts')

export function loadPrompt(name, vars = {}) {
  const filePath = join(PROMPTS_DIR, `${name}.txt`)
  if (!existsSync(filePath)) throw new Error(`Prompt not found: ${name}.txt`)
  let template = readFileSync(filePath, 'utf-8')
  for (const [key, value] of Object.entries(vars))
    template = template.replaceAll(`{{${key}}}`, String(value))
  const unresolved = template.match(/\{\{(\w+)\}\}/g)
  if (unresolved) console.warn(`Prompt [${name}]: unresolved: ${unresolved.join(', ')}`)
  return template
}
