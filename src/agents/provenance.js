/**
 * Output provenance helpers (issue #153).
 *
 * A prompt revision is the SHA-256 digest of the instruction template, so it
 * only changes when the wording changes. A prompt digest covers the exact
 * rendered prompt (template + caller input). Only digests are stored, never
 * credentials or the prompt text itself.
 */
import crypto from 'node:crypto'

/** Stable short digest of a string, e.g. `sha256:3f2a9c4e1b7d`. */
export function promptDigest(text) {
  const hex = crypto.createHash('sha256').update(String(text), 'utf8').digest('hex')
  return `sha256:${hex.slice(0, 16)}`
}

/** Substitute `{input}` literally (a function replacer avoids `$&` surprises). */
export function renderPromptTemplate(template, input) {
  return template.replace('{input}', () => String(input))
}
