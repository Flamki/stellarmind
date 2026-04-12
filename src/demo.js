/**
 * StellarMind — Demo Script
 * Runs a full end-to-end demo: registers agents, submits tasks, shows payments
 * Run: npm run demo
 */

import { config } from './config.js';
import { AGENTS } from './agents/registry.js';
import { orchestrate } from './agents/orchestrator.js';
import { getBalance, getTransactions } from './stellar/wallet.js';

async function main() {
  console.log(`
╔══════════════════════════════════════════════════╗
║       🧠 StellarMind — Full Demo                  ║
║       AI Agent Marketplace with x402              ║
╚══════════════════════════════════════════════════╝
  `);

  // Step 1: Show registered agents
  console.log('🤖 Registered Agents:');
  console.log('─'.repeat(60));
  for (const agent of AGENTS) {
    console.log(`  ${agent.name}`);
    console.log(`    Capability: ${agent.capability}`);
    console.log(`    Price: ${agent.price} ${agent.currency} | Model: ${agent.model}`);
    console.log();
  }

  // Step 2: Show wallet balances
  if (config.orchestratorAddress) {
    console.log('💰 Wallet Balances:');
    console.log('─'.repeat(60));
    const oBal = await getBalance(config.orchestratorAddress);
    console.log(`  Orchestrator: ${JSON.stringify(oBal)}`);
    if (config.serverAddress) {
      const sBal = await getBalance(config.serverAddress);
      console.log(`  Server:       ${JSON.stringify(sBal)}`);
    }
    console.log();
  }

  // Step 3: Run orchestration tasks
  const demoTasks = [
    { task: 'Research the latest trends in AI-powered payments on blockchain networks', budget: 0.15 },
    { task: 'Analyze the competitive landscape of decentralized agent marketplaces', budget: 0.10 },
    { task: 'Research quantum computing impact on cryptography', budget: 0.02 }, // Budget test!
  ];

  const allTxHashes = [];

  for (let i = 0; i < demoTasks.length; i++) {
    const { task, budget } = demoTasks[i];
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`📋 Demo Task ${i + 1}/${demoTasks.length}`);
    console.log(`   Task:   "${task}"`);
    console.log(`   Budget: ${budget} USDC`);
    console.log('═'.repeat(60));

    const logEvent = (event) => {
      const prefix = {
        'orchestrator_start': '🎯',
        'orchestrator_plan': '📋',
        'agent_call': '⚡',
        'agent_response': '✅',
        'payment': '💸',
        'x402_payment': '🧾',
        'x402_failure': '⚠️',
        'budget_limit': '🛑',
        'orchestrator_complete': '🏁',
      }[event.type] || '📡';
      console.log(`  ${prefix} ${event.type}: ${JSON.stringify(event).substring(0, 120)}`);
    };

    try {
      const result = await orchestrate(task, budget, logEvent);

      console.log(`\n  📊 Result Summary:`);
      console.log(`     Agents used: ${result.agentsUsed}`);
      console.log(`     Total spent: ${result.totalSpent} USDC`);
      console.log(`     Payment protocol: ${result.paymentProtocol}`);
      console.log(`     x402 payments: ${result.x402PaymentCount}`);
      console.log(`     XLM fallback payments: ${result.xlmFallbackCount}`);
      console.log(`     Unpaid calls: ${result.unpaidCount}`);
      console.log(`     TX count:    ${result.txCount}`);
      console.log(`     Budget exhausted: ${result.budgetExhausted}`);
      console.log(`     Time: ${result.elapsed}`);

      // Collect TX hashes
      for (const p of result.payments) {
        if (p.txHash && p.txHash !== 'simulated') {
          allTxHashes.push(p.txHash);
          console.log(`     🔗 TX: ${p.explorerUrl}`);
        }
      }
    } catch (err) {
      console.error(`  ❌ Task failed: ${err.message}`);
    }
  }

  // Step 4: Print all TX hashes
  console.log(`\n${'═'.repeat(60)}`);
  console.log('📜 All Stellar Testnet Transaction Hashes:');
  console.log('─'.repeat(60));
  if (allTxHashes.length > 0) {
    allTxHashes.forEach((hash, i) => {
      console.log(`  ${i + 1}. ${hash}`);
      console.log(`     https://stellar.expert/explorer/testnet/tx/${hash}`);
    });
  } else {
    console.log('  No real transactions (wallets may not be configured in .env)');
  }

  console.log(`\n✅ Demo complete! ${allTxHashes.length} real Stellar transactions.`);
}

main().catch(err => {
  console.error('Demo failed:', err);
  process.exit(1);
});
