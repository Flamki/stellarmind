import { spawn } from 'node:child_process';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');
const baseUrl = 'http://localhost:3001';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runNodeScript(scriptPath, label) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [scriptPath], {
      cwd: repoRoot,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });

    child.stdout.on('data', (chunk) => process.stdout.write(chunk));
    child.stderr.on('data', (chunk) => process.stderr.write(chunk));

    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${label} failed with exit code ${code}`));
    });
  });
}

async function waitForServer(timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${baseUrl}/api/status`);
      if (res.ok) return;
    } catch {}
    await sleep(500);
  }
  throw new Error('Server did not become ready in time');
}

async function typeHuman(locator, text) {
  await locator.click({ clickCount: 3 });
  await locator.press('Backspace');
  for (const ch of text) {
    const delay = 70 + Math.floor(Math.random() * 130);
    await locator.type(ch, { delay });
    if (Math.random() < 0.1) {
      await sleep(140 + Math.floor(Math.random() * 260));
    }
  }
}

async function clickSidebar(page, pageId, settleMs = 1700) {
  const item = page.locator(`.sb-item[data-page="${pageId}"]`);
  await item.waitFor({ timeout: 20000 });
  await item.click();
  await sleep(settleMs);
}

async function smoothScroll(page, pixels) {
  await page.evaluate(async (targetPixels) => {
    const step = targetPixels > 0 ? 24 : -24;
    const steps = Math.floor(Math.abs(targetPixels) / Math.abs(step));
    for (let i = 0; i < steps; i += 1) {
      window.scrollBy(0, step);
      // Keep this in page context to create natural motion.
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, 16));
    }
  }, pixels);
}

async function hoverFocus(page, selector, holdMs = 900) {
  const target = page.locator(selector).first();
  if ((await target.count()) === 0) return;
  await target.hover();
  await sleep(holdMs);
}

async function setBudget(page, amount) {
  await page.evaluate((v) => {
    const slider = document.getElementById('budget-slider');
    if (!slider) return;
    slider.value = String(v);
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    slider.dispatchEvent(new Event('change', { bubbles: true }));
  }, amount);
  await sleep(500);
}

