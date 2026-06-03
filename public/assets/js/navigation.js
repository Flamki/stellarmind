/**
 * Navigation Module
 * Handles page switching and sidebar state management
 */

const pageTitles = {
  orchestrator: 'Task Orchestrator',
  agents: 'Agent Registry',
  status: 'API Status',
  transactions: 'Transactions',
};

function showPage(id) {
  // Hide all pages
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById(`page-${id}`).classList.add('active');

  // Update sidebar active state
  document.querySelectorAll('.sb-item').forEach(i => i.classList.remove('active'));
  document.querySelector(`.sb-item[data-page="${id}"]`).classList.add('active');

  // Update topbar title
  document.getElementById('topbar-title').textContent = pageTitles[id] || id;

  // Load page-specific data
  if (id === 'agents') loadAgentPage();
  if (id === 'status') loadStatusPage();
  if (id === 'transactions') loadTxPage();
}
