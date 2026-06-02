/**
 * Integration/Unit Tests for Security Hardening
 */
import assert from 'node:assert';
import { adminAuth } from '../src/middleware/auth.js';
import { config } from '../src/config.js';

// Mock request, response, and next
function makeMockReq(headers = {}, path = '/api/config/apikey') {
  return {
    header: (name) => headers[name] || null,
    path,
    requestId: 'test-request-id'
  };
}

function makeMockRes() {
  const res = {
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
    statusCode: 200,
    body: null
  };
  return res;
}

async function runTest() {
  console.log('\n📋 Testing Security Hardening (adminAuth middleware)...');

  // Test Case 1: No ADMIN_TOKEN configured (Developer Bypass)
  {
    console.log('  - Testing Developer Bypass (no token set)...');
    const originalToken = config.adminToken;
    config.adminToken = ''; // Ensure no token
    
    const req = makeMockReq();
    const res = makeMockRes();
    let nextCalled = false;
    let nextError = null;

    adminAuth(req, res, (err) => {
      nextCalled = true;
      nextError = err;
    });

    assert.strictEqual(nextCalled, true, 'Next should be called');
    assert.strictEqual(nextError, undefined, 'No error should be passed to next');
    
    config.adminToken = originalToken; // Restore
  }

  // Test Case 2: ADMIN_TOKEN configured, Valid Header
  {
    console.log('  - Testing Authorized Access (valid token)...');
    const originalToken = config.adminToken;
    config.adminToken = 'secret-token';
    
    const req = makeMockReq({ 'x-admin-token': 'secret-token' });
    const res = makeMockRes();
    let nextCalled = false;
    let nextError = null;

    adminAuth(req, res, (err) => {
      nextCalled = true;
      nextError = err;
    });

    assert.strictEqual(nextCalled, true, 'Next should be called');
    assert.strictEqual(nextError, undefined, 'No error should be passed to next');
    
    config.adminToken = originalToken; // Restore
  }

  // Test Case 3: ADMIN_TOKEN configured, Missing Header
  {
    console.log('  - Testing Unauthorized Access (missing token)...');
    const originalToken = config.adminToken;
    config.adminToken = 'secret-token';
    
    const req = makeMockReq({}); // No headers
    const res = makeMockRes();
    let nextCalled = false;
    let nextError = null;

    adminAuth(req, res, (err) => {
      nextCalled = true;
      nextError = err;
    });

    assert.strictEqual(nextCalled, true, 'Next should be called with error');
    assert.ok(nextError instanceof Error, 'Should pass an error');
    assert.strictEqual(nextError.status, 401, 'Error status should be 401');
    assert.strictEqual(nextError.code, 'UNAUTHORIZED', 'Error code should be UNAUTHORIZED');
    
    config.adminToken = originalToken; // Restore
  }

  // Test Case 4: ADMIN_TOKEN configured, Invalid Header
  {
    console.log('  - Testing Unauthorized Access (invalid token)...');
    const originalToken = config.adminToken;
    config.adminToken = 'secret-token';
    
    const req = makeMockReq({ 'x-admin-token': 'wrong-token' });
    const res = makeMockRes();
    let nextCalled = false;
    let nextError = null;

    adminAuth(req, res, (err) => {
      nextCalled = true;
      nextError = err;
    });

    assert.strictEqual(nextCalled, true, 'Next should be called with error');
    assert.ok(nextError instanceof Error, 'Should pass an error');
    assert.strictEqual(nextError.status, 401, 'Error status should be 401');
    
    config.adminToken = originalToken; // Restore
  }

  console.log('\n✅ All security tests passed!');
}

runTest().catch(err => {
  console.error('\n❌ Security tests failed:');
  console.error(err);
  process.exit(1);
});
