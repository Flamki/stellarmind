/**
 * Budget Module
 * Handles budget slider and display updates
 */

function initBudgetSlider() {
  const bSlider = document.getElementById('budget-slider')
  const bDisp = document.getElementById('budget-display')

  bSlider.addEventListener('input', () => {
    bDisp.textContent = `${parseFloat(bSlider.value).toFixed(2)} USDC`
  })
}
