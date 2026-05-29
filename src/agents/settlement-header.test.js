import assert from 'node:assert';
import { parseSettlementHeader, extractTxHash } from './settlement-header.js';

function makeResponse(headers) {
  return {
    headers: {
      get(name) {
        return headers[name] || headers[name.toLowerCase()] || null;
      },
    },
  };
}

let warnings = [];
const warn = (message) => warnings.push(message);

function resetWarnings() {
  warnings = [];
}

function assertDeepEqual(actual, expected, message) {
  assert.deepStrictEqual(actual, expected, message);
}

// Raw JSON header path
const rawJson = JSON.stringify({ success: true, transaction: 'raw-json-tx' });
const rawResult = parseSettlementHeader(makeResponse({ 'PAYMENT-RESPONSE': rawJson }), { warn });
assertDeepEqual(rawResult, { success: true, transaction: 'raw-json-tx' }, 'Raw JSON header must parse as JSON');
assert.strictEqual(extractTxHash(rawResult), 'raw-json-tx', 'Transaction hash should be extracted from raw JSON header');

// Decoded x402 header path using injected decoder
let decoderCalled = false;
const encodedPayload = 'encoded-x402-value';
const decodedResult = parseSettlementHeader(
  makeResponse({ 'X-PAYMENT-RESPONSE': encodedPayload }),
  {
    decoder(value) {
      decoderCalled = true;
      assert.strictEqual(value, encodedPayload, 'Decoder receives the header value');
      return { success: true, txHash: 'decoded-x402-tx' };
    },
    warn,
  }
);
assert.ok(decoderCalled, 'Decoder should be called for encoded x402 header values');
assertDeepEqual(decodedResult, { success: true, txHash: 'decoded-x402-tx' }, 'Decoded x402 header should return the decoded object');
assert.strictEqual(extractTxHash(decodedResult), 'decoded-x402-tx', 'Transaction hash should be extracted from decoded x402 header');

// Malformed header fallback and explicit unverified mode
resetWarnings();
const malformedResult = parseSettlementHeader(
  makeResponse({ 'payment-response': 'not-a-valid-header' }),
  {
    decoder() {
      throw new Error('invalid x402 payload');
    },
    warn,
  }
);
assert.strictEqual(malformedResult._unverified, true, 'Malformed fallback should return explicit _unverified flag');
assert.strictEqual(malformedResult.unverified, true, 'Malformed fallback should return explicit unverified mode');
assert.strictEqual(extractTxHash(malformedResult), null, 'Malformed fallback should not produce a transaction hash');
assert.ok(
  warnings.some((text) => text.includes('unable to decode payment response header')),
  'Malformed fallback should issue a warning message'
);

console.log('✅ settlement-header parser tests passed');
