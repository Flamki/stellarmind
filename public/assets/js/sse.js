/**
 * SSE Module
 * Handles Server-Sent Events connection and feed updates
 */

let evCnt = 0;

function connectSSE() {
  const es = new EventSource('/api/events');
  es.onmessage = e => {
    try {
      const ev = JSON.parse(e.data);
      if (ev.type !== 'connected') addFeed(ev);
    } catch {}
  };
  es.onerror = () => setTimeout(connectSSE, 3000);
}

function addFeed(ev) {
  const f = document.getElementById('feed');
  const em = document.getElementById('feed-empty');
  if (em) em.style.display = 'none';

  evCnt++;
  document.getElementById('ev-cnt').textContent = `${evCnt} Events`;

  const el = document.createElement('div');
  el.className = 'fi';

  let ic = '📡',
    cl = 'agt',
    lb = '',
    sb = '';

  switch (ev.type) {
    case 'orchestrator_start':
      ic = '🎯';
      cl = 'pln';
      lb = 'Orchestrator Started';
      sb = `Task: ${ev.task?.substring(0, 45)}...`;
      break;
    case 'orchestrator_plan':
      ic = '📋';
      cl = 'pln';
      lb = `Plan: ${ev.plan?.substring(0, 40)}`;
      sb = `${ev.subtaskCount} subtasks`;
      break;
    case 'agent_call':
      ic = '⚡';
      cl = 'agt';
      lb = `${ev.agent} called`;
      sb = `${ev.cost} USDC | ${ev.paymentFlow || 'stellar'}`;
      highlightAgent(ev.agentId);
      break;
    case 'x402_payment':
      ic = '🔐';
      cl = 'x4';
      lb = `x402: ${ev.agent}`;
      sb = `${ev.amount} ${ev.currency} via x402${ev.verification === 'unverified' ? ' (header pending)' : ''}`;
      break;
    case 'x402_retry':
      ic = '🔁';
      cl = 'x4';
      lb = 'x402 retry handled';
      sb = `${ev.agent || 'agent'} | fallback flow active`;
      break;
    case 'agent_response':
      ic = '✅';
      cl = 'ok';
      lb = `${ev.agent} responded`;
      sb = `${ev.paidVia ? '[' + ev.paidVia + '] ' : ''}${(ev.resultPreview || 'Output received').substring(0, 40)}...`;
      break;
    case 'payment':
      ic = '💸';
      cl = 'pay';
      lb = `${ev.from} -> ${ev.to}`;
      sb = `${ev.amount} ${ev.currency} | ${ev.method || 'stellar'}`;
      break;
    case 'budget_limit':
      ic = '🛑';
      cl = 'bgt';
      lb = `Budget: ${ev.agent} skipped`;
      sb = `Need ${ev.cost}, ${ev.remaining} left`;
      break;
    case 'orchestrator_complete':
      ic = '🏁';
      cl = 'ok';
      lb = `Done - ${ev.totalSpent} USDC`;
      sb = `${ev.agentsUsed} agents | ${ev.elapsed}`;
      break;
    case 'error':
      ic = '⚠️';
      cl = 'bgt';
      lb = 'Run Error';
      sb = (ev.message || 'Unknown error').substring(0, 60);
      break;
    default:
      lb = ev.type;
      sb = JSON.stringify(ev).substring(0, 60);
  }

  const at = ev.timestamp ? new Date(ev.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : null;
  if (at) sb = sb ? `${sb} | ${at}` : at;

  const lk = ev.explorerUrl ? `<a href="${ev.explorerUrl}" target="_blank" class="fi-link">TX &nearr;</a>` : '';

  el.innerHTML = `<div class="fi-icon ${cl}">${ic}</div><div class="fi-info"><div class="fi-l">${lb}</div><div class="fi-s">${sb}</div></div>${lk}`;
  f.prepend(el);

  trackLiveEvent(ev);
}
