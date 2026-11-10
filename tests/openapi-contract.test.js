/**
 * OpenAPI Specification & Composed Application Contract Tests (Issue #174)
 *
 * 1. Validates `docs/openapi.yaml` structure and compiles all schemas with Ajv.
 * 2. Validates documented JSON response examples in `docs/openapi.yaml` and
 *    `docs/API_EXAMPLES.md` against their OpenAPI schemas.
 * 3. Exercises the composed Express application (`createApp`) with deterministic
 *    local fixtures (no live model or payment access) across status, agents,
 *    validation errors, runs, and premium routes, checking status codes and
 *    response bodies against `docs/openapi.yaml`.
 * 4. Verifies that altered response fields or undocumented status codes fail
 *    with an actionable contract error.
 *
 * Run: node tests/openapi-contract.test.js
 */

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Ajv from 'ajv'
import * as yaml from 'js-yaml'
import { createApp } from '../src/app.js'
import { pricingConfig } from '../src/pricing.config.js'
import { InMemoryRunHistoryStore } from '../src/storage/run-history.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..')

const failures = []
let passed = 0

async function test(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (err) {
    failures.push({ name, err })
    console.error(`  ✗ ${name}\n      ${err.message.replace(/\n/g, '\n      ')}`)
  }
}

/**
 * Converts an OpenAPI 3.0 schema object (with `$ref` and `nullable: true`) into
 * a JSON Schema draft-07 object that Ajv can compile and validate.
 */
function resolveOpenApiSchema(node, rootSpec, seenRefs = new Set()) {
  if (!node || typeof node !== 'object') return node
  if (Array.isArray(node)) {
    return node.map((item) => resolveOpenApiSchema(item, rootSpec, seenRefs))
  }

  if (node.$ref) {
    const refPath = node.$ref
    if (!refPath.startsWith('#/components/schemas/')) {
      throw new Error(`Unsupported $ref in OpenAPI spec: ${refPath}`)
    }
    const schemaName = refPath.replace('#/components/schemas/', '')
    const target = rootSpec.components?.schemas?.[schemaName]
    if (!target) {
      throw new Error(`Unresolved $ref in OpenAPI spec: ${refPath}`)
    }
    if (seenRefs.has(refPath)) {
      return { type: 'object' }
    }
    const nextSeen = new Set(seenRefs)
    nextSeen.add(refPath)
    return resolveOpenApiSchema(target, rootSpec, nextSeen)
  }

  const clone = {}
  for (const [key, value] of Object.entries(node)) {
    if (key === 'nullable' || key === 'example' || key === 'examples') continue
    if (key === 'properties' && value && typeof value === 'object') {
      clone.properties = {}
      for (const [propName, propSchema] of Object.entries(value)) {
        clone.properties[propName] = resolveOpenApiSchema(propSchema, rootSpec, seenRefs)
      }
    } else if (key === 'items') {
      clone.items = resolveOpenApiSchema(value, rootSpec, seenRefs)
    } else {
      clone[key] = resolveOpenApiSchema(value, rootSpec, seenRefs)
    }
  }

  if (node.nullable === true) {
    if (typeof clone.type === 'string') {
      clone.type = [clone.type, 'null']
    } else if (Array.isArray(clone.type) && !clone.type.includes('null')) {
      clone.type = [...clone.type, 'null']
    } else if (!clone.type) {
      return { anyOf: [clone, { type: 'null' }] }
    }
  }

  return clone
}

