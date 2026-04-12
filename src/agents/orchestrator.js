import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import { AGENTS, getAgentById } from './registry.js';
import { runResearch, runSummary, runAnalysis, runCode } from './services.js';
import { sendPayment } from '../stellar/wallet.js';

// x402 client imports — the proper 402→sign→settle→200 flow
import { x402Client, x402HTTPClient, wrapFetchWithPayment } from '@x402/fetch';
import { ExactStellarScheme } from '@x402/stellar/exact/client';

const anthropic = new Anthropic({ apiKey: config.anthropicApiKey });

// Map agent IDs to their service functions (fallback when x402 unavailable)
const SERVICE_MAP = {
  'research-bot': runResearch,
  'summary-bot': runSummary,
  'analyst-bot': runAnalysis,
  'code-bot': runCode,
};

// Map agent IDs to premium x402-paywalled endpoint paths
const PREMIUM_ENDPOINT_MAP = {
  'research-bot': (input) => `/api/premium/research?topic=${encodeURIComponent(input)}`,
  'summary-bot': (input) => `/api/premium/summarize?text=${encodeURIComponent(input)}`,
  'analyst-bot': (input) => `/api/premium/analyze?topic=${encodeURIComponent(input)}`,
  'code-bot': (input) => `/api/premium/code?prompt=${encodeURIComponent(input)}`,
};

/**
 * Create x402-enabled fetch using orchestrator's Stellar wallet.
 * This wraps standard fetch to handle:
 *   1. Make request to paywalled endpoint
 *   2. Receive 402 Payment Required (with price, network, payTo)
 *   3. Auto-sign a Stellar transaction using orchestrator's secret key
 *   4. Retry request with X-PAYMENT header containing the signed tx
 *   5. Server verifies payment via facilitator, settles on-chain
 *   6. Receive 200 OK with agent response
 */
let x402Fetch = null;
if (config.orchestratorSecret) {
  try {
    // Create client-side Stellar payment scheme with orchestrator's key
    const stellarClientScheme = new ExactStellarScheme(config.orchestratorSecret);

    // Create x402 client with Stellar testnet scheme
    const client = x402Client.fromConfig({
      schemes: [{ network: config.network, client: stellarClientScheme }],
    });

    // Wrap fetch with x402 payment handling
    const httpClient = new x402HTTPClient(client);
    x402Fetch = wrapFetchWithPayment(fetch, httpClient);

    console.log('✅ x402 client fetch configured (orchestrator → paywalled endpoints)');
  } catch (err) {
    console.warn('⚠️  x402 client init failed:', err.message);
  }
}

/**
 * Call an agent via the x402-paywalled endpoint.
 * Flow: GET /api/premium/... → 402 Payment Required → auto-sign Stellar tx → retry → 200 OK
 * Falls back to direct service call + XLM payment if x402 is unavailable.
 */
async function callAgentViaX402(agent, input, broadcastFn) {
  const baseUrl = `http://localhost:${config.port}`;
  const endpointFn = PREMIUM_ENDPOINT_MAP[agent.id];

  // Try the x402 payment flow first (the hackathon requirement)
  if (x402Fetch && endpointFn) {
    try {
      const url = `${baseUrl}${endpointFn(input)}`;
      console.log(`  🔄 x402: GET ${agent.id} via paywalled endpoint`);

      const response = await x402Fetch(url);

      if (response.ok) {
        const data = await response.json();
        console.log(`  ✅ x402 settled! ${agent.name} paid via 402→sign→settle→200`);

        broadcastFn?.({
          type: 'x402_payment',
          agent: agent.name,
          agentId: agent.id,
          flow: '402 → sign → settle → 200',
          protocol: 'x402',
          amount: agent.price,
          currency: agent.currency,
          network: config.network,
          timestamp: new Date().toISOString(),
        });

        return {
          result: data.result || JSON.stringify(data),
          paymentMethod: 'x402',
          paymentSuccess: true,
          paidVia: 'x402',
        };
      } else {
        console.warn(`  ⚠️  x402 returned ${response.status}, falling back to XLM`);
      }
    } catch (err) {
      console.warn(`  ⚠️  x402 flow failed: ${err.message?.substring(0, 100)}, falling back to XLM`);
    }
  }

  // Fallback: direct service call + manual XLM payment on Stellar
  const serviceFn = SERVICE_MAP[agent.id];
  let result;
  try {
    result = await serviceFn(input);
  } catch (err) {
    result = `Error: ${err.message}`;
  }

  // Execute Stellar XLM payment as fallback (orchestrator → server)
  let paymentResult = { success: false, txHash: null };
  if (config.orchestratorSecret && config.serverAddress) {
    try {
      paymentResult = await sendPayment(
        config.orchestratorSecret,
        config.serverAddress,
        parseFloat(agent.price).toFixed(2),
        `pay:${agent.id}`
      );
    } catch (err) {
      console.error('  XLM fallback payment failed:', err.message);
    }
  }

  return {
    result,
    paymentMethod: paymentResult.success ? 'stellar-xlm' : 'none',
    paymentSuccess: paymentResult.success,
    paidVia: paymentResult.success ? 'stellar-xlm-direct' : 'none',
    txHash: paymentResult.txHash || null,
    explorerUrl: paymentResult.explorerUrl || null,
  };
}

