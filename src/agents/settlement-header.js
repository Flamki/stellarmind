import { decodePaymentResponseHeader } from '@x402/fetch';

const SETTLEMENT_HEADER_CANDIDATES = [
  'PAYMENT-RESPONSE',
  'X-PAYMENT-RESPONSE',
  'payment-response',
  'x-payment-response',
  'X402-PAYMENT-RESPONSE',
  'x402-payment-response',
];

function summarizeError(err) {
  return (err?.message || 'unknown error').substring(0, 180);
}

function safeJsonParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function safeBase64JsonParse(value) {
  try {
    const decoded = Buffer.from(value, 'base64').toString('utf8');
    return safeJsonParse(decoded);
  } catch {
    return null;
  }
}

export function parseSettlementHeader(response, { decoder = decodePaymentResponseHeader, warn = console.warn } = {}) {
  if (!response?.headers?.get) return null;

  const candidates = SETTLEMENT_HEADER_CANDIDATES
    .map((name) => response.headers.get(name))
    .filter(Boolean);

  if (candidates.length === 0) return null;

  let lastError = null;
  for (const encoded of candidates) {
    const jsonDirect = safeJsonParse(encoded);
    if (jsonDirect) return jsonDirect;

    try {
      const decoded = decoder(encoded);
      if (decoded) return decoded;
    } catch (err) {
      lastError = err;
      const fallbackJson = safeBase64JsonParse(encoded);
      if (fallbackJson) return fallbackJson;
    }
  }

  warn(`  unable to decode payment response header, using unverified settlement mode: ${summarizeError(lastError)}`);
  return { unverified: true, _unverified: true };
}

export function extractTxHash(settle) {
  if (!settle || typeof settle !== 'object') return null;
  return settle.transaction
    || settle.txHash
    || settle.transactionHash
    || settle.tx_id
    || settle.txId
    || null;
}
