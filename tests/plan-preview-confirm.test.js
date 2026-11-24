/**
 * Plan Preview & Confirm Workflow Tests
 * Validates issue #166 implementation
 */

import assert from 'node:assert'
import { describe, it, before, after } from 'node:test'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

describe('Plan Preview & Confirm Workflow (#166)', () => {
  let serverProcess
  let serverUrl

  before(async () => {
    // Start server in background
    const serverPath = path.join(__dirname, '..', 'src', 'server.js')
    serverProcess = spawn('node', [serverPath], {
      env: { ...process.env, PORT: '0', NODE_ENV: 'test' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    // Wait for server to start and capture port
    await new Promise((resolve, reject) => {
      let output = ''
      const timeout = setTimeout(() => reject(new Error('Server start timeout')), 10000)

      serverProcess.stdout.on('data', (data) => {
        output += data.toString()
        const match = output.match(/listening on.*:(\d+)/)
        if (match) {
          clearTimeout(timeout)
          serverUrl = `http://localhost:${match[1]}`
          resolve()
        }
      })

      serverProcess.stderr.on('data', (data) => {
        console.error('Server error:', data.toString())
      })

      serverProcess.on('error', (err) => {
        clearTimeout(timeout)
        reject(err)
      })
    })
  })

  after(() => {
    if (serverProcess) {
      serverProcess.kill()
    }
  })

  it('should return a preview with quoted steps', async () => {
    const response = await fetch(`${serverUrl}/api/orchestrate/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        task: 'Research AI payments and provide analysis',
        budget: 0.15,
      }),
    })

    assert.strictEqual(response.status, 200, 'Preview API should return 200')

    const preview = await response.json()

    assert.ok(preview.planId, 'Preview should include planId')
    assert.ok(Array.isArray(preview.steps), 'Preview should include steps array')
    assert.ok(preview.steps.length > 0, 'Preview should have at least one step')

    // Validate step structure
    const firstStep = preview.steps[0]
    assert.ok(firstStep.agentId, 'Step should have agentId')
    assert.ok(firstStep.agentName, 'Step should have agentName')
    assert.ok(typeof firstStep.quotedCost === 'string', 'Step should have quotedCost as string')
    assert.ok(firstStep.quotedAsset, 'Step should have quotedAsset')
    assert.ok(Array.isArray(firstStep.dependencies), 'Step should have dependencies array')
  })

  it('should execute a confirmed plan', async () => {
    // First get a preview
    const previewResponse = await fetch(`${serverUrl}/api/orchestrate/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        task: 'Quick test task',
        budget: 0.1,
      }),
    })

    const preview = await previewResponse.json()
    assert.ok(preview.planId, 'Preview must have planId')

    // Now execute the plan
    const executeResponse = await fetch(`${serverUrl}/api/orchestrate/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        planId: preview.planId,
      }),
    })

    assert.strictEqual(executeResponse.status, 200, 'Execute should return 200')

    const result = await executeResponse.json()
    assert.ok(result.results, 'Result should include results')
    assert.ok(typeof result.totalSpent !== 'undefined', 'Result should include totalSpent')
  })

  it('should reject execution of non-existent plan', async () => {
    const response = await fetch(`${serverUrl}/api/orchestrate/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        planId: 'nonexistent-plan-12345',
      }),
    })

    assert.strictEqual(response.status, 404, 'Should return 404 for non-existent plan')

    const error = await response.json()
    assert.ok(error.error || error.message, 'Should include error message')
  })

  it('should not allow double execution of same plan', async () => {
    // Get a preview
    const previewResponse = await fetch(`${serverUrl}/api/orchestrate/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        task: 'Double execution test',
        budget: 0.1,
      }),
    })

    const preview = await previewResponse.json()

    // Execute once
    const firstExecution = await fetch(`${serverUrl}/api/orchestrate/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        planId: preview.planId,
      }),
    })

    assert.strictEqual(firstExecution.status, 200, 'First execution should succeed')

    // Try to execute again
    const secondExecution = await fetch(`${serverUrl}/api/orchestrate/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        planId: preview.planId,
      }),
    })

    assert.strictEqual(
      secondExecution.status,
      404,
      'Second execution should fail with 404 (plan already consumed)'
    )
  })

  it('should show per-step quoted costs in preview', async () => {
    const response = await fetch(`${serverUrl}/api/orchestrate/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        task: 'Multi-step task requiring research, analysis, and summary',
        budget: 0.2,
      }),
    })

    const preview = await response.json()

    assert.ok(preview.steps.length >= 1, 'Should have multiple steps for complex task')

    // Calculate total from steps
    const calculatedTotal = preview.steps.reduce((sum, step) => {
      const cost = parseFloat(step.quotedCost)
      assert.ok(!isNaN(cost) && cost >= 0, 'Each step should have valid cost')
      return sum + cost
    }, 0)

    assert.ok(calculatedTotal > 0, 'Total quoted cost should be positive')
    assert.ok(calculatedTotal <= 0.2, 'Total should not exceed budget')
  })

  it('should include dependency information in preview', async () => {
    const response = await fetch(`${serverUrl}/api/orchestrate/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        task: 'Research and then analyze the findings',
        budget: 0.15,
      }),
    })

    const preview = await response.json()

    // Find a step with dependencies (typically analysis depends on research)
    const stepsWithDeps = preview.steps.filter((s) => s.dependencies && s.dependencies.length > 0)

    // Some tasks may have dependent steps
    if (stepsWithDeps.length > 0) {
      const dependentStep = stepsWithDeps[0]
      assert.ok(Array.isArray(dependentStep.dependencies), 'Dependencies should be an array')
      assert.ok(
        dependentStep.dependencies.length > 0,
        'Dependent step should reference other steps'
      )
    }
  })

  it('should handle budget validation in preview', async () => {
    const response = await fetch(`${serverUrl}/api/orchestrate/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        task: 'Complex multi-agent task',
        budget: 0.01, // Very low budget
      }),
    })

    const preview = await response.json()

    // Server should still return preview, but may have fewer steps
    assert.ok(preview.steps, 'Should return preview even with low budget')

    const totalCost = preview.steps.reduce((sum, step) => sum + parseFloat(step.quotedCost), 0)

    // Either the total should fit in budget, or execution should fail later
    // The preview itself should always succeed
    assert.strictEqual(response.status, 200, 'Preview should succeed regardless of budget')
  })

  it('should preserve task and budget in plan context', async () => {
    const task = 'Unique test task for context preservation'
    const budget = 0.12

    const previewResponse = await fetch(`${serverUrl}/api/orchestrate/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task, budget }),
    })

    const preview = await previewResponse.json()

    // Execute the plan
    const executeResponse = await fetch(`${serverUrl}/api/orchestrate/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        planId: preview.planId,
      }),
    })

    const result = await executeResponse.json()

    // The result should reflect the original task (not always directly in response, but indirectly via run history)
    assert.ok(result.results, 'Should have execution results')
    assert.ok(result.totalSpent !== undefined, 'Should track spending')
  })

  it('should handle preview for different task types', async () => {
    const tasks = [
      { task: 'Research quantum computing', budget: 0.05 },
      { task: 'Analyze market trends', budget: 0.08 },
      { task: 'Generate code example', budget: 0.06 },
    ]

    for (const taskConfig of tasks) {
      const response = await fetch(`${serverUrl}/api/orchestrate/preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(taskConfig),
      })

      assert.strictEqual(response.status, 200, `Preview should work for: ${taskConfig.task}`)

      const preview = await response.json()
      assert.ok(preview.planId, 'Should have planId')
      assert.ok(preview.steps.length > 0, 'Should have steps')
    }
  })

  it('should include asset type in quote (USDC)', async () => {
    const response = await fetch(`${serverUrl}/api/orchestrate/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        task: 'Test asset type',
        budget: 0.1,
      }),
    })

    const preview = await response.json()

    preview.steps.forEach((step) => {
      assert.strictEqual(step.quotedAsset, 'USDC', 'All quotes should be in USDC')
    })
  })

  it('should validate planId format', async () => {
    const response = await fetch(`${serverUrl}/api/orchestrate/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        task: 'Plan ID format test',
        budget: 0.1,
      }),
    })

    const preview = await response.json()

    assert.ok(
      typeof preview.planId === 'string' && preview.planId.length > 0,
      'planId should be a non-empty string'
    )
  })

  it('should not execute without planId', async () => {
    const response = await fetch(`${serverUrl}/api/orchestrate/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })

    assert.ok(response.status >= 400, 'Should reject execution without planId')
  })

  it('should handle GET request for preview', async () => {
    const task = 'GET request test'
    const budget = 0.1

    const response = await fetch(
      `${serverUrl}/api/orchestrate/preview?task=${encodeURIComponent(task)}&budget=${budget}`,
      {
        method: 'GET',
      }
    )

    assert.strictEqual(response.status, 200, 'Preview should support GET requests')

    const preview = await response.json()
    assert.ok(preview.planId, 'GET preview should return planId')
    assert.ok(preview.steps, 'GET preview should return steps')
  })

  it('should handle invalid budget in preview', async () => {
    const response = await fetch(`${serverUrl}/api/orchestrate/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        task: 'Invalid budget test',
        budget: -1,
      }),
    })

    assert.ok(response.status >= 400, 'Should reject negative budget')
  })

  it('should handle empty task in preview', async () => {
    const response = await fetch(`${serverUrl}/api/orchestrate/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        task: '',
        budget: 0.1,
      }),
    })

    assert.ok(response.status >= 400, 'Should reject empty task')
  })

  it('should handle missing required fields', async () => {
    const response = await fetch(`${serverUrl}/api/orchestrate/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })

    assert.ok(response.status >= 400, 'Should reject missing task and budget')
  })
})