function createContractValidator(spec) {
  const ajv = new Ajv({ allErrors: true, strict: false })

  function validateSchema(openApiSchema, payload, label) {
    const jsonSchema = resolveOpenApiSchema(openApiSchema, spec)
    const validate = ajv.compile(jsonSchema)
    const valid = validate(payload)
    if (!valid) {
      const details = (validate.errors || [])
        .map((e) => `${e.instancePath || '/'} ${e.message}`)
        .join('; ')
      throw new Error(`Contract validation failed for ${label}: ${details}`)
    }
  }

  function validateResponse(pathTemplate, method, statusCode, body) {
    const pathItem = spec.paths?.[pathTemplate]
    if (!pathItem) {
      throw new Error(`Undocumented path in OpenAPI spec: ${pathTemplate}`)
    }
    const operation = pathItem[method.toLowerCase()]
    if (!operation) {
      throw new Error(`Undocumented method ${method.toUpperCase()} for ${pathTemplate}`)
    }
    const responseSpec = operation.responses?.[String(statusCode)]
    if (!responseSpec) {
      throw new Error(
        `Undocumented status code ${statusCode} for ${method.toUpperCase()} ${pathTemplate} (documented: ${Object.keys(operation.responses || {}).join(', ')})`
      )
    }
    const mediaSchema = responseSpec.content?.['application/json']?.schema
    if (!mediaSchema) {
      throw new Error(
        `Missing application/json schema for ${method.toUpperCase()} ${pathTemplate} -> ${statusCode}`
      )
    }
    validateSchema(mediaSchema, body, `${method.toUpperCase()} ${pathTemplate} [${statusCode}]`)
  }

  return { ajv, validateSchema, validateResponse }
}

async function withServer(app, fn) {
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s))
  })
  const { port } = server.address()
  const baseUrl = `http://127.0.0.1:${port}`
  try {
    await fn(baseUrl)
  } finally {
    await new Promise((resolve) => server.close(() => resolve()))
  }
}

function createDeterministicFixtureApp(overrides = {}) {
  const store = new InMemoryRunHistoryStore(50)
  const stubConfig = {
    anthropicApiKey: 'sk-ant-fixture-key-123456',
    serverAddress: 'GFIXTURE_SERVER_ADDRESS_1234567890',
    orchestratorAddress: 'GFIXTURE_ORCH_ADDRESS_1234567890',
    buyerAddress: 'GFIXTURE_BUYER_ADDRESS_1234567890',
    facilitatorUrl: 'https://www.x402.org/facilitator',
    network: 'stellar:testnet',
    runHistoryStorage: 'memory',
    runHistoryFile: null,
    runHistoryMaxRuns: 50,
    orchestrationQueue: {
      maxConcurrent: 2,
      queueCapacity: 10,
      queueTimeoutMs: 30000,
    },
    ...overrides.config,
  }

  const stubPaymentMiddleware = (req, res, next) => {
    if (req.path.startsWith('/api/premium/')) {
      if (req.header('x-payment') !== 'valid-fixture-payment') {
        return res.status(402).json({
          error: 'payment_required',
          message: 'x402 payment required for premium agent route',
          network: 'stellar:testnet',
        })
      }
    }
    next()
  }

  const stubPremiumServices = {
    runResearch: async (topic) => `Deterministic research result for ${topic}`,
    runSummary: async (text) => `Deterministic summary result for ${text.slice(0, 32)}`,
    runAnalysis: async (topic) => `Deterministic analysis result for ${topic}`,
    runCode: async (prompt) => `Deterministic code result for ${prompt}`,
    MODEL_LABELS: {
      research: 'claude-haiku-4-5-20251001',
      summary: 'claude-haiku-4-5-20251001',
      analysis: 'claude-sonnet-4-5-20250929 (fallback: claude-haiku-4-5-20251001)',
      code: 'claude-haiku-4-5-20251001',
    },
    ...overrides.premiumServices,
  }

  const { app, close } = createApp({
    config: stubConfig,
    pricingConfig,
    runHistoryStore: store,
    paymentMiddleware:
      overrides.paymentMiddleware !== undefined
        ? overrides.paymentMiddleware
        : stubPaymentMiddleware,
    premiumServices: stubPremiumServices,
  })

  return { app, close, store }
}

