/**
 * Pricing Configuration Validator
 * 
 * Validates pricing configuration at application startup to catch errors early.
 * Ensures:
 * - All prices are in valid format ($X.XX)
 * - All prices are positive numbers
 * - All required fields are present
 * - No duplicate endpoints
 * - Consistent agent references
 */

/**
 * Validate a single price string
 * @param {string} price - Price in format '$X.XX'
 * @returns {Object} { valid: boolean, error?: string, value?: number }
 */
export function validatePrice(price) {
  if (typeof price !== 'string') {
    return { valid: false, error: `Price must be a string, got ${typeof price}` };
  }

  // Check for negative sign
  if (price.includes('-')) {
    return { valid: false, error: `Price cannot be negative: '${price}'` };
  }

  const priceRegex = /^\$\d+\.\d{2}$/;
  if (!priceRegex.test(price)) {
    return {
      valid: false,
      error: `Price must be in format '$X.XX', got '${price}'`,
    };
  }

  const numValue = parseFloat(price.slice(1));
  if (isNaN(numValue)) {
    return { valid: false, error: `Price value is not a valid number: '${price}'` };
  }

  if (numValue === 0) {
    return { valid: false, error: `Price cannot be zero: '${price}'` };
  }

  return { valid: true, value: numValue };
}

/**
 * Validate endpoint format
 * @param {string} endpoint - Endpoint path, e.g., 'GET /api/premium/research'
 * @returns {Object} { valid: boolean, error?: string }
 */
export function validateEndpoint(endpoint) {
  if (typeof endpoint !== 'string') {
    return { valid: false, error: `Endpoint must be a string, got ${typeof endpoint}` };
  }

  const endpointRegex = /^(GET|POST|PUT|DELETE|PATCH)\s+\/api\/premium\/\w+$/;
  if (!endpointRegex.test(endpoint)) {
    return {
      valid: false,
      error: `Endpoint must match pattern 'METHOD /api/premium/name', got '${endpoint}'`,
    };
  }

  return { valid: true };
}

/**
 * Validate endpoint info object
 * @param {string} endpoint - Endpoint path
 * @param {Object} info - Endpoint info object
 * @returns {Object} { valid: boolean, errors: string[] }
 */
