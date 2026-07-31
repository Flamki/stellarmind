import assert from 'assert'
import {
  validatePremiumQuery,
  validateOrchestrate,
  validateWalletTransactions,
  validateConfigApiKey,
} from '../src/requestValidation.js'

function runMiddleware(middleware, req) {
  let nextError
  middleware(req, {}, (err) => {
    nextError = err
  })
  return nextError
}

function assertValidationError(err, field, messageFragment) {
  assert(err, 'Expected middleware to reject invalid input')
  assert.strictEqual(err.status, 400)
  assert.strictEqual(err.code, 'INVALID_INPUT')
  assert(Array.isArray(err.details), 'Error details should be provided')
  assert(
    err.details.some((detail) => detail.field === field),
    `Expected details to include field ${field}`
  )
  assert(err.message.includes(messageFragment), `Expected message to contain ${messageFragment}`)
}

console.log('\n📋 Testing API request validation')

// Orchestrate validation
let err = runMiddleware(validateOrchestrate, { method: 'POST', body: {} })
assertValidationError(err, 'task', 'Invalid orchestrate request')

err = runMiddleware(validateOrchestrate, {
  method: 'POST',
  body: { task: 'Build a demo', budget: -1 },
})
assertValidationError(err, 'budget', 'Invalid orchestrate request')

err = runMiddleware(validateOrchestrate, {
  method: 'POST',
  body: { task: 'Build a demo', budget: 'not-a-number' },
})
assertValidationError(err, 'budget', 'Invalid orchestrate request')

const validOrchestrate = { method: 'POST', body: { task: 'Deploy demo', budget: '0.5' } }
err = runMiddleware(validateOrchestrate, validOrchestrate)
assert.strictEqual(err, undefined)
assert.strictEqual(validOrchestrate.validated.task, 'Deploy demo')
assert.strictEqual(validOrchestrate.validated.budget, 0.5)

// Premium query validation
err = runMiddleware(validatePremiumQuery, { path: '/api/premium/research', query: { topic: '' } })
assertValidationError(err, 'topic', 'Invalid request query parameters')

err = runMiddleware(validatePremiumQuery, {
  path: '/api/premium/summarize',
  query: { text: 'x'.repeat(6000) },
})
assertValidationError(err, 'text', 'Invalid request query parameters')

err = runMiddleware(validatePremiumQuery, { path: '/api/premium/code', query: { prompt: 123 } })
assertValidationError(err, 'prompt', 'Invalid request query parameters')

const validPremium = { path: '/api/premium/code', query: { prompt: 'Write a test' } }
err = runMiddleware(validatePremiumQuery, validPremium)
assert.strictEqual(err, undefined)
assert.strictEqual(validPremium.validated.prompt, 'Write a test')

// Wallet transactions validation
err = runMiddleware(validateWalletTransactions, { query: { address: 123 } })
assertValidationError(err, 'address', 'Invalid wallet query parameters')

const validWallet = { query: { address: 'GABCD1234' } }
err = runMiddleware(validateWalletTransactions, validWallet)
assert.strictEqual(err, undefined)
assert.strictEqual(validWallet.validated.address, 'GABCD1234')

// Config API key validation
err = runMiddleware(validateConfigApiKey, { body: { apiKey: 'bad-key' } })
assert(err, 'Expected middleware to reject invalid API key')
assert.strictEqual(err.status, 400)
assert.strictEqual(err.code, 'INVALID_API_KEY')
assert(err.details.some((detail) => detail.field === 'apiKey'))

const validConfig = { body: { apiKey: 'sk-ant-123456789abcdef' } }
err = runMiddleware(validateConfigApiKey, validConfig)
assert.strictEqual(err, undefined)
assert.strictEqual(validConfig.validated.apiKey, 'sk-ant-123456789abcdef')

console.log('✅ API validation tests passed')