async function openTxLinkAndReturn(page, locator, holdMs = 5000, waitMs = 12000, required = true) {
  const start = Date.now();
  while ((await locator.count()) === 0 && (Date.now() - start < waitMs)) {
    await sleep(300);
  }
  if ((await locator.count()) === 0) {
    if (!required) return false;
    throw new Error('Transaction proof link not found');
  }

  const txLink = locator.first();
  await txLink.evaluate((el) => {
    el.setAttribute('target', '_self');
    el.removeAttribute('rel');
  });

  await Promise.all([
    page.waitForURL(/stellar\.expert/i, { timeout: 60000 }),
    txLink.click(),
  ]);
  await page.waitForLoadState('domcontentloaded', { timeout: 60000 });
  await sleep(holdMs);

  await page.goBack({ waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.locator('.sb-item[data-page]').first().waitFor({ timeout: 30000 });
  await sleep(700);
  return true;
}

async function runTask(page, taskText, budgetAmount) {
  const input = page.locator('#task-input');
  const runButton = page.locator('#btn-run');

  await clickSidebar(page, 'orchestrator', 1200);
  await input.waitFor({ timeout: 20000 });
  await hoverFocus(page, '#task-input', 650);
  await typeHuman(input, taskText);
  await setBudget(page, budgetAmount);
  await hoverFocus(page, '#budget-slider', 700);
  await sleep(600);
  await runButton.click();

  await page.locator('#result-panel.visible').waitFor({ timeout: 120000 });
  await hoverFocus(page, '#feed', 900);
  await hoverFocus(page, '#result-chips', 900);
  await sleep(2600);
}

async function openTransactionsAndClickFirst(page) {
  await clickSidebar(page, 'transactions', 1900);
  await sleep(1800);
  const firstHash = page.locator('#tx-body a.tx-hash').first();
  await openTxLinkAndReturn(page, firstHash, 5200);
}

async function main() {
  const recordingsDir = path.join(repoRoot, 'recordings');
  const tempDir = path.join(recordingsDir, 'tmp');
  await fs.mkdir(tempDir, { recursive: true });
  const timeline = { createdAt: new Date().toISOString(), scenes: [] };
  let recordingStartMs = 0;

  function sceneStart(id, label) {
    timeline.scenes.push({
      id,
      label,
      startMs: Math.max(0, Date.now() - recordingStartMs),
      endMs: null,
      durationMs: null,
    });
  }

  function sceneEnd(id) {
    for (let i = timeline.scenes.length - 1; i >= 0; i -= 1) {
      const scene = timeline.scenes[i];
      if (scene.id === id && scene.endMs === null) {
        scene.endMs = Math.max(0, Date.now() - recordingStartMs);
        scene.durationMs = Math.max(0, scene.endMs - scene.startMs);
        return;
      }
    }
  }

  console.log('\nStarting local server...\n');
  const server = spawn('node', ['src/server.js'], {
    cwd: repoRoot,
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });
  server.stdout.on('data', (chunk) => process.stdout.write(chunk));
  server.stderr.on('data', (chunk) => process.stderr.write(chunk));

  try {
    await waitForServer();
    console.log('\nRunning strict preflight...\n');
    await runNodeScript('src/demo-preflight.js', 'Preflight');

    console.log('\nRecording website-only demo video...\n');
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      viewport: { width: 1512, height: 900 },
      recordVideo: { dir: tempDir, size: { width: 1512, height: 900 } },
    });
    const page = await context.newPage();
    const video = page.video();
    recordingStartMs = Date.now();

    sceneStart('app_load', 'Open app');
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await page.locator('#task-input').waitFor({ timeout: 30000 });
    await sleep(2200);
    sceneEnd('app_load');

    // Scene 1: dashboard intro
    sceneStart('dashboard_intro', 'Dashboard intro');
    await clickSidebar(page, 'orchestrator', 1800);
    await hoverFocus(page, '#mbal-orch', 900);
    await hoverFocus(page, '#mbal-server', 700);
    await sleep(2000);
    sceneEnd('dashboard_intro');

    // Scene 2: agent registry
    sceneStart('agent_registry', 'Agent registry');
    await clickSidebar(page, 'agents', 1900);
    await hoverFocus(page, '#agent-cards > div', 1000);
    await smoothScroll(page, 240);
    await sleep(1300);
    await smoothScroll(page, -240);
    await sleep(1500);
    sceneEnd('agent_registry');

    // Scene 3: API status
    sceneStart('api_status', 'API status');
    await clickSidebar(page, 'status', 1900);
    await hoverFocus(page, '#status-grid > div', 900);
    await smoothScroll(page, 460);
    await sleep(1700);
    await smoothScroll(page, -200);
    await sleep(1200);
    sceneEnd('api_status');

    // Scene 4: main orchestration run
    sceneStart('main_run', 'Main orchestration run');
    await runTask(
      page,
      'Research practical enterprise use cases for x402 micropayments and recommend a go-to-market strategy.',
      0.15,
    );
    sceneEnd('main_run');

    // Scene 5: click TX proof (prefer result chips; fallback to transactions table)
    sceneStart('tx_proof_result', 'Transaction proof from result panel');
    const openedFromResult = await openTxLinkAndReturn(
      page,
      page.locator('#result-chips a.fi-link'),
      5600,
      14000,
      false,
    );
    if (!openedFromResult) {
      await clickSidebar(page, 'transactions', 1800);
      await openTxLinkAndReturn(page, page.locator('#tx-body a.tx-hash').first(), 5200);
      await clickSidebar(page, 'orchestrator', 1400);
    }
    sceneEnd('tx_proof_result');

    // Scene 6: budget guardrail run
    sceneStart('budget_run', 'Budget guardrail run');
    await runTask(
      page,
      'Analyze post-quantum migration strategy for fintech payment rails with clear risk tiers.',
      0.02,
    );
    await sleep(3200);
    sceneEnd('budget_run');

    // Scene 7: transaction table + hash verification click
    sceneStart('tx_proof_table', 'Transaction proof from table');
    await openTransactionsAndClickFirst(page);
    await sleep(1300);
    sceneEnd('tx_proof_table');

    // Scene 8: architecture close
    sceneStart('close', 'Close on status and transactions');
    await clickSidebar(page, 'status', 1700);
    await sleep(1700);
    await clickSidebar(page, 'transactions', 1700);
    await sleep(2400);
    sceneEnd('close');

    await context.close();
    await browser.close();

    const rawVideoPath = await video.path();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const finalPath = path.join(recordingsDir, `stellar-demo-${stamp}.webm`);
    const timelinePath = path.join(recordingsDir, `stellar-demo-${stamp}.timeline.json`);
    await fs.mkdir(recordingsDir, { recursive: true });
    await fs.rename(rawVideoPath, finalPath);
    await fs.writeFile(path.join(recordingsDir, 'latest-video.txt'), `${finalPath}\n`, 'utf8');
    await fs.writeFile(timelinePath, `${JSON.stringify(timeline, null, 2)}\n`, 'utf8');
    await fs.writeFile(path.join(recordingsDir, 'latest-timeline.txt'), `${timelinePath}\n`, 'utf8');

    console.log(`\nVideo created: ${finalPath}\n`);
    console.log(`Timeline created: ${timelinePath}\n`);
  } finally {
    server.kill();
  }
}

main().catch((err) => {
  console.error(`\nRecording failed: ${err.message}\n`);
  process.exit(1);
});
