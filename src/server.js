import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { config } from './config.js';
import { AGENTS, discoverAgents, getAgentById } from './agents/registry.js';
import { runResearch, runSummary, runAnalysis, runCode, setApiKey, MODEL_LABELS } from './agents/services.js';
import { orchestrate } from './agents/orchestrator.js';
import { getBalance, getTransactions, sendPayment } from './stellar/wallet.js';
import { requestId, errorHandler } from './middleware/errorHandler.js';

// x402 imports
import { paymentMiddlewareFromConfig } from '@x402/express';
import { HTTPFacilitatorClient } from '@x402/core/server';
import { ExactStellarScheme } from '@x402/stellar/exact/server';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use(requestId);

// ─── SSE Event Stream ────────────────────────────────────────
const sseClients = [];
let x402MiddlewareReady = false;

function broadcast(event) {
  const data = JSON.stringify(event);
  sseClients.forEach(res => {
    res.write(`data: ${data}\n\n`);
  });
}

function buildReadinessPayload() {
  const anthropicConfigured = !!config.anthropicApiKey;
  const x402Enabled = !!config.serverAddress;

  const components = {
    app: {
      ready: true,
      description: 'Core HTTP server initialized',
    },
    anthropic: {
      configured: anthropicConfigured,
      ready: anthropicConfigured,
      description: anthropicConfigured
        ? 'Anthropic API key is configured for Claude-powered agents'
        : 'Missing Anthropic API key; demo fallback responses are available',
    },
    x402: {
      enabled: x402Enabled,
      ready: !x402Enabled || (x402MiddlewareReady && !!config.facilitatorUrl),
      description: x402Enabled
        ? (x402MiddlewareReady
            ? 'x402 payment middleware initialized'
            : 'x402 is enabled but middleware initialization failed')
        : 'x402 paywall is disabled; premium endpoints are not protected by payments',
    },
  };

  const ready = Object.values(components).every(component => component.ready);
  return {
    status: ready ? 'ready' : 'not_ready',
    ready,
    timestamp: new Date().toISOString(),
    components,
  };
}

app.get('/healthz', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

app.get('/readyz', (req, res) => {
  const payload = buildReadinessPayload();
  res.status(payload.ready ? 200 : 503).json(payload);
});

app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  // Send initial connection event
  res.write(`data: ${JSON.stringify({ type: 'connected', timestamp: new Date().toISOString() })}\n\n`);

  sseClients.push(res);
  req.on('close', () => {
    const idx = sseClients.indexOf(res);
    if (idx !== -1) sseClients.splice(idx, 1);
  });
});

// ─── x402 Middleware (paywall for premium endpoints) ─────────
if (config.serverAddress) {
  try {
    const facilitatorClient = new HTTPFacilitatorClient({ url: config.facilitatorUrl });
    const stellarScheme = new ExactStellarScheme();

    app.use(
      paymentMiddlewareFromConfig(
        {
          'GET /api/premium/research': {
            accepts: {
              scheme: 'exact',
              price: '$0.01',
              network: config.network,
              payTo: config.serverAddress,
            },
          },
          'GET /api/premium/summarize': {
            accepts: {
              scheme: 'exact',
              price: '$0.01',
              network: config.network,
              payTo: config.serverAddress,
            },
          },
          'GET /api/premium/analyze': {
            accepts: {
              scheme: 'exact',
              price: '$0.05',
              network: config.network,
              payTo: config.serverAddress,
            },
          },
          'GET /api/premium/code': {
            accepts: {
              scheme: 'exact',
              price: '$0.03',
              network: config.network,
              payTo: config.serverAddress,
            },
          },
        },
        facilitatorClient,
        [{ network: config.network, server: stellarScheme }],
      )
    );
    x402MiddlewareReady = true;
    console.log('✅ x402 payment middleware active');
  } catch (err) {
    x402MiddlewareReady = false;
    console.warn('⚠️  x402 middleware init failed (non-fatal):', err.message);
  }
} else {
  x402MiddlewareReady = false;
  console.warn('⚠️  No SERVER_STELLAR_ADDRESS set — x402 paywall disabled');
}

// ─── Premium x402-Protected Endpoints ────────────────────────
app.get('/api/premium/research', async (req, res, next) => {
  try {
    const topic = req.query.topic || 'AI and blockchain payments';
    broadcast({ type: 'agent_call', agent: '🔬 Research Agent', agentId: 'research-bot', input: topic, cost: '0.01', timestamp: new Date().toISOString() });
    const result = await runResearch(topic);
    broadcast({ type: 'agent_response', agent: '🔬 Research Agent', agentId: 'research-bot', resultPreview: result.substring(0, 150), cost: '0.01', timestamp: new Date().toISOString() });
    res.json({ agent: 'research-bot', topic, result, model: MODEL_LABELS.research, cost: '0.01 USDC', paidVia: 'x402' });
  } catch (err) {
    next(err);
  }
});

