const DEFAULT_BUDGET = 0.15
const MAX_TOPIC_LENGTH = 500
const MAX_SUMMARY_TEXT_LENGTH = 5000
const MAX_CODE_PROMPT_LENGTH = 2000
const MAX_APIKEY_LENGTH = 128

function validationError(message, details = [], code = 'INVALID_INPUT', status = 400) {
  const err = new Error(message)
  err.status = status
  err.code = code
  err.details = details
  return err
}

function assertStringField(
  name,
  value,
  { required = false, minLength = 1, maxLength, defaultValue = undefined } = {}
) {
  if (value === undefined || value === null) {
    if (required) {
      return {
        valid: false,
        error: {
          field: name,
          reason: 'Missing required string field',
          received: value,
        },
      }
    }
    return {
      valid: true,
      value: defaultValue,
    }
  }

  if (typeof value !== 'string') {
    return {
      valid: false,
      error: {
        field: name,
        reason: 'Expected a string value',
        received: typeof value,
      },
    }
  }

  const trimmed = value.trim()
  if (trimmed.length < minLength) {
    return {
      valid: false,
      error: {
        field: name,
        reason: `Must be at least ${minLength} character${minLength === 1 ? '' : 's'}`,
        received: value,
      },
    }
  }

  if (maxLength !== undefined && trimmed.length > maxLength) {
    return {
      valid: false,
      error: {
        field: name,
        reason: `Must be no more than ${maxLength} characters`,
        received: value,
      },
    }
  }

  return {
    valid: true,
    value: trimmed,
  }
}

function assertBudget(value) {
  if (value === undefined || value === null || value === '') {
    return {
      valid: true,
      value: DEFAULT_BUDGET,
    }
  }

  const parsed = Number(value)
  if (!Number.isFinite(parsed) || Number.isNaN(parsed)) {
    return {
      valid: false,
      error: {
        field: 'budget',
        reason: 'Budget must be a finite numeric value',
        received: value,
      },
    }
  }

  if (parsed < 0) {
    return {
      valid: false,
      error: {
        field: 'budget',
        reason: 'Budget cannot be negative',
        received: value,
      },
    }
  }

  return {
    valid: true,
    value: parsed,
  }
}

function assertApiKey(value) {
  if (typeof value !== 'string') {
    return {
      valid: false,
      error: {
        field: 'apiKey',
        reason: 'API key must be a string',
        received: typeof value,
      },
    }
  }

  if (!value.startsWith('sk-ant-')) {
    return {
      valid: false,
      error: {
        field: 'apiKey',
        reason: 'API key must start with sk-ant-',
        received: value,
      },
    }
  }

  if (value.length > MAX_APIKEY_LENGTH) {
    return {
      valid: false,
      error: {
        field: 'apiKey',
        reason: `API key must be no more than ${MAX_APIKEY_LENGTH} characters`,
        received: value,
      },
    }
  }

  return { valid: true, value: value.trim() }
}

function validatePremiumQuery(req, _res, next) {
  const endpoint = req.path
  const details = []
  let payload = {}

  if (endpoint === '/api/premium/research' || endpoint === '/api/premium/analyze') {
    const topicResult = assertStringField('topic', req.query.topic, {
      required: false,
      minLength: 1,
      maxLength: MAX_TOPIC_LENGTH,
      defaultValue:
        endpoint === '/api/premium/research' ? 'AI and blockchain payments' : 'AI agent economies',
    })
    if (!topicResult.valid) details.push(topicResult.error)
    else payload.topic = topicResult.value
  }

  if (endpoint === '/api/premium/summarize') {
    const textResult = assertStringField('text', req.query.text, {
      required: false,
      minLength: 1,
      maxLength: MAX_SUMMARY_TEXT_LENGTH,
      defaultValue: 'Please provide text to summarize via ?text= parameter',
    })
    if (!textResult.valid) details.push(textResult.error)
    else payload.text = textResult.value
  }

  if (endpoint === '/api/premium/code') {
    const promptResult = assertStringField('prompt', req.query.prompt, {
      required: false,
      minLength: 1,
      maxLength: MAX_CODE_PROMPT_LENGTH,
      defaultValue: 'Write a hello world function',
    })
    if (!promptResult.valid) details.push(promptResult.error)
    else payload.prompt = promptResult.value
  }

  if (details.length > 0) {
    return next(validationError('Invalid request query parameters', details))
  }

  req.validated = { ...(req.validated || {}), ...payload }
  next()
}

function validateOrchestrate(req, _res, next) {
  const source = req.method === 'GET' ? req.query : req.body
  const taskResult = assertStringField('task', source.task, {
    required: true,
    minLength: 1,
    maxLength: MAX_TOPIC_LENGTH,
  })
  const budgetResult = assertBudget(source.budget)

  const details = []
  if (!taskResult.valid) details.push(taskResult.error)
  if (!budgetResult.valid) details.push(budgetResult.error)

  if (details.length > 0) {
    return next(validationError('Invalid orchestrate request', details))
  }

  req.validated = {
    ...req.validated,
    task: taskResult.value,
    budget: budgetResult.value,
  }
  next()
}

function validateWalletTransactions(req, _res, next) {
  if (req.query.address === undefined) {
    return next()
  }

  const result = assertStringField('address', req.query.address, {
    required: true,
    minLength: 1,
    maxLength: 64,
  })

  if (!result.valid) {
    return next(validationError('Invalid wallet query parameters', [result.error]))
  }

  req.validated = { ...(req.validated || {}), address: result.value }
  next()
}

function validateConfigApiKey(req, _res, next) {
  const result = assertApiKey(req.body.apiKey)
  if (!result.valid) {
    return next(validationError('Invalid API key payload', [result.error], 'INVALID_API_KEY'))
  }
  req.validated = { ...(req.validated || {}), apiKey: result.value }
  next()
}

export {
  validationError,
  assertStringField,
  assertBudget,
  assertApiKey,
  validatePremiumQuery,
  validateOrchestrate,
  validateWalletTransactions,
  validateConfigApiKey,
}
