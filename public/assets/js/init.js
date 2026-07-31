/**
 * Initialization Module
 * Handles app startup and event listeners
 */

function initApp() {
  // Initialize budget slider
  initBudgetSlider()

  // Load initial data
  loadAgents()
  loadWallets()
  connectSSE()

  // Set up periodic wallet refresh
  setInterval(loadWallets, 15000)

  // Set up task input Enter key handler
  document.getElementById('task-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      runOrchestration()
    }
  })
}

// Start app when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp)
} else {
  initApp()
}
