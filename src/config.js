import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

dotenv.config({
  path: fileURLToPath(new URL('../.env', import.meta.url)),
  quiet: true,
});

const port = process.env.PORT || 3001;
const internalBaseUrl = (process.env.INTERNAL_BASE_URL || `http://localhost:${port}`).replace(/\/+$/, '');
const toNumberOr = (value, fallback) => {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
};
const repoRoot = fileURLToPath(new URL('..', import.meta.url));

export const config = {
  port,
  internalBaseUrl,
  network: process.env.NETWORK || 'stellar:testnet',
  facilitatorUrl: process.env.FACILITATOR_URL || 'https://www.x402.org/facilitator',
  stellarRpcUrl: process.env.STELLAR_RPC_URL || 'https://soroban-testnet.stellar.org',

  // Server wallet (receives payments)
  serverAddress: process.env.SERVER_STELLAR_ADDRESS || '',
  serverSecret: process.env.SERVER_STELLAR_SECRET || '',

  // Orchestrator wallet (pays for sub-agent calls)
  orchestratorAddress: process.env.ORCHESTRATOR_STELLAR_ADDRESS || '',
  orchestratorSecret: process.env.ORCHESTRATOR_STELLAR_SECRET || '',

  // Buyer wallet (demo user wallet)
  buyerAddress: process.env.BUYER_STELLAR_ADDRESS || '',
  buyerSecret: process.env.BUYER_STELLAR_SECRET || '',

  // Anthropic
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
  anthropicRequestTimeoutMs: Math.max(1000, toNumberOr(process.env.ANTHROPIC_REQUEST_TIMEOUT_MS, 20000)),
  anthropicMaxRetries: Math.max(0, toNumberOr(process.env.ANTHROPIC_MAX_RETRIES, 2)),
  anthropicRetryBaseDelayMs: Math.max(100, toNumberOr(process.env.ANTHROPIC_RETRY_BASE_DELAY_MS, 500)),

  // Run history persistence
  runHistoryStorage: process.env.RUN_HISTORY_STORAGE || 'file',
  runHistoryFile: process.env.RUN_HISTORY_FILE
    ? path.resolve(process.env.RUN_HISTORY_FILE)
    : path.join(repoRoot, 'data', 'run-history.json'),
  runHistoryMaxRuns: Math.max(10, toNumberOr(process.env.RUN_HISTORY_MAX_RUNS, 200)),
};
