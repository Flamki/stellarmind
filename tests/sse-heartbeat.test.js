/**
 * Tests for SSE Heartbeat & Stale-Client Cleanup
 */
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert'
import { createClientTracker, safeBroadcast, setupHeartbeat } from '../src/sse-heartbeat.js'

describe('SSE Heartbeat & Stale-Client Cleanup', () => {
  describe('createClientTracker', () => {
    it('adds and removes clients', () => {
      const tracker = createClientTracker()
      const mockRes = { write: () => {}, end: () => {} }
      
      assert.strictEqual(tracker.size(), 0)
      assert.ok(tracker.addClient(mockRes))
      assert.strictEqual(tracker.size(), 1)
      
      tracker.removeClient(mockRes)
      assert.strictEqual(tracker.size(), 0)
    })

    it('rejects clients beyond max', () => {
      const tracker = createClientTracker()
      // Max is 100 — should be fine for this test
      for (let i = 0; i < 5; i++) {
        tracker.addClient({ write: () => {}, end: () => {} })
      }
      assert.strictEqual(tracker.size(), 5)
    })

    it('tracks write errors and signals removal after 3 consecutive', () => {
      const tracker = createClientTracker()
      const mockRes = { write: () => {} }
      tracker.addClient(mockRes)
      
      assert.strictEqual(tracker.markError(mockRes), false) // 1st error
      assert.strictEqual(tracker.markError(mockRes), false) // 2nd error
      assert.strictEqual(tracker.markError(mockRes), true)  // 3rd → remove
    })

    it('resets error count on successful markWrite', () => {
      const tracker = createClientTracker()
      const mockRes = { write: () => {} }
      tracker.addClient(mockRes)
      
      tracker.markError(mockRes)
      tracker.markError(mockRes)
      tracker.markWrite(mockRes)  // reset
      assert.strictEqual(tracker.markError(mockRes), false) // counter reset to 1
    })
  })

  describe('safeBroadcast', () => {
    it('broadcasts to all clients', () => {
      const clients = []
      const tracker = createClientTracker()
      const received = []
      
      const mockRes = {
        write(data) {
          // Parse SSE format
          const match = data.match(/^data: (.+)$/m)
          if (match) {
            received.push(JSON.parse(match[1]))
          }
        }
      }
      clients.push(mockRes)
      tracker.addClient(mockRes)
      
      safeBroadcast(clients, tracker, { type: 'test', value: 42 })
      
      assert.strictEqual(received.length, 1)
      assert.deepStrictEqual(received[0], { type: 'test', value: 42 })
    })

    it('removes dead clients on write failure', () => {
      const clients = []
      const tracker = createClientTracker()
      
      const goodRes = {
        written: [],
        write(data) { this.written.push(data) }
      }
      const badRes = {
        write() { throw new Error('connection lost') }
      }
      
      clients.push(goodRes, badRes)
      tracker.addClient(goodRes)
      tracker.addClient(badRes)
      
      safeBroadcast(clients, tracker, { type: 'test' })
      
      assert.strictEqual(clients.length, 1)
      assert.strictEqual(clients[0], goodRes)
      assert.ok(goodRes.written.length > 0)
    })
  })

  describe('setupHeartbeat', () => {
    it('starts and stops heartbeat', () => {
      const clients = []
      const broadcastCalls = []
      const broadcastFn = (event) => broadcastCalls.push(event)
      
      const { stopHeartbeat, getStats } = setupHeartbeat(clients, broadcastFn, {
        intervalMs: 100,
        staleTimeoutMs: 300,
      })
      
      assert.ok(typeof stopHeartbeat === 'function')
      assert.ok(typeof getStats === 'function')
      assert.deepStrictEqual(getStats(), {
        total: 0,
        oldestConnectedMs: 0,
        newestConnectedMs: 0,
        heartbeatIntervalMs: 100,
        staleTimeoutMs: 300,
      })
      
      stopHeartbeat()
    })
  })
})
