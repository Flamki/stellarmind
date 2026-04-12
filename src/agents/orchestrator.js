import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import { AGENTS, getAgentById } from './registry.js';
import { runResearch, runSummary, runAnalysis, runCode } from './services.js';
import { sendPayment } from '../stellar/wallet.js';

const anthropic = new Anthropic({ apiKey: config.anthropicApiKey });

// Map agent IDs to their service functions
const SERVICE_MAP = {
  'research-bot': runResearch,
  'summary-bot': runSummary,
  'analyst-bot': runAnalysis,
  'code-bot': runCode,
};

/**
 * The Orchestrator — Claude-powered task decomposition and agent coordination
 * This is the brain: it plans which agents to hire and manages the budget
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
    console.error('Orchestrator planning (using smart fallback):', err.message?.substring(0, 80));
    // Smart fallback: build a multi-agent plan based on budget
    const subtasks = [];
    let remaining = budget;

    // Always start with research
    if (remaining >= 0.01) {
      subtasks.push({ agentId: 'research-bot', input: task, cost: '0.01' });
      remaining -= 0.01;
    }
    // Add summary if budget allows
    if (remaining >= 0.01) {
      subtasks.push({ agentId: 'summary-bot', input: `Summarize findings about: ${task}`, cost: '0.01' });
      remaining -= 0.01;
    }
    // Add analysis for higher budgets
    if (remaining >= 0.05) {
      subtasks.push({ agentId: 'analyst-bot', input: task, cost: '0.05' });
      remaining -= 0.05;
    }
    // Add code agent if still room
    if (remaining >= 0.03) {
      subtasks.push({ agentId: 'code-bot', input: `Write an implementation related to: ${task}`, cost: '0.03' });
      remaining -= 0.03;
    }

    plan = {
      plan: `Multi-agent workflow: ${subtasks.map(s => s.agentId).join(' → ')} (${subtasks.length} agents within ${budget} USDC budget)`,
      subtasks,
    };
  }

  broadcastFn?.({
    type: 'orchestrator_plan',
    plan: plan.plan,
    subtaskCount: plan.subtasks?.length || 0,
    timestamp: new Date().toISOString(),
  });

  // Step 2: Execute each subtask, paying for each service call
  for (const subtask of (plan.subtasks || [])) {
    const agent = getAgentById(subtask.agentId);
    if (!agent) {
      results.push({ agentId: subtask.agentId, error: 'Agent not found' });
      continue;
    }

    const cost = parseFloat(agent.price);

    // Budget enforcement — the unique feature
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
        reason: `Budget limit reached (${(budget - totalSpent).toFixed(4)} USDC remaining, need ${agent.price} USDC)`,
      });
      continue;
    }

    // Broadcast agent activation
    broadcastFn?.({
      type: 'agent_call',
      agent: agent.name,
      agentId: agent.id,
      input: subtask.input?.substring(0, 100),
      cost: agent.price,
      timestamp: new Date().toISOString(),
    });

    // Execute the real Claude-powered service
    const serviceFn = SERVICE_MAP[agent.id];
    let result;
    try {
      result = await serviceFn(subtask.input);
    } catch (err) {
      result = `Error: ${err.message}`;
    }

    // Execute Stellar payment (orchestrator pays server)
    let paymentResult = { success: false, txHash: 'simulated' };
    if (config.orchestratorSecret && config.serverAddress) {
      try {
        paymentResult = await sendPayment(
          config.orchestratorSecret,
          config.serverAddress,
          cost.toFixed(2),
          `pay:${agent.id}`
        );
      } catch (err) {
        console.error('Payment failed, recording simulated:', err.message);
      }
    }

    totalSpent += cost;

    const agentResult = {
      agentId: agent.id,
      agentName: agent.name,
      model: agent.model,
      input: subtask.input,
      output: result,
      cost: agent.price,
      currency: agent.currency,
      payment: paymentResult,
    };

    results.push(agentResult);
    payments.push(paymentResult);

    // Broadcast agent response
    broadcastFn?.({
      type: 'agent_response',
      agent: agent.name,
      agentId: agent.id,
      resultPreview: typeof result === 'string' ? result.substring(0, 150) : '',
      cost: agent.price,
      txHash: paymentResult.txHash || null,
      explorerUrl: paymentResult.explorerUrl || null,
      timestamp: new Date().toISOString(),
    });

    // Broadcast payment event
    if (paymentResult.success) {
      broadcastFn?.({
        type: 'payment',
        from: 'Orchestrator',
        to: agent.name,
        amount: agent.price,
        currency: agent.currency,
        txHash: paymentResult.txHash,
        explorerUrl: paymentResult.explorerUrl,
        timestamp: new Date().toISOString(),
      });
    }
  }

  const elapsed = Date.now() - startTime;
  const budgetExhausted = totalSpent >= budget;

  // Broadcast completion
  broadcastFn?.({
    type: 'orchestrator_complete',
    totalSpent: totalSpent.toFixed(4),
    agentsUsed: results.filter(r => !r.skipped).length,
    agentsSkipped: results.filter(r => r.skipped).length,
    elapsed: `${elapsed}ms`,
    budgetExhausted,
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
    results,
    payments: payments.filter(p => p.success),
    txCount: payments.filter(p => p.success).length,
    elapsed: `${elapsed}ms`,
  };
}