function extractSectionJsonBlocks(markdown, headingText) {
  const headingIdx = markdown.indexOf(headingText)
  if (headingIdx === -1) {
    throw new Error(`Heading not found in docs/API_EXAMPLES.md: ${headingText}`)
  }
  const nextSectionIdx = markdown.indexOf('\n### ', headingIdx + headingText.length)
  const slice =
    nextSectionIdx === -1 ? markdown.slice(headingIdx) : markdown.slice(headingIdx, nextSectionIdx)

  const blocks = []
  const regex = /(`{3,4})json\r?\n([\s\S]*?)\1/g
  let match
  while ((match = regex.exec(slice)) !== null) {
    blocks.push(JSON.parse(match[2]))
  }
  return blocks
}

console.log('OpenAPI Specification & Contract Validation (Issue #174)')

const rawSpec = await fs.readFile(path.join(repoRoot, 'docs', 'openapi.yaml'), 'utf8')
const spec = yaml.load(rawSpec)
const { validateSchema, validateResponse } = createContractValidator(spec)

await test('OpenAPI specification passes structural and JSON Schema validation', () => {
  assert.equal(spec.openapi, '3.0.3')
  assert.ok(spec.info?.title, 'spec.info.title is required')
  assert.ok(spec.info?.version, 'spec.info.version is required')
  assert.ok(spec.paths && Object.keys(spec.paths).length > 0, 'spec.paths must be non-empty')
  assert.ok(
    spec.components?.schemas && Object.keys(spec.components.schemas).length > 0,
    'spec.components.schemas must be non-empty'
  )

  for (const [schemaName, schemaDef] of Object.entries(spec.components.schemas)) {
    const resolved = resolveOpenApiSchema(schemaDef, spec)
    assert.ok(resolved && typeof resolved === 'object', `Schema ${schemaName} must resolve`)
  }

  for (const [routePath, pathItem] of Object.entries(spec.paths)) {
    for (const [method, operation] of Object.entries(pathItem)) {
      if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue
      assert.ok(operation.operationId, `${method.toUpperCase()} ${routePath} needs operationId`)
      assert.ok(operation.responses, `${method.toUpperCase()} ${routePath} needs responses`)
      for (const [status, resp] of Object.entries(operation.responses)) {
        const media = resp.content?.['application/json']
        assert.ok(
          media?.schema,
          `${method.toUpperCase()} ${routePath} [${status}] needs application/json schema`
        )
        if (media.example) {
          validateResponse(routePath, method, status, media.example)
        }
      }
    }
  }
})

await test('Documented examples in docs/API_EXAMPLES.md satisfy OpenAPI schemas', async () => {
  const examplesMd = await fs.readFile(path.join(repoRoot, 'docs', 'API_EXAMPLES.md'), 'utf8')

  const [healthExample] = extractSectionJsonBlocks(examplesMd, '### `GET /healthz`')
  validateResponse('/healthz', 'get', 200, healthExample)

  const [ready200, ready503] = extractSectionJsonBlocks(examplesMd, '### `GET /readyz`')
  validateResponse('/readyz', 'get', 200, ready200)
  validateResponse('/readyz', 'get', 503, ready503)

  const [statusExample] = extractSectionJsonBlocks(examplesMd, '### `GET /api/status`')
  validateResponse('/api/status', 'get', 200, statusExample)

  const [agentsExample] = extractSectionJsonBlocks(examplesMd, '### `GET /api/agents`')
  validateResponse('/api/agents', 'get', 200, agentsExample)

  const [agent200, agent404] = extractSectionJsonBlocks(examplesMd, '### `GET /api/agents/:id`')
  validateResponse('/api/agents/{id}', 'get', 200, agent200)
  validateResponse('/api/agents/{id}', 'get', 404, agent404)

  const [premiumResearch200] = extractSectionJsonBlocks(
    examplesMd,
    '### `GET /api/premium/research`'
  )
  validateResponse('/api/premium/research', 'get', 200, premiumResearch200)

  const [premiumSummarize200] = extractSectionJsonBlocks(
    examplesMd,
    '### `GET /api/premium/summarize`'
  )
  validateResponse('/api/premium/summarize', 'get', 200, premiumSummarize200)

  const [premiumAnalyze200] = extractSectionJsonBlocks(examplesMd, '### `GET /api/premium/analyze`')
  validateResponse('/api/premium/analyze', 'get', 200, premiumAnalyze200)

  const [premiumCode200] = extractSectionJsonBlocks(examplesMd, '### `GET /api/premium/code`')
  validateResponse('/api/premium/code', 'get', 200, premiumCode200)

  const [orchestrate200] = extractSectionJsonBlocks(examplesMd, '### `POST /api/orchestrate`')
  validateResponse('/api/orchestrate', 'post', 200, orchestrate200)

  const [runs200] = extractSectionJsonBlocks(examplesMd, '### `GET /api/runs`')
  validateResponse('/api/runs', 'get', 200, runs200)
})

await test('Composed application status, health, readiness, and agent routes satisfy OpenAPI schemas', async () => {
  const { app, close } = createDeterministicFixtureApp()
  try {
    await withServer(app, async (baseUrl) => {
      const healthRes = await fetch(`${baseUrl}/healthz`)
      validateResponse('/healthz', 'get', healthRes.status, await healthRes.json())

      const readyRes = await fetch(`${baseUrl}/readyz`)
      assert.equal(readyRes.status, 200)
      validateResponse('/readyz', 'get', readyRes.status, await readyRes.json())

      const statusRes = await fetch(`${baseUrl}/api/status`)
      assert.equal(statusRes.status, 200)
      validateResponse('/api/status', 'get', statusRes.status, await statusRes.json())

      const agentsRes = await fetch(`${baseUrl}/api/agents`)
      assert.equal(agentsRes.status, 200)
      validateResponse('/api/agents', 'get', agentsRes.status, await agentsRes.json())

      const agentRes = await fetch(`${baseUrl}/api/agents/analyst-bot`)
      assert.equal(agentRes.status, 200)
      validateResponse('/api/agents/{id}', 'get', agentRes.status, await agentRes.json())

      const missingAgentRes = await fetch(`${baseUrl}/api/agents/unknown-agent`)
      assert.equal(missingAgentRes.status, 404)
      validateResponse(
        '/api/agents/{id}',
        'get',
        missingAgentRes.status,
        await missingAgentRes.json()
      )

      const discoverRes = await fetch(`${baseUrl}/api/agents/discover/code`)
      assert.equal(discoverRes.status, 200)
      validateResponse(
        '/api/agents/discover/{capability}',
        'get',
        discoverRes.status,
        await discoverRes.json()
      )
    })
  } finally {
    close()
  }

  // Unconfigured readiness (503)
  const unready = createDeterministicFixtureApp({
    config: { anthropicApiKey: '', serverAddress: 'GFIXTURE' },
    paymentMiddleware: null,
  })
  try {
    await withServer(unready.app, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/readyz`)
      assert.equal(res.status, 503)
      validateResponse('/readyz', 'get', res.status, await res.json())
    })
  } finally {
    unready.close()
  }
})

