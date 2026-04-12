import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import { AGENTS, getAgentById } from './registry.js';
import { runResearch, runSummary, runAnalysis, runCode, anthropic } from './services.js';
import { getBalance, sendPayment } from '../stellar/wallet.js';

import { x402Client, x402HTTPClient, wrapFetchWithPayment, decodePaymentResponseHeader } from '@x402/fetch';
import { ExactStellarScheme, createEd25519Signer } from '@x402/stellar';

// const anthropic = ... (imported from services.js)

const SERVICE_MAP = {
  'research-bot': runResearch,
  'summary-bot': runSummary,
  'analyst-bot': runAnalysis,
  'code-bot': runCode,
};

const PREMIUM_ENDPOINT_MAP = {
  'research-bot': (input) => `/api/premium/research?topic=${encodeURIComponent(input)}`,
  'summary-bot': (input) => `/api/premium/summarize?text=${encodeURIComponent(input)}`,
  'analyst-bot': (input) => `/api/premium/analyze?topic=${encodeURIComponent(input)}`,
  'code-bot': (input) => `/api/premium/code?prompt=${encodeURIComponent(input)}`,
};

const EXPLORER_NETWORK_SEGMENT = config.network.includes('testnet') ? 'testnet' : 'public';
const EXPLORER_BASE_URL = `https://stellar.expert/explorer/${EXPLORER_NETWORK_SEGMENT}/tx/`;

let x402Fetch = null;
let x402InitError = null;
let x402WalletReady = null;
let x402WalletHint = null;

if (config.orchestratorSecret) {
  try {
    const signer = createEd25519Signer(config.orchestratorSecret, config.network);
    const rpcConfig = config.stellarRpcUrl ? { url: config.stellarRpcUrl } : undefined;
    const stellarClientScheme = new ExactStellarScheme(signer, rpcConfig);

    const client = x402Client.fromConfig({
      schemes: [{ network: config.network, client: stellarClientScheme }],
    });

    const httpClient = new x402HTTPClient(client);
    x402Fetch = wrapFetchWithPayment(fetch, httpClient);

    console.log('  x402 client fetch configured (orchestrator -> paywalled endpoints)');
  } catch (err) {
    x402InitError = err?.message || 'unknown x402 client init error';
    console.warn(`  x402 client init failed: ${x402InitError}`);
  }
} else {
  x402InitError = 'ORCHESTRATOR_STELLAR_SECRET is not configured';
  console.warn(`  ${x402InitError}`);
}

async function checkX402WalletReadiness() {
  if (!config.orchestratorAddress) {
    x402WalletReady = false;
    x402WalletHint = 'ORCHESTRATOR_STELLAR_ADDRESS is not configured';
    console.warn(`  ${x402WalletHint}`);
    return;
  }

  try {
    const balances = await getBalance(config.orchestratorAddress);
    const usdcBalance = balances.find((balance) => balance.asset === 'USDC');
    const usdcAmount = Number.parseFloat(usdcBalance?.balance || '0');

    if (!usdcBalance) {
      x402WalletReady = false;
      x402WalletHint = 'No USDC trustline on orchestrator wallet. Run: npm run setup:usdc';
      console.warn(`  ${x402WalletHint}`);
      return;
    }

    if (!Number.isFinite(usdcAmount) || usdcAmount <= 0) {
      x402WalletReady = false;
      x402WalletHint = 'USDC balance is 0. Fund testnet USDC via https://faucet.circle.com';
      console.warn(`  ${x402WalletHint}`);
      return;
    }

    x402WalletReady = true;
    x402WalletHint = null;
    console.log(`  x402 wallet ready (USDC balance: ${usdcBalance.balance})`);
  } catch (err) {
    x402WalletReady = false;
    x402WalletHint = `Unable to verify x402 wallet readiness: ${summarizeError(err)}`;
    console.warn(`  ${x402WalletHint}`);
  }
}

if (x402Fetch) {
  checkX402WalletReadiness().catch((err) => {
    x402WalletReady = false;
    x402WalletHint = `Wallet readiness check failed: ${summarizeError(err)}`;
    console.warn(`  ${x402WalletHint}`);
  });
}

function summarizeError(err) {
  return (err?.message || 'unknown error').substring(0, 180);
}

function buildExplorerUrl(txHash) {
  return txHash ? `${EXPLORER_BASE_URL}${txHash}` : null;
}

function parseSettlementHeader(response) {
  const encoded = response.headers.get('PAYMENT-RESPONSE') || response.headers.get('X-PAYMENT-RESPONSE');
  if (!encoded) return null;

  try {
    return decodePaymentResponseHeader(encoded);
  } catch (err) {
    console.warn(`  unable to decode payment response header: ${summarizeError(err)}`);
    return null;
  }
}

async function parseResponseBody(response) {
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) return response.json();

  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { result: text };
  }
}

function paymentProtocolSummary(x402Count, xlmFallbackCount) {
  if (x402Count > 0 && xlmFallbackCount === 0) return 'x402';
  if (x402Count === 0 && xlmFallbackCount > 0) return 'stellar-xlm';
  if (x402Count > 0 && xlmFallbackCount > 0) return 'mixed';
  return 'none';
}

