/**
 * Rendering Module
 * Handles result display and progress rendering
 */

function setResultTag(text, tone = '') {
  const tag = document.getElementById('result-tag');
  tag.textContent = text;
  tag.className = tone ? `tag ${tone}` : 'tag';
}

function ensureResultPanelVisible() {
  const p = document.getElementById('result-panel');
  p.classList.add('visible');
  return p;
}

function appendResultLog(line) {
  const out = document.getElementById('result-out');
  const stamp = new Date().toLocaleTimeString();
  const next = `${out.textContent === 'No run yet.' ? '' : out.textContent}\n[${stamp}] ${line}`.trim();
  const lines = next.split('\n');
  out.textContent = lines.slice(-160).join('\n');
  out.scrollTop = out.scrollHeight;
}

function pushLiveLine(line) {
  const box = document.getElementById('result-live');
  const item = document.createElement('div');
  item.className = 'live-line';
  item.textContent = line;
  box.prepend(item);
  while (box.children.length > 6) box.removeChild(box.lastChild);
}

function getRunProgressInfo(r = activeRun) {
  if (!r) return { planned: 0, completed: 0, percent: 0 };
  const planned = Math.max(Number(r.planned || 0), Number(r.completed || 0), 0);
  const completed = Math.min(Number(r.completed || 0), planned || Number(r.completed || 0));
  if (!planned) return { planned, completed, percent: r.running ? 5 : 100 };
  const raw = (completed / planned) * 100;
  const visible = r.running && completed === 0 ? 8 : raw;
  const bounded = r.running ? Math.min(visible, 98) : 100;
  return { planned, completed, percent: Math.max(0, Math.min(100, bounded)) };
}

function renderLiveChips(r = activeRun) {
  if (!r) return;
  const elapsedMs = Date.now() - r.startedAt;
  const elapsedSec = (elapsedMs / 1000).toFixed(1);
  const { planned, completed, percent } = getRunProgressInfo(r);
  const progress = planned > 0 ? `${completed}/${planned}` : `${completed}`;
  const status = r.running ? 'Running' : 'Complete';

  document.getElementById('result-chips').innerHTML = `
    <div class="chip">Status: <span class="v">${status}</span></div>
    <div class="chip">Progress: <span class="v">${progress}</span></div>
    <div class="chip">Spent: <span class="v">${r.spent.toFixed(2)} / ${r.budget.toFixed(2)} USDC</span></div>
    <div class="chip">Time: <span class="v">${elapsedSec}s</span></div>
  `;

  document.getElementById('progress-fill').style.width = `${percent.toFixed(1)}%`;
  document.getElementById('progress-percent').textContent = `${Math.round(percent)}%`;
  document.getElementById('progress-label').textContent = r.running
    ? `Running · ${progress} agents complete`
    : `Completed · ${progress} agents complete`;
}

function normalizeFinalAnswer(text) {
  if (!text) return 'No final answer returned.';
  let out = String(text).trim();
  out = out.replace(/^```[a-zA-Z]*\n?/g, '').replace(/```$/g, '');
  out = out.replace(/^#{1,6}\s*/gm, '');
  out = out.replace(/\n{3,}/g, '\n\n');
  return out.trim();
}

function showResult(r) {
  const p = document.getElementById('result-panel');
  const out = document.getElementById('result-out');
  const ch = document.getElementById('result-chips');

  p.classList.add('visible');
  p.classList.remove('running');
  setResultTag('Complete', 'green');
  stopRunHeartbeat();

  document.getElementById('result-status-line').textContent =
    'Execution complete. Final answer and per-agent outputs are shown below.';

  const successful = (r.results || []).filter(x => !x.skipped);
  const preferred =
    successful.find(x => x.agentId === 'summary-bot') ||
    successful.find(x => x.agentId === 'analyst-bot') ||
    successful[0];
  const finalAnswer = normalizeFinalAnswer(preferred?.output || 'No final answer returned.');

  let details = '';
  for (const x of r.results || []) {
    details += x.skipped
      ? `\n[SKIPPED] ${x.agentId}: ${x.reason}\n`
      : `\n--- ${x.agentName} (${x.cost} ${x.currency}) ---\n${x.output}\n`;
  }

  out.textContent = `FINAL ANSWER\n${finalAnswer}\n\nAGENT DETAILS${details}`;

  const txL = (r.payments || [])
    .map(p => `<a href="${p.explorerUrl}" target="_blank" class="fi-link">${p.txHash?.slice(0, 8)} &nearr;</a>`)
    .join(' ');

  ch.innerHTML = `
    <div class="chip">Agents: <span class="v">${r.agentsUsed || 0}</span></div>
    <div class="chip">Spent: <span class="v">${r.totalSpent || '0'} USDC</span></div>
    <div class="chip">TXs: <span class="v">${r.txCount || 0}</span></div>
    <div class="chip">Protocol: <span class="v">${r.paymentProtocol || 'stellar'}</span></div>
    <div class="chip">Time: <span class="v">${r.elapsed || '-'}</span></div>
    ${r.budgetExhausted ? '<div class="chip" style="color:var(--amber)">Budget Used</div>' : ''}
    ${txL ? `<div class="chip" style="flex-wrap:wrap;gap:4px;">Verify: ${txL}</div>` : ''}
  `;

  if (activeRun) {
    activeRun.running = false;
    activeRun.completed = Number(r.agentsUsed || activeRun.completed || 0);
    activeRun.planned = Math.max(activeRun.planned || 0, Number(r.agentsUsed || 0) + Number(r.agentsSkipped || 0));
    activeRun.spent = Number.parseFloat(r.totalSpent || activeRun.spent || 0);
  }

  renderLiveChips(activeRun);
  pushLiveLine('Final answer generated');
}
