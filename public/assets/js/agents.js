/**
 * Agents Module
 * Handles agent registry loading and display
 */

async function loadAgents() {
  try {
    const agents = await (await fetch('/api/agents')).json();
    document.getElementById('nav-cnt').textContent = agents.length;
    document.getElementById('sb-agents').innerHTML = agents
      .map(
        a => `
      <div class="sb-agent" id="agent-${a.id}">
        <span class="dot-on"></span>
        <div class="sb-agent-info">
          <div class="sb-agent-name">${a.name}</div>
          <div class="sb-agent-price">${a.price} USDC</div>
        </div>
      </div>
    `
      )
      .join('');
  } catch {}
}

async function loadAgentPage() {
  try {
    const agents = await (await fetch('/api/agents')).json();
    document.getElementById('agent-cards').innerHTML = agents
      .map(
        a => `
      <div class="ac">
        <div class="ac-head">
          <div class="ac-name">${a.name}</div>
          <div class="ac-status"><span class="dot-on"></span> Online</div>
        </div>
        <div class="ac-desc">${a.description || a.capability}</div>
        <div class="ac-meta">
          <span class="ac-tag price">💰 ${a.price} ${a.currency}</span>
          <span class="ac-tag model">🤖 ${a.model}</span>
          <span class="ac-tag endpoint">🔌 ${a.endpoint}</span>
        </div>
      </div>
    `
      )
      .join('');
  } catch {}
}

function highlightAgent(id) {
  const c = document.getElementById(`agent-${id}`);
  if (c) {
    c.querySelector('.dot-on')?.classList.add('pulse');
    setTimeout(() => c.querySelector('.dot-on')?.classList.remove('pulse'), 3000);
  }
}
