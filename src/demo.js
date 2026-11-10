/**
 * StellarMind — Demo Script
 * Runs a full end-to-end demo: registers agents, submits tasks, shows payments
 * Run live:    npm run demo
 * Run offline: npm run demo:offline (or node src/demo.js --offline)
 */

import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { config } from './config.js'
import { AGENTS } from './agents/registry.js'
import {
  orchestrate,
  isOfflineDemoEnabled,
  listOfflineDemoFixtures,
  SYNTHETIC_RECEIPT_LABEL,
} from './agents/orchestrator.js'
import { getOfflineWalletBalances } from './providers/index.js'
import { getBalance } from './stellar/wallet.js'
import { explorerTxUrl } from './stellar/network.js'

export async function runOfflineDemo(options = {}) {
  const log = options.log || ((...args) => console.log(...args))
  const fixtures = options.fixtures || listOfflineDemoFixtures()
  const balances = getOfflineWalletBalances('offline-demo-cli')

  log(`
╔══════════════════════════════════════════════════╗
║       🧠 StellarMind — Offline Deterministic Demo ║
║       Stub Agent Outputs & Synthetic Receipts     ║
╚══════════════════════════════════════════════════╝
  `)

  log('🤖 Registered Agents (Offline Mode):')
  log('─'.repeat(60))
  for (const agent of AGENTS) {
    log(`  ${agent.name}`)
    log(`    Capability: ${agent.capability}`)
    log(`    Price: ${agent.price} ${agent.currency} | Model: ${agent.model} (offline stub)`)
    log()
  }

  log('💰 Deterministic Offline Wallet Balances (Synthetic):')
  log('─'.repeat(60))
  log(`  Orchestrator: ${JSON.stringify(balances.wallets.orchestrator)}`)
  log(`  Server:       ${JSON.stringify(balances.wallets.server)}`)
  log(`  Buyer:        ${JSON.stringify(balances.wallets.buyer)}`)
  log()

  const runs = []
  const syntheticReceipts = []

  for (let i = 0; i < fixtures.length; i++) {
    const fixture = fixtures[i]
    const events = []
    log(`\n${'═'.repeat(60)}`)
    log(`📋 Offline Demo Fixture ${i + 1}/${fixtures.length}: [${fixture.id}] ${fixture.name}`)
    log(`   Description: ${fixture.description}`)
    log(`   Task:        "${fixture.task}"`)
    log(`   Budget:      ${fixture.budget} USDC`)
    log('═'.repeat(60))

    const logEvent = (event) => {
      events.push(event)
      const prefix =
        {
          orchestrator_start: '🎯',
          orchestrator_plan: '📋',
          agent_call: '⚡',
          agent_response: '✅',
          payment: '💸',
          x402_payment: '🧾',
          x402_retry: '⚠️',
          x402_settlement_unresolved: '⏳',
          budget_limit: '🛑',
          orchestrator_complete: '🏁',
        }[event.type] || '📡'
      log(`  ${prefix} ${event.type}: ${JSON.stringify(event).substring(0, 120)}`)
    }

    const result = await orchestrate(fixture.task, fixture.budget, logEvent, {
      offlineMode: true,
      fixture: fixture.id,
    })

    log(`\n  📊 Offline Fixture Summary (${fixture.id}):`)
    log(`     Offline mode:       ${result.offlineMode} (${result.executionMode})`)
    log(`     Receipt mode:       ${result.receiptMode}`)
    log(`     Agents used:        ${result.agentsUsed}`)
    log(`     Agents skipped:     ${result.agentsSkipped}`)
    log(`     Quoted total:       ${result.totalSpent} USDC`)
    log(`     Settled summary:    ${result.settledSummary}`)
    log(`     Payment protocol:   ${result.paymentProtocol}`)
    log(`     x402 payments:      ${result.x402PaymentCount}`)
    log(`     XLM fallbacks:      ${result.xlmFallbackCount}`)
    log(`     Unpaid calls:       ${result.unpaidCount}`)
    log(`     Pending payments:   ${result.pendingPaymentCount}`)
    log(`     Budget exhausted:   ${result.budgetExhausted}`)

    for (const payment of result.payments) {
      if (payment.txHash) {
        syntheticReceipts.push({
          fixtureId: fixture.id,
          txHash: payment.txHash,
          paidVia: payment.paidVia,
          amount: payment.settledAmount,
          asset: payment.settledAsset,
          synthetic: payment.synthetic,
          offlineMode: payment.offlineMode,
          receiptMode: payment.receiptMode,
          receiptLabel: payment.receiptLabel || SYNTHETIC_RECEIPT_LABEL,
          explorerUrl: payment.explorerUrl,
        })
        log(
          `     🧾 [${payment.receiptLabel || SYNTHETIC_RECEIPT_LABEL}] ${payment.txHash} (explorerUrl: ${payment.explorerUrl})`
        )
      }
    }

    runs.push({
      fixtureId: fixture.id,
      result,
      events,
    })
  }

  log(`\n${'═'.repeat(60)}`)
  log(`🧾 Synthetic Offline Receipts (${SYNTHETIC_RECEIPT_LABEL}):`)
  log('─'.repeat(60))
  syntheticReceipts.forEach((receipt, index) => {
    log(
      `  ${index + 1}. [${receipt.fixtureId}] ${receipt.txHash} (${receipt.amount} ${receipt.asset} via ${receipt.paidVia}) — explorerUrl: ${receipt.explorerUrl}`
    )
  })
  log(
    `\n✅ Offline deterministic demo complete! ${syntheticReceipts.length} synthetic stub receipts generated; 0 live network or explorer requests.`
  )

  return {
    offlineMode: true,
    executionMode: 'offline-demo',
    receiptMode: 'synthetic-stub',
    receiptLabel: SYNTHETIC_RECEIPT_LABEL,
    balances,
    runs,
    syntheticReceipts,
  }
}