async function callAgentViaX402(agent, input, broadcastFn) {
  const baseUrl = `http://localhost:${config.port}`;
  const endpointFn = PREMIUM_ENDPOINT_MAP[agent.id];

  if (x402Fetch && endpointFn) {
    try {
      const url = `${baseUrl}${endpointFn(input)}`;
      console.log(`  x402 request -> ${url}`);

      const response = await x402Fetch(url);
      const data = await parseResponseBody(response);

      if (response.ok) {
        const settle = parseSettlementHeader(response);
        const txHash = settle?.transaction || null;
        const settlementConfirmed = !!(settle?.success && txHash);

        if (settlementConfirmed) {
          broadcastFn?.({
            type: 'x402_payment',
            agent: agent.name,
            agentId: agent.id,
            flow: '402 -> sign -> settle -> 200',
            protocol: 'x402',
            amount: agent.price,
            currency: agent.currency,
            txHash,
            explorerUrl: buildExplorerUrl(txHash),
            timestamp: new Date().toISOString(),
          });

          return {
            result: data.result || JSON.stringify(data),
            paymentMethod: 'x402',
            paymentSuccess: true,
            paidVia: 'x402',
            txHash,
            explorerUrl: buildExplorerUrl(txHash),
          };
        }

        const reason = settle?.errorReason || 'x402 settlement header missing or invalid';
        broadcastFn?.({
          type: 'x402_failure',
          agent: agent.name,
          agentId: agent.id,
          reason,
          fallback: false,
          timestamp: new Date().toISOString(),
        });

        return {
          result: data.result || JSON.stringify(data),
          paymentMethod: 'none',
          paymentSuccess: false,
          paidVia: 'none',
          txHash: null,
          explorerUrl: null,
          warning: reason,
        };
      }

      const responseExcerpt = typeof data === 'string'
        ? data.substring(0, 120)
        : JSON.stringify(data).substring(0, 120);
      const reason = `x402 endpoint returned ${response.status}: ${responseExcerpt}`;
      broadcastFn?.({
        type: 'x402_failure',
        agent: agent.name,
        agentId: agent.id,
        reason,
        fallback: true,
        timestamp: new Date().toISOString(),
      });
      console.warn(`  ${reason}`);
    } catch (err) {
      const reason = summarizeError(err);
      broadcastFn?.({
        type: 'x402_failure',
        agent: agent.name,
        agentId: agent.id,
        reason,
        fallback: true,
        timestamp: new Date().toISOString(),
      });
      console.warn(`  x402 flow failed: ${reason}, falling back to XLM`);
    }
  }

  const serviceFn = SERVICE_MAP[agent.id];
  let result;
  try {
    result = await serviceFn(input);
  } catch (err) {
    result = `Error: ${err.message}`;
  }

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

  const txHash = paymentResult.txHash || null;
  return {
    result,
    paymentMethod: paymentResult.success ? 'stellar-xlm' : 'none',
    paymentSuccess: paymentResult.success,
    paidVia: paymentResult.success ? 'stellar-xlm-direct' : 'none',
    txHash,
    explorerUrl: paymentResult.explorerUrl || buildExplorerUrl(txHash),
  };
}

export async function orchestrate(task, budget, broadcastFn) {
  const startTime = Date.now();
  const results = [];
  const payments = [];
  let totalSpent = 0;
  let x402PaymentCount = 0;
  let xlmFallbackCount = 0;
  let unpaidCount = 0;

  broadcastFn?.({
    type: 'orchestrator_start',
    task,
    budget,
    x402Configured: !!x402Fetch,
    x402InitError,
    x402WalletReady,
    x402WalletHint,
    paymentFlow: x402Fetch ? 'x402-http402' : 'stellar-xlm-fallback',
    timestamp: new Date().toISOString(),
  });

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

  for (const subtask of (plan.subtasks || [])) {
    const agent = getAgentById(subtask.agentId);
    if (!agent) {
      results.push({ agentId: subtask.agentId, error: 'Agent not found' });
      continue;
    }

    const cost = parseFloat(agent.price);

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
      paymentFlow: x402Fetch ? 'x402-http402' : 'stellar-xlm-fallback',
      timestamp: new Date().toISOString(),
    });

    const agentResponse = await callAgentViaX402(agent, subtask.input, broadcastFn);
    totalSpent += cost;

    if (agentResponse.paidVia === 'x402') x402PaymentCount += 1;
    else if (agentResponse.paidVia === 'stellar-xlm-direct') xlmFallbackCount += 1;
    else unpaidCount += 1;

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
  const paymentProtocol = paymentProtocolSummary(x402PaymentCount, xlmFallbackCount);
  const successfulPayments = payments.filter(p => p.paymentSuccess);
  const successfulTxs = successfulPayments.filter(p => p.txHash);

  broadcastFn?.({
    type: 'orchestrator_complete',
    totalSpent: totalSpent.toFixed(4),
    agentsUsed: results.filter(r => !r.skipped).length,
    agentsSkipped: results.filter(r => r.skipped).length,
    elapsed: `${elapsed}ms`,
    budgetExhausted,
    paymentProtocol,
    x402PaymentCount,
    xlmFallbackCount,
    unpaidCount,
    x402WalletReady,
    x402WalletHint,
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
    paymentProtocol,
    x402PaymentCount,
    xlmFallbackCount,
    unpaidCount,
    x402Configured: !!x402Fetch,
    x402WalletReady,
    x402WalletHint,
    results,
    payments: successfulPayments,
    txCount: successfulTxs.length,
    elapsed: `${elapsed}ms`,
  };
}
