/**
 * Setup USDC trustlines for x402 payments.
 * x402 requires USDC (not XLM) — this script:
 * 1. Adds USDC trustline to orchestrator + server wallets
 * 2. Tests the trustline setup
 */
import {
  Keypair,
  Horizon,
  TransactionBuilder,
  Networks,
  Operation,
  Asset,
} from '@stellar/stellar-sdk';
import { config } from './config.js';

const horizon = new Horizon.Server('https://horizon-testnet.stellar.org');

// Circle USDC issuer on Stellar testnet
const USDC_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const USDC = new Asset('USDC', USDC_ISSUER);

async function addTrustline(secretKey, label) {
  try {
    const keypair = Keypair.fromSecret(secretKey);
    const account = await horizon.loadAccount(keypair.publicKey());

    // Check if trustline already exists
    const hasUSDC = account.balances.some(
      b => b.asset_code === 'USDC' && b.asset_issuer === USDC_ISSUER
    );

    if (hasUSDC) {
      console.log(`  ✅ ${label} already has USDC trustline`);
      return true;
    }

    const tx = new TransactionBuilder(account, {
      fee: '100',
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(
        Operation.changeTrust({
          asset: USDC,
          limit: '10000',
        })
      )
      .setTimeout(30)
      .build();

    tx.sign(keypair);
    await horizon.submitTransaction(tx);
    console.log(`  ✅ ${label} USDC trustline added successfully`);
    return true;
  } catch (err) {
    console.error(`  ❌ ${label} trustline failed:`, err.message?.substring(0, 100));
    return false;
  }
}

async function main() {
  console.log('\n🔧 Setting up USDC trustlines for x402 payments\n');
  console.log(`  USDC Issuer: ${USDC_ISSUER}`);
  console.log(`  Network: ${config.network}\n`);

  // Add trustlines to server and orchestrator wallets
  if (config.serverSecret) {
    await addTrustline(config.serverSecret, 'Server wallet');
  }
  if (config.orchestratorSecret) {
    await addTrustline(config.orchestratorSecret, 'Orchestrator wallet');
  }
  if (config.buyerSecret) {
    await addTrustline(config.buyerSecret, 'Buyer wallet');
  }

  // Verify balances
  console.log('\n📊 Wallet balances after trustline setup:\n');
  for (const [label, addr] of [
    ['Server', config.serverAddress],
    ['Orchestrator', config.orchestratorAddress],
    ['Buyer', config.buyerAddress],
  ]) {
    if (!addr) continue;
    try {
      const account = await horizon.loadAccount(addr);
      const balances = account.balances.map(b => {
        if (b.asset_type === 'native') return `${b.balance} XLM`;
        return `${b.balance} ${b.asset_code}`;
      });
      console.log(`  ${label}: ${balances.join(', ')}`);
    } catch (err) {
      console.log(`  ${label}: error loading — ${err.message?.substring(0, 50)}`);
    }
  }

  console.log('\n💡 To get testnet USDC:');
  console.log('   1. Go to https://faucet.circle.com');
  console.log('   2. Select "Stellar Testnet"');
  console.log('   3. Paste your orchestrator address:');
  console.log(`      ${config.orchestratorAddress}`);
  console.log('   4. Request USDC — you\'ll receive 10 testnet USDC\n');
}

main().catch(console.error);