app.get('/api/premium/summarize', async (req, res, next) => {
  try {
    const text = req.query.text || 'Please provide text to summarize via ?text= parameter';
    broadcast({ type: 'agent_call', agent: '📝 Summary Agent', agentId: 'summary-bot', input: text.substring(0, 100), cost: '0.01', timestamp: new Date().toISOString() });
    const result = await runSummary(text);
    broadcast({ type: 'agent_response', agent: '📝 Summary Agent', agentId: 'summary-bot', resultPreview: result.substring(0, 150), cost: '0.01', timestamp: new Date().toISOString() });
    res.json({ agent: 'summary-bot', result, model: MODEL_LABELS.summary, cost: '0.01 USDC', paidVia: 'x402' });
  } catch (err) {
    next(err);
  }
});

app.get('/api/premium/analyze', async (req, res, next) => {
  try {
    const topic = req.query.topic || 'AI agent economies';
    broadcast({ type: 'agent_call', agent: '📊 Analysis Agent', agentId: 'analyst-bot', input: topic, cost: '0.05', timestamp: new Date().toISOString() });
    const result = await runAnalysis(topic);
    broadcast({ type: 'agent_response', agent: '📊 Analysis Agent', agentId: 'analyst-bot', resultPreview: result.substring(0, 150), cost: '0.05', timestamp: new Date().toISOString() });
    res.json({ agent: 'analyst-bot', topic, result, model: MODEL_LABELS.analysis, cost: '0.05 USDC', paidVia: 'x402' });
  } catch (err) {
    next(err);
  }
});

app.get('/api/premium/code', async (req, res, next) => {
  try {
    const prompt = req.query.prompt || 'Write a hello world function';
    broadcast({ type: 'agent_call', agent: '💻 Code Agent', agentId: 'code-bot', input: prompt.substring(0, 100), cost: '0.03', timestamp: new Date().toISOString() });
    const result = await runCode(prompt);
    broadcast({ type: 'agent_response', agent: '💻 Code Agent', agentId: 'code-bot', resultPreview: result.substring(0, 150), cost: '0.03', timestamp: new Date().toISOString() });
    res.json({ agent: 'code-bot', prompt, result, model: MODEL_LABELS.code, cost: '0.03 USDC', paidVia: 'x402' });
  } catch (err) {
    next(err);
  }
});

// ─── Free Agent Endpoints (for internal orchestrator use) ────
app.get('/api/research', async (req, res, next) => {
  try {
    const topic = req.query.topic || 'AI payments';
    const result = await runResearch(topic);
    res.json({ agent: 'research-bot', topic, result, model: MODEL_LABELS.research, cost: '0.01 USDC' });
  } catch (err) {
    next(err);
  }
});

app.get('/api/summarize', async (req, res, next) => {
  try {
    const text = req.query.text || '';
    const result = await runSummary(text);
    res.json({ agent: 'summary-bot', result, model: MODEL_LABELS.summary, cost: '0.01 USDC' });
  } catch (err) {
    next(err);
  }
});

app.get('/api/analyze', async (req, res, next) => {
  try {
    const topic = req.query.topic || '';
    const result = await runAnalysis(topic);
    res.json({ agent: 'analyst-bot', topic, result, model: MODEL_LABELS.analysis, cost: '0.05 USDC' });
  } catch (err) {
    next(err);
  }
});

app.get('/api/code', async (req, res, next) => {
  try {
    const prompt = req.query.prompt || '';
    const result = await runCode(prompt);
    res.json({ agent: 'code-bot', result, model: MODEL_LABELS.code, cost: '0.03 USDC' });
  } catch (err) {
    next(err);
  }
});