export async function main(options = {}) {
  const offlineMode =
    options.offlineMode !== undefined ? Boolean(options.offlineMode) : isOfflineDemoEnabled()

  if (offlineMode) {
    return runOfflineDemo(options)
  }

  console.log(`
╔══════════════════════════════════════════════════╗
║       🧠 StellarMind — Full Demo                  ║
║       AI Agent Marketplace with x402              ║
╚══════════════════════════════════════════════════╝
  `)

  // Step 1: Show registered agents
  console.log('🤖 Registered Agents:')
  console.log('─'.repeat(60))
  for (const agent of AGENTS) {
    console.log(`  ${agent.name}`)
    console.log(`    Capability: ${agent.capability}`)
    console.log(`    Price: ${agent.price} ${agent.currency} | Model: ${agent.model}`)
    console.log()
  }

  // Step 2: Show wallet balances
  if (config.orchestratorAddress) {
    console.log('💰 Wallet Balances:')
    console.log('─'.repeat(60))
    const oBal = await getBalance(config.orchestratorAddress)
    console.log(`  Orchestrator: ${JSON.stringify(oBal)}`)
    if (config.serverAddress) {
      const sBal = await getBalance(config.serverAddress)
      console.log(`  Server:       ${JSON.stringify(sBal)}`)
    }
    console.log()
  }

  // Step 3: Run orchestration tasks
  const demoTasks = [
    {
      task: 'Research the latest trends in AI-powered payments on blockchain networks',
      budget: 0.15,
    },
    { task: 'Analyze the competitive landscape of decentralized agent marketplaces', budget: 0.1 },
    { task: 'Research quantum computing impact on cryptography', budget: 0.02 }, // Budget test!
  ]

  const allTxHashes = []

  for (let i = 0; i < demoTasks.length; i++) {
    const { task, budget } = demoTasks[i]
    console.log(`\n${'═'.repeat(60)}`)
    console.log(`📋 Demo Task ${i + 1}/${demoTasks.length}`)
    console.log(`   Task:   "${task}"`)
    console.log(`   Budget: ${budget} USDC`)
    console.log('═'.repeat(60))

    const logEvent = (event) => {
      const prefix =
        {
          orchestrator_start: '🎯',
          orchestrator_plan: '📋',
          agent_call: '⚡',
          agent_response: '✅',
          payment: '💸',
          x402_payment: '🧾',
          x402_retry: '⚠️',
          budget_limit: '🛑',
          orchestrator_complete: '🏁',
        }[event.type] || '📡'
      console.log(`  ${prefix} ${event.type}: ${JSON.stringify(event).substring(0, 120)}`)
    }

    try {
      const result = await orchestrate(task, budget, logEvent)

      console.log(`\n  📊 Result Summary:`)
      console.log(`     Agents used: ${result.agentsUsed}`)
      console.log(`     Total spent: ${result.totalSpent} USDC`)
      console.log(`     Payment protocol: ${result.paymentProtocol}`)
      console.log(`     x402 payments: ${result.x402PaymentCount}`)
      console.log(`     XLM fallback payments: ${result.xlmFallbackCount}`)
      console.log(`     Unpaid calls: ${result.unpaidCount}`)
      console.log(`     TX count:    ${result.txCount}`)
      console.log(`     Budget exhausted: ${result.budgetExhausted}`)
      console.log(`     Time: ${result.elapsed}`)

      // Collect TX hashes
      for (const p of result.payments) {
        if (p.txHash && p.txHash !== 'simulated') {
          allTxHashes.push(p.txHash)
          console.log(`     🔗 TX: ${p.explorerUrl}`)
        }
      }
    } catch (err) {
      console.error(`  ❌ Task failed: ${err.message}`)
    }
  }

  // Step 4: Print all TX hashes
  console.log(`\n${'═'.repeat(60)}`)
  console.log(`📜 All Stellar ${config.networkProfile.label} Transaction Hashes:`)
  console.log('─'.repeat(60))
  if (allTxHashes.length > 0) {
    allTxHashes.forEach((hash, i) => {
      console.log(`  ${i + 1}. ${hash}`)
      console.log(`     ${explorerTxUrl(config.networkProfile, hash)}`)
    })
  } else {
    console.log('  No real transactions (wallets may not be configured in .env)')
  }

  console.log(`\n✅ Demo complete! ${allTxHashes.length} real Stellar transactions.`)
}

const isMainModule =
  process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])

if (isMainModule) {
  main().catch((err) => {
    console.error('Demo failed:', err)
    process.exit(1)
  })
}