export function validateEndpointInfo(endpoint, info) {
  const errors = [];

  if (!info || typeof info !== 'object') {
    return { valid: false, errors: [`Endpoint info must be an object, got ${typeof info}`] };
  }

  // Validate price
  if (!info.price) {
    errors.push(`Missing 'price' for endpoint '${endpoint}'`);
  } else {
    const priceValidation = validatePrice(info.price);
    if (!priceValidation.valid) {
      errors.push(`Invalid price for '${endpoint}': ${priceValidation.error}`);
    }
  }

  // Validate agent
  if (!info.agent) {
    errors.push(`Missing 'agent' for endpoint '${endpoint}'`);
  } else if (typeof info.agent !== 'string') {
    errors.push(`Agent must be a string for '${endpoint}', got ${typeof info.agent}`);
  } else if (!info.agent.match(/^[\w-]+$/)) {
    errors.push(`Agent name must be alphanumeric with hyphens for '${endpoint}', got '${info.agent}'`);
  }

  // Validate description
  if (!info.description) {
    errors.push(`Missing 'description' for endpoint '${endpoint}'`);
  } else if (typeof info.description !== 'string') {
    errors.push(`Description must be a string for '${endpoint}', got ${typeof info.description}`);
  }

  // Validate emoji (optional but if present, should be valid)
  if (info.emoji && typeof info.emoji !== 'string') {
    errors.push(`Emoji must be a string for '${endpoint}', got ${typeof info.emoji}`);
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validate entire pricing configuration
 * @param {Object} pricingConfig - Pricing configuration object
 * @returns {Object} { valid: boolean, errors: string[] }
 */
export function validatePricingConfig(pricingConfig) {
  const errors = [];

  if (!pricingConfig || typeof pricingConfig !== 'object') {
    return { valid: false, errors: ['Pricing config must be an object'] };
  }

  if (!pricingConfig.endpoints || typeof pricingConfig.endpoints !== 'object') {
    return { valid: false, errors: ['Pricing config must have an "endpoints" object'] };
  }

  const endpoints = Object.keys(pricingConfig.endpoints);

  if (endpoints.length === 0) {
    errors.push('Pricing config must have at least one endpoint');
  }

  // Track seen agents and prices for consistency checks
  const seenAgents = new Set();
  const seenEndpoints = new Set();

  for (const [endpoint, info] of Object.entries(pricingConfig.endpoints)) {
    // Validate endpoint format
    const endpointValidation = validateEndpoint(endpoint);
    if (!endpointValidation.valid) {
      errors.push(`Invalid endpoint format: ${endpointValidation.error}`);
    }

    // Check for duplicates
    if (seenEndpoints.has(endpoint)) {
      errors.push(`Duplicate endpoint: '${endpoint}'`);
    }
    seenEndpoints.add(endpoint);

    // Validate endpoint info
    const infoValidation = validateEndpointInfo(endpoint, info);
    if (!infoValidation.valid) {
      errors.push(...infoValidation.errors);
    }

    // Check for duplicate agents
    if (info.agent && seenAgents.has(info.agent)) {
      errors.push(`Duplicate agent: '${info.agent}' used in multiple endpoints`);
    }
    if (info.agent) {
      seenAgents.add(info.agent);
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validate x402 configuration compatibility
 * @param {Object} pricingConfig - Pricing configuration
 * @param {Object} config - Application config with network and payTo
 * @returns {Object} { valid: boolean, errors: string[] }
 */
export function validateX402Compatibility(pricingConfig, config) {
  const errors = [];

  if (!config.network) {
    errors.push('Config must have "network" property for x402 compatibility');
  }

  if (!config.payTo) {
    errors.push('Config must have "payTo" property (server address) for x402 compatibility');
  }

  if (config.payTo && typeof config.payTo !== 'string') {
    errors.push(`Config "payTo" must be a string, got ${typeof config.payTo}`);
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Comprehensive validation with detailed error reporting
 * @param {Object} pricingConfig - Pricing configuration
 * @param {Object} config - Application config
 * @returns {Object} { valid: boolean, errors: string[], warnings: string[] }
 */
export function validateAll(pricingConfig, config) {
  const errors = [];
  const warnings = [];

  // Validate pricing config structure
  const pricingValidation = validatePricingConfig(pricingConfig);
  if (!pricingValidation.valid) {
    errors.push(...pricingValidation.errors);
  }

  // Validate x402 compatibility
  if (config && config.network) {
    const x402Validation = validateX402Compatibility(pricingConfig, config);
    if (!x402Validation.valid) {
      errors.push(...x402Validation.errors);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Format validation errors for console output
 * @param {Object} validation - Validation result from validateAll()
 * @returns {string} Formatted error message
 */
export function formatValidationErrors(validation) {
  if (validation.valid) {
    return '✅ Pricing configuration is valid';
  }

  let message = '❌ Pricing configuration validation failed:\n';

  if (validation.errors.length > 0) {
    message += '\nErrors:\n';
    validation.errors.forEach((err, i) => {
      message += `  ${i + 1}. ${err}\n`;
    });
  }

  if (validation.warnings.length > 0) {
    message += '\nWarnings:\n';
    validation.warnings.forEach((warn, i) => {
      message += `  ${i + 1}. ${warn}\n`;
    });
  }

  return message;
}

/**
 * Throw error if validation fails
 * @param {Object} validation - Validation result
 * @param {string} context - Context for error message
 * @throws {Error} If validation failed
 */
export function throwIfInvalid(validation, context = 'Pricing configuration') {
  if (!validation.valid) {
    const message = formatValidationErrors(validation);
    throw new Error(`${context} validation failed:\n${message}`);
  }
}
