import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';

dotenv.config({
  path: fileURLToPath(new URL('../.env', import.meta.url)),
  quiet: true,
});

export const config = {
  port: process.env.PORT || 3001,
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
};