// ─── Orchestrator Endpoint ───────────────────────────────────
app.post('/api/orchestrate', async (req, res, next) => {
  try {
    const { task, budget } = req.body;
    if (!task) {
      const err = new Error('Missing "task" in request body');
      err.status = 400;
      err.code = 'MISSING_FIELD';
      return next(err);
    }
    const budgetNum = parseFloat(budget) || 0.15;
    const result = await orchestrate(task, budgetNum, broadcast);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// Also support GET for easy testing
app.get('/api/orchestrate', async (req, res, next) => {
  try {
    const task = req.query.task || 'Research AI payments';
    const budget = parseFloat(req.query.budget) || 0.15;
    const result = await orchestrate(task, budget, broadcast);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ─── Agent Registry Endpoints ────────────────────────────────
app.get('/api/agents', (req, res) => {
  res.json(AGENTS);
});

app.get('/api/agents/discover/:capability', (req, res) => {
  const results = discoverAgents(req.params.capability);
  res.json(results);
});

app.get('/api/agents/:id', (req, res, next) => {
  const agent = getAgentById(req.params.id);
  if (!agent) {
    const err = new Error('Agent not found');
    err.status = 404;
    err.code = 'NOT_FOUND';
    return next(err);
  }
  res.json(agent);
});

// ─── Wallet Endpoints ────────────────────────────────────────
app.get('/api/wallet/balances', async (req, res, next) => {
  try {
    const wallets = {};
    if (config.serverAddress) {
      wallets.server = { address: config.serverAddress, balances: await getBalance(config.serverAddress) };
    }
    if (config.orchestratorAddress) {
      wallets.orchestrator = { address: config.orchestratorAddress, balances: await getBalance(config.orchestratorAddress) };
    }
    if (config.buyerAddress) {
      wallets.buyer = { address: config.buyerAddress, balances: await getBalance(config.buyerAddress) };
    }
    res.json(wallets);
  } catch (err) {
    next(err);
  }
});

app.get('/api/wallet/transactions', async (req, res, next) => {
  try {
    const address = req.query.address || config.orchestratorAddress || config.serverAddress;
    if (!address) return res.json([]);
    const txs = await getTransactions(address, 20);
    res.json(txs);
  } catch (err) {
    next(err);
  }
});

// ─── System Status ───────────────────────────────────────────
app.get('/api/status', (req, res) => {
  res.json({
    name: 'StellarMind',
    version: '1.0.0',
    description: 'AI Agent Marketplace with x402 Micropayments on Stellar',
    status: 'online',
    network: config.network,
    facilitator: config.facilitatorUrl,
    agents: AGENTS.length,
    x402: {
      enabled: !!config.serverAddress,
      middleware: '@x402/express (paymentMiddlewareFromConfig)',
      client: '@x402/fetch (wrapFetchWithPayment + ExactStellarScheme)',
      premiumEndpoints: [
        'GET /api/premium/research ($0.01)',
        'GET /api/premium/summarize ($0.01)',
        'GET /api/premium/analyze ($0.05)',
        'GET /api/premium/code ($0.03)',
      ],
      flow: '402 → wrapFetchWithPayment signs USDC tx → retry with X-PAYMENT → facilitator settles on-chain → 200',
    },
    wallets: {
      server: config.serverAddress ? `${config.serverAddress.slice(0, 8)}...` : 'not configured',
      orchestrator: config.orchestratorAddress ? `${config.orchestratorAddress.slice(0, 8)}...` : 'not configured',
      buyer: config.buyerAddress ? `${config.buyerAddress.slice(0, 8)}...` : 'not configured',
    },
    claudeEnabled: !!config.anthropicApiKey,
  });
});

// ─── API Key Configuration ───────────────────────────────────
app.get('/api/config/apikey', (req, res) => {
  const key = config.anthropicApiKey || '';
  res.json({
    configured: !!key,
    masked: key ? `sk-ant-...${key.slice(-6)}` : null,
  });
});

app.post('/api/config/apikey', (req, res, next) => {
  const { apiKey } = req.body;
  if (!apiKey || !apiKey.startsWith('sk-ant-')) {
    const err = new Error('Invalid API key. Must start with sk-ant-');
    err.status = 400;
    err.code = 'INVALID_API_KEY';
    return next(err);
  }
  // Security: Log only that a key was updated, never log the key itself
  console.log('  🔑 API key updated (ephemeral, session-only)');
  setApiKey(apiKey);
  res.json({ success: true, masked: `sk-ant-...${apiKey.slice(-6)}` });
});

// ─── Serve Dashboard ─────────────────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// ─── Centralized Error Handler ───────────────────────────────
app.use(errorHandler);

// ─── Start Server ────────────────────────────────────────────
const PORT = config.port;
app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════╗
║         🧠 StellarMind — AI Agent Marketplace     ║
║         x402 Micropayments on Stellar Testnet     ║
╠══════════════════════════════════════════════════╣
║  Dashboard:  http://localhost:${PORT}               ║
║  API:        http://localhost:${PORT}/api/status     ║
║  Agents:     http://localhost:${PORT}/api/agents     ║
║  Events:     http://localhost:${PORT}/api/events     ║
╠══════════════════════════════════════════════════╣
║  Network:    ${config.network.padEnd(34)}║
║  Claude AI:  ${(config.anthropicApiKey ? '✅ Connected' : '❌ No API key').padEnd(34)}║
║  x402:       ${(config.serverAddress ? '✅ Active' : '⚠️  No wallet').padEnd(34)}║
╚══════════════════════════════════════════════════╝
  `);
});
