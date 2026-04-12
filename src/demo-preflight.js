import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';
import { getBalance } from './stellar/wallet.js';
import { AGENT_MODELS } from './agents/services.js';

const HORIZON_BASE_URL = config.network.includes('testnet')
  ? 'https://horizon-testnet.stellar.org'
  : 'https://horizon.stellar.org';

const SERVER_BASE_URL = `http://localhost:${config.port}`;

function ok(message) {
  console.log(`PASS  ${message}`);
}

function warn(message) {
  console.log(`WARN  ${message}`);
}

function fail(message) {
  console.log(`FAIL  ${message}`);
}

function getAssetBalance(balances, assetCode) {
  return balances.find((entry) => entry.asset === assetCode) || null;
}

async function verifyOnChainTransaction(txHash) {
  const response = await fetch(`${HORIZON_BASE_URL}/transactions/${txHash}`);
  if (!response.ok) {
    throw new Error(`Horizon returned ${response.status}`);
  }

  const data = await response.json();
  if (!data.successful) {
    throw new Error('Transaction is not marked successful on Horizon');
  }

  return data;
}

async function main() {
  const failures = [];

  console.log('\nStellarMind Preflight - Recording Readiness\n');
  console.log(`Network: ${config.network}`);
  console.log(`Server:  ${SERVER_BASE_URL}`);
  console.log('');

  if (!config.anthropicApiKey) failures.push('ANTHROPIC_API_KEY is missing in .env');
  if (!config.serverAddress) failures.push('SERVER_STELLAR_ADDRESS is missing in .env');
  if (!config.orchestratorAddress) failures.push('ORCHESTRATOR_STELLAR_ADDRESS is missing in .env');
  if (!config.orchestratorSecret) failures.push('ORCHESTRATOR_STELLAR_SECRET is missing in .env');

  if (failures.length > 0) {
    failures.forEach((message) => fail(message));
    process.exit(1);
  }
  ok('Required environment variables are configured');

  let statusPayload;
  try {
    const response = await fetch(`${SERVER_BASE_URL}/api/status`);
    if (!response.ok) throw new Error(`/api/status returned ${response.status}`);
    statusPayload = await response.json();
    ok('Local server is reachable');
  } catch (err) {
    fail(`Cannot reach local server at ${SERVER_BASE_URL}. Start it with: npm run dev`);
    fail(`Details: ${err.message}`);
    process.exit(1);
  }

  if (!statusPayload?.x402?.enabled) {
    failures.push('x402 middleware is not enabled according to /api/status');
    fail('x402 middleware is not enabled according to /api/status');
  } else {
    ok('x402 middleware reports enabled');
  }

  const orchestratorBalances = await getBalance(config.orchestratorAddress);
  const serverBalances = await getBalance(config.serverAddress);

  const orchestratorUSDC = getAssetBalance(orchestratorBalances, 'USDC');
  const serverUSDC = getAssetBalance(serverBalances, 'USDC');

  if (!serverUSDC) {
    failures.push('Server wallet has no USDC trustline');
    fail('Server wallet has no USDC trustline');
  } else {
    ok(`Server USDC trustline present (balance: ${serverUSDC.balance})`);
  }

  if (!orchestratorUSDC) {
    failures.push('Orchestrator wallet has no USDC trustline');
    fail('Orchestrator wallet has no USDC trustline');
  } else {
    ok(`Orchestrator USDC trustline present (balance: ${orchestratorUSDC.balance})`);
    const usdcAmount = Number.parseFloat(orchestratorUSDC.balance || '0');
    if (!Number.isFinite(usdcAmount) || usdcAmount <= 0) {
      failures.push('Orchestrator USDC balance is 0. Fund testnet USDC from https://faucet.circle.com');
      fail('Orchestrator USDC balance is 0. Fund testnet USDC from https://faucet.circle.com');
    } else {
      ok('Orchestrator has spendable USDC for real x402 settlement');
    }
  }

  try {
    const anthropic = new Anthropic({ apiKey: config.anthropicApiKey });
    const models = await anthropic.models.list({ limit: 200 });
    const ids = new Set(models.data.map((model) => model.id));

    if (ids.has(AGENT_MODELS.analysisPrimary)) {
      ok(`Analysis primary model available: ${AGENT_MODELS.analysisPrimary}`);
    } else {
      warn(`Analysis primary model not available: ${AGENT_MODELS.analysisPrimary}`);
      if (ids.has(AGENT_MODELS.analysisFallback)) {
        ok(`Analysis fallback model available: ${AGENT_MODELS.analysisFallback}`);
      } else {
        failures.push('Neither analysis primary nor fallback model is available for this Anthropic key');
        fail('Neither analysis primary nor fallback model is available for this Anthropic key');
      }
    }
  } catch (err) {
    failures.push(`Unable to validate Anthropic model access: ${err.message}`);
    fail(`Unable to validate Anthropic model access: ${err.message}`);
  }

  if (failures.length > 0) {
    console.log('\nPreflight stopped before payment test due to blocking failures.\n');
    process.exit(1);
  }

  console.log('\nRunning live x402 smoke task (cost target: 0.01 USDC)...');
  let orchestration;
  try {
    const response = await fetch(`${SERVER_BASE_URL}/api/orchestrate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        task: 'Summarize why x402 on Stellar matters in one concise paragraph.',
        budget: 0.01,
      }),
    });
    if (!response.ok) throw new Error(`/api/orchestrate returned ${response.status}`);
    orchestration = await response.json();
  } catch (err) {
    fail(`Live orchestration failed: ${err.message}`);
    process.exit(1);
  }

  const x402Count = Number(orchestration.x402PaymentCount || 0);
  if (x402Count < 1) {
    fail('Live task did not settle via x402 (x402PaymentCount is 0)');
    fail(`Payment protocol reported: ${orchestration.paymentProtocol || 'unknown'}`);
    if (orchestration.x402WalletHint) fail(`Hint: ${orchestration.x402WalletHint}`);
    process.exit(1);
  }
  ok(`Live task settled via x402 (${x402Count} x402 payment(s))`);

  const txHashes = (orchestration.payments || [])
    .map((payment) => payment.txHash)
    .filter(Boolean);

  if (txHashes.length === 0) {
    fail('No transaction hash returned from live x402 task');
    process.exit(1);
  }

  for (const txHash of txHashes) {
    try {
      const tx = await verifyOnChainTransaction(txHash);
      ok(`On-chain verified: ${txHash} (ledger ${tx.ledger})`);
    } catch (err) {
      fail(`On-chain verification failed for ${txHash}: ${err.message}`);
      process.exit(1);
    }
  }

  console.log('\nREADY  Demo is recording-ready for judges.\n');
}

main().catch((err) => {
  fail(`Unexpected preflight error: ${err.message}`);
  process.exit(1);
});