/**
 * The Orchestrator — Claude-powered task decomposition and agent coordination.
 *
 * Payment flow (preferred): x402 protocol
 *   Orchestrator → GET /api/premium/research → 402 Payment Required
 *   → wrapFetchWithPayment auto-signs Stellar tx → retry with X-PAYMENT header
 *   → Facilitator verifies + settles on-chain → 200 OK + Claude response
 *
 * Payment flow (fallback): Stellar XLM direct
 *   Orchestrator → direct service call → sendPayment() XLM on Stellar
 */
export async function orchestrate(task, budget, broadcastFn) {
  const startTime = Date.now();
  const results = [];
  const payments = [];
  let totalSpent = 0;

  broadcastFn?.({
    type: 'orchestrator_start',
    task,
    budget,
    x402Enabled: !!x402Fetch,
    timestamp: new Date().toISOString(),
  });

  // Step 1: Claude plans the task decomposition
  const agentList = AGENTS.map(a => `- ${a.id}: ${a.capability} (cost: ${a.price} ${a.currency})`).join('\n');

  let plan;
  try {
    const planResponse = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 400,
      messages: [{
        role: 'user',
        content: `You are a task orchestrator for an AI agent marketplace. Break this task into 2-3 subtasks and choose which agents to use.

Available agents:
${agentList}

Task: "${task}"
Budget: ${budget} USDC

IMPORTANT: Only select agents whose total cost fits within the budget of ${budget} USDC.

Respond ONLY with valid JSON (no markdown, no code fences):
{
  "plan": "brief description of your approach",
  "subtasks": [
    {"agentId": "agent-id-here", "input": "what to send to the agent", "cost": "0.01"}
  ]
}`
      }],
    });

    const planText = planResponse.content[0].type === 'text' ? planResponse.content[0].text : '{}';
    const cleanJson = planText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    plan = JSON.parse(cleanJson);
  } catch (err) {
    console.error('Orchestrator planning (smart fallback):', err.message?.substring(0, 80));
    const subtasks = [];
    let remaining = budget;

    if (remaining >= 0.01) { subtasks.push({ agentId: 'research-bot', input: task, cost: '0.01' }); remaining -= 0.01; }
    if (remaining >= 0.01) { subtasks.push({ agentId: 'summary-bot', input: `Summarize findings about: ${task}`, cost: '0.01' }); remaining -= 0.01; }
    if (remaining >= 0.05) { subtasks.push({ agentId: 'analyst-bot', input: task, cost: '0.05' }); remaining -= 0.05; }
    if (remaining >= 0.03) { subtasks.push({ agentId: 'code-bot', input: `Write an implementation related to: ${task}`, cost: '0.03' }); remaining -= 0.03; }

    plan = {
      plan: `Multi-agent workflow: ${subtasks.map(s => s.agentId).join(' → ')} (${subtasks.length} agents, ${budget} USDC budget)`,
      subtasks,
    };
  }

  broadcastFn?.({
    type: 'orchestrator_plan',
    plan: plan.plan,
    subtaskCount: plan.subtasks?.length || 0,
    timestamp: new Date().toISOString(),
  });

  // Step 2: Execute each subtask via x402 paywalled endpoints
  for (const subtask of (plan.subtasks || [])) {
    const agent = getAgentById(subtask.agentId);
    if (!agent) {
      results.push({ agentId: subtask.agentId, error: 'Agent not found' });
      continue;
    }

    const cost = parseFloat(agent.price);

    // Budget enforcement — spending policy
    if (totalSpent + cost > budget) {
      broadcastFn?.({
        type: 'budget_limit',
        agent: agent.name,
        cost: agent.price,
        remaining: (budget - totalSpent).toFixed(4),
        timestamp: new Date().toISOString(),
      });
      results.push({
        agentId: agent.id,
        skipped: true,
        reason: `Budget limit (${(budget - totalSpent).toFixed(4)} USDC remaining, need ${agent.price})`,
      });
      continue;
    }

    broadcastFn?.({
      type: 'agent_call',
      agent: agent.name,
      agentId: agent.id,
      input: subtask.input?.substring(0, 100),
      cost: agent.price,
      paymentFlow: x402Fetch ? 'x402 (402→sign→settle→200)' : 'stellar-xlm',
      timestamp: new Date().toISOString(),
    });

    // Execute agent via x402 or XLM fallback
    const agentResponse = await callAgentViaX402(agent, subtask.input, broadcastFn);

    totalSpent += cost;

    const agentResult = {
      agentId: agent.id,
      agentName: agent.name,
      model: agent.model,
      input: subtask.input,
      output: agentResponse.result,
      cost: agent.price,
      currency: agent.currency,
      paidVia: agentResponse.paidVia,
      paymentSuccess: agentResponse.paymentSuccess,
      txHash: agentResponse.txHash || null,
      explorerUrl: agentResponse.explorerUrl || null,
    };

    results.push(agentResult);
    payments.push(agentResponse);

    broadcastFn?.({
      type: 'agent_response',
      agent: agent.name,
      agentId: agent.id,
      resultPreview: typeof agentResponse.result === 'string' ? agentResponse.result.substring(0, 150) : '',
      cost: agent.price,
      paidVia: agentResponse.paidVia,
      txHash: agentResponse.txHash || null,
      explorerUrl: agentResponse.explorerUrl || null,
      timestamp: new Date().toISOString(),
    });

    if (agentResponse.paymentSuccess) {
      broadcastFn?.({
        type: 'payment',
        from: 'Orchestrator',
        to: agent.name,
        amount: agent.price,
        currency: agent.currency,
        method: agentResponse.paidVia,
        txHash: agentResponse.txHash,
        explorerUrl: agentResponse.explorerUrl,
        timestamp: new Date().toISOString(),
      });
    }
  }

  const elapsed = Date.now() - startTime;
  const budgetExhausted = totalSpent >= budget;

  broadcastFn?.({
    type: 'orchestrator_complete',
    totalSpent: totalSpent.toFixed(4),
    agentsUsed: results.filter(r => !r.skipped).length,
    agentsSkipped: results.filter(r => r.skipped).length,
    elapsed: `${elapsed}ms`,
    budgetExhausted,
    paymentProtocol: x402Fetch ? 'x402' : 'stellar-xlm',
    timestamp: new Date().toISOString(),
  });

  return {
    task,
    plan: plan.plan,
    budget,
    totalSpent: totalSpent.toFixed(4),
    budgetExhausted,
    agentsUsed: results.filter(r => !r.skipped).length,
    agentsSkipped: results.filter(r => r.skipped).length,
    paymentProtocol: x402Fetch ? 'x402 (HTTP 402 → Stellar)' : 'Stellar XLM direct',
    results,
    payments: payments.filter(p => p.paymentSuccess),
    txCount: payments.filter(p => p.paymentSuccess).length,
    elapsed: `${elapsed}ms`,
  };
}