await test('Composed application validation error and premium route responses satisfy OpenAPI schemas', async () => {
  const { app, close } = createDeterministicFixtureApp()
  try {
    await withServer(app, async (baseUrl) => {
      const premiumCases = [
        {
          route: '/api/premium/research',
          validQuery: '?topic=Stellar+x402',
          invalidQuery: '?topic=',
        },
        {
          route: '/api/premium/summarize',
          validQuery: '?text=Autonomous+agents+on+Stellar',
          invalidQuery: '?text=',
        },
        {
          route: '/api/premium/analyze',
          validQuery: '?topic=Agent+economies',
          invalidQuery: '?topic=',
        },
        {
          route: '/api/premium/code',
          validQuery: '?prompt=Write+payment+helper',
          invalidQuery: '?prompt=',
        },
      ]

      for (const item of premiumCases) {
        // 402 without payment header
        const res402 = await fetch(`${baseUrl}${item.route}${item.validQuery}`)
        assert.equal(res402.status, 402)
        validateResponse(item.route, 'get', res402.status, await res402.json())

        // 400 with payment header but invalid query
        const res400 = await fetch(`${baseUrl}${item.route}${item.invalidQuery}`, {
          headers: { 'x-payment': 'valid-fixture-payment' },
        })
        assert.equal(res400.status, 400)
        validateResponse(item.route, 'get', res400.status, await res400.json())

        // 200 with payment header and valid query
        const res200 = await fetch(`${baseUrl}${item.route}${item.validQuery}`, {
          headers: { 'x-payment': 'valid-fixture-payment' },
        })
        assert.equal(res200.status, 200)
        validateResponse(item.route, 'get', res200.status, await res200.json())
      }

      // 400 on POST /api/orchestrate missing task
      const badOrchRes = await fetch(`${baseUrl}/api/orchestrate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ budget: -5 }),
      })
      assert.equal(badOrchRes.status, 400)
      validateResponse('/api/orchestrate', 'post', badOrchRes.status, await badOrchRes.json())
    })
  } finally {
    close()
  }
})

await test('Composed application orchestration, preview, queue, and run-history routes satisfy OpenAPI schemas', async () => {
  const { app, close } = createDeterministicFixtureApp()
  try {
    await withServer(app, async (baseUrl) => {
      // Preview 200
      const previewRes = await fetch(`${baseUrl}/api/orchestrate/preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task: 'Contract test preview', budget: 0.05 }),
      })
      assert.equal(previewRes.status, 200)
      const previewBody = await previewRes.json()
      validateResponse('/api/orchestrate/preview', 'post', previewRes.status, previewBody)

      // Execute 200
      const execRes = await fetch(`${baseUrl}/api/orchestrate/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ planId: previewBody.planId }),
      })
      assert.equal(execRes.status, 200)
      validateResponse('/api/orchestrate/execute', 'post', execRes.status, await execRes.json())

      // Sync orchestrate 200 with idempotency key
      const syncRes = await fetch(`${baseUrl}/api/orchestrate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'contract-idem-key-1',
        },
        body: JSON.stringify({ task: 'Deterministic contract task', budget: 0.05 }),
      })
      assert.equal(syncRes.status, 200)
      const syncBody = await syncRes.json()
      validateResponse('/api/orchestrate', 'post', syncRes.status, syncBody)

      // Idempotency conflict 409
      const conflictRes = await fetch(`${baseUrl}/api/orchestrate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'contract-idem-key-1',
        },
        body: JSON.stringify({ task: 'Different task with same key', budget: 0.05 }),
      })
      assert.equal(conflictRes.status, 409)
      validateResponse('/api/orchestrate', 'post', conflictRes.status, await conflictRes.json())

      // Async orchestrate 202
      const asyncRes = await fetch(`${baseUrl}/api/orchestrate?async=true`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task: 'Async contract task', budget: 0.02 }),
      })
      assert.equal(asyncRes.status, 202)
      validateResponse('/api/orchestrate', 'post', asyncRes.status, await asyncRes.json())

      // Queue state 200
      const queueRes = await fetch(`${baseUrl}/api/orchestrate/queue`)
      assert.equal(queueRes.status, 200)
      validateResponse('/api/orchestrate/queue', 'get', queueRes.status, await queueRes.json())

      // Runs list 200
      const runsRes = await fetch(`${baseUrl}/api/runs`)
      assert.equal(runsRes.status, 200)
      validateResponse('/api/runs', 'get', runsRes.status, await runsRes.json())

      // Run detail 200
      const runDetailRes = await fetch(`${baseUrl}/api/runs/${syncBody.runId}`)
      assert.equal(runDetailRes.status, 200)
      validateResponse('/api/runs/{id}', 'get', runDetailRes.status, await runDetailRes.json())

      // Run detail 404
      const missingRunRes = await fetch(`${baseUrl}/api/runs/run_missing_404`)
      assert.equal(missingRunRes.status, 404)
      validateResponse('/api/runs/{id}', 'get', missingRunRes.status, await missingRunRes.json())
    })
  } finally {
    close()
  }
})

await test('Altered response fields or status codes fail the contract check with actionable diagnostics', () => {
  // 1. Missing required field in /api/status
  const driftedStatus = {
    ...spec.paths['/api/status'].get.responses['200'].content['application/json'].example,
  }
  delete driftedStatus.x402

  assert.throws(
    () => validateResponse('/api/status', 'get', 200, driftedStatus),
    /Contract validation failed for GET \/api\/status \[200\]:.*must have required property 'x402'/,
    'Removing a required response field must fail contract check'
  )

  // 2. Wrong field type in /api/runs/{id}
  assert.throws(
    () =>
      validateSchema(
        spec.components.schemas.RunDetail,
        {
          id: 'run_1',
          runId: 'run_1',
          status: 'completed',
          task: 'test',
          budget: 'not-a-number',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          outputAvailable: true,
          results: [],
          txProofs: [],
          events: [],
        },
        'RunDetail'
      ),
    /Contract validation failed for RunDetail:.*\/budget must be number/,
    'Altering a field type must fail contract check'
  )

  // 3. Undocumented HTTP status code
  assert.throws(
    () => validateResponse('/api/agents', 'get', 201, []),
    /Undocumented status code 201 for GET \/api\/agents/,
    'Undocumented status code must fail contract check'
  )
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  process.exit(1)
}
