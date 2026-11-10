import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { AGENTS } from '../src/agents/registry.js'
import { pricingConfig } from '../src/pricing.config.js'
import { validatePricingConfig } from '../src/pricing.validator.js'
import { registerPremiumRoutes } from '../src/routes/premium-routes.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT_DIR = path.resolve(__dirname, '..')

const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8'))
const contributingMd = fs.readFileSync(path.join(ROOT_DIR, 'CONTRIBUTING.md'), 'utf8')
const repositoryMapMd = fs.readFileSync(path.join(ROOT_DIR, 'docs/repository-map.md'), 'utf8')

function extractNpmRunCommands(markdown) {
  const matches = [...markdown.matchAll(/\bnpm run ([a-zA-Z0-9:_-]+)/g)]
  return [...new Set(matches.map((m) => m[1]))]
}

function extractConcreteRepoPaths(markdown) {
  const matches = [
    ...markdown.matchAll(/`((?:src|docs|tests|public)\/[a-zA-Z0-9._/-]+\.[a-zA-Z0-9]+)`/g),
  ]
  return [...new Set(matches.map((m) => m[1]).filter((p) => !p.includes('<') && !p.includes('*')))]
}

describe('Contributor documentation and agent extension guide consistency (#185)', () => {
  it('documents every verification and test script from package.json in CONTRIBUTING.md', () => {
    const requiredCommands = [
      'npm test',
      'npm run test:validation',
      'npm run test:parser',
      'npm run test:budget',
      'npm run test:usage',
      'npm run test:premium',
      'npm run test:normalization',
      'npm run test:recovery',
      'npm run test:queue',
      'npm run smoke',
      'npm run demo',
      'npm run preflight',
    ]

    for (const cmd of requiredCommands) {
      assert.ok(
        contributingMd.includes(`\`${cmd}\``),
        `Expected CONTRIBUTING.md to document command \`${cmd}\``
      )
    }

    assert.ok(
      !contributingMd.includes('Same as demo') && !contributingMd.includes('Same as `demo`'),
      'CONTRIBUTING.md must not claim npm test is the same as demo'
    )
    assert.ok(
      !repositoryMapMd.includes('npx jest'),
      'docs/repository-map.md must not reference npx jest'
    )
  })

  it('every npm run <script> referenced in CONTRIBUTING.md and docs/repository-map.md exists in package.json', () => {
    const scripts = packageJson.scripts || {}
    for (const [docName, content] of [
      ['CONTRIBUTING.md', contributingMd],
      ['docs/repository-map.md', repositoryMapMd],
    ]) {
      const referenced = extractNpmRunCommands(content)
      assert.ok(referenced.length > 0, `Expected npm run commands in ${docName}`)
      for (const scriptName of referenced) {
        assert.ok(
          Object.prototype.hasOwnProperty.call(scripts, scriptName),
          `${docName} references "npm run ${scriptName}", which does not exist in package.json scripts`
        )
      }
    }
  })

  it('every concrete repository file path referenced in CONTRIBUTING.md and docs/repository-map.md exists on disk', () => {
    for (const [docName, content] of [
      ['CONTRIBUTING.md', contributingMd],
      ['docs/repository-map.md', repositoryMapMd],
    ]) {
      const paths = extractConcreteRepoPaths(content)
      assert.ok(paths.length > 0, `Expected concrete file paths in ${docName}`)
      for (const relPath of paths) {
        const fullPath = path.join(ROOT_DIR, relPath)
        assert.ok(
          fs.existsSync(fullPath),
          `${docName} references non-existent file path "${relPath}"`
        )
      }
    }
  })

  it('guides contributors through all current agent-extension modules and verifies catalog/pricing/route alignment', () => {
    const requiredModules = [
      'src/pricing.config.js',
      'src/pricing.validator.js',
      'src/agents/registry.js',
      'src/agents/services.js',
      'src/requestValidation.js',
      'src/routes/premium-routes.js',
      'src/app.js',
      'src/agents/orchestrator.js',
    ]

    for (const mod of requiredModules) {
      assert.ok(
        contributingMd.includes(mod),
        `Expected CONTRIBUTING.md agent-extension instructions to reference ${mod}`
      )
    }

    // Verify the documented consistency invariant holds for all registered agents
    const validation = validatePricingConfig(pricingConfig)
    assert.equal(validation.valid, true)

    const registeredRoutes = new Set()
    const fakeApp = {
      get(routePath) {
        registeredRoutes.add(routePath)
      },
    }
    registerPremiumRoutes(fakeApp, {
      pricingConfig,
      broadcast: () => {},
      runResearch: async () => '',
      runSummary: async () => '',
      runAnalysis: async () => '',
      runCode: async () => '',
      MODEL_LABELS: {},
    })

    const allPricing = pricingConfig.getAllPricingInfo()
    for (const agent of AGENTS) {
      const pricedEntry = allPricing.find((entry) => entry.agent === agent.id)
      assert.ok(
        pricedEntry,
        `Agent ${agent.id} must have a matching entry in src/pricing.config.js`
      )
      const routePath = pricedEntry.endpoint.replace(/^GET\s+/, '')
      assert.ok(
        registeredRoutes.has(routePath),
        `Agent ${agent.id} premium route ${routePath} must be registered in src/routes/premium-routes.js`
      )
      assert.equal(pricingConfig.getPrice(pricedEntry.endpoint), `$${agent.price}`)
    }
  })
})
