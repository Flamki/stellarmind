/**
 * Guards for issue #156: one validated Stellar network profile.
 *
 * `config.network` was configurable while `wallet.js` hard-coded the testnet
 * Horizon origin, testnet passphrase, testnet explorer links, and testnet
 * Friendbot. A single deployment could therefore describe more than one
 * network. These checks exercise the resolver with configuration fixtures and
 * never submit a transaction.
 *
 * Run: node tests/network-profile.test.js
 */

import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Networks } from '@stellar/stellar-sdk'
import { config } from '../src/config.js'
import {
  DEFAULT_NETWORK,
  NetworkConfigError,
  STELLAR_PUBNET,
  STELLAR_TESTNET,
  explorerAccountUrl,
  explorerTxUrl,
  getFriendbotUrl,
  getNetworkProfile,
  listNetworkProfiles,
  resolveNetworkProfile,
} from '../src/stellar/network.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (relative) => fs.readFileSync(path.join(repoRoot, relative), 'utf8')

const TESTNET_HORIZON = 'https://horizon-testnet.stellar.org'
const TESTNET_RPC = 'https://soroban-testnet.stellar.org'
const TESTNET_EXPLORER = 'https://stellar.expert/explorer/testnet'
const PUBNET_HORIZON = 'https://horizon.stellar.org'
const PUBNET_EXPLORER = 'https://stellar.expert/explorer/public'

const assertThrowsNetwork = (fn, code, pattern) => {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof NetworkConfigError, 'must fail with a NetworkConfigError')
    assert.strictEqual(err.code, code)
    assert.match(err.message, pattern)
    return true
  })
}

// ── 1. the default profile is testnet and fully specified ───────────────────

{
  const profile = resolveNetworkProfile({})

  assert.strictEqual(DEFAULT_NETWORK, STELLAR_TESTNET)
  assert.strictEqual(profile.network, STELLAR_TESTNET)
  assert.strictEqual(profile.label, 'testnet')
  assert.strictEqual(profile.passphrase, Networks.TESTNET)
  assert.strictEqual(profile.horizonUrl, TESTNET_HORIZON)
  assert.strictEqual(profile.rpcUrl, TESTNET_RPC)
  assert.strictEqual(profile.explorerBaseUrl, TESTNET_EXPLORER)
  assert.strictEqual(profile.usdc.code, 'USDC')
  assert.match(profile.usdc.issuer, /^G[A-Z2-7]{55}$/)
  assert.strictEqual(profile.funding.friendbotUrl, 'https://friendbot.stellar.org')
  assert.strictEqual(profile.supported, true)
  assert.ok(Object.isFrozen(profile), 'a resolved profile must not be mutated by callers')
}

// ── 2. config exposes the same resolved profile ─────────────────────────────

{
  assert.strictEqual(config.network, config.networkProfile.network)
  assert.strictEqual(config.horizonUrl, config.networkProfile.horizonUrl)
  assert.strictEqual(config.stellarRpcUrl, config.networkProfile.rpcUrl)
  assert.strictEqual(config.networkProfile.passphrase, Networks.TESTNET)
}

// ── 3. a matching endpoint override is accepted ─────────────────────────────

{
  const profile = resolveNetworkProfile({
    network: STELLAR_TESTNET,
    horizonUrl: TESTNET_HORIZON,
    rpcUrl: TESTNET_RPC,
    explorerUrl: TESTNET_EXPLORER,
  })
  assert.strictEqual(profile.horizonUrl, TESTNET_HORIZON)
  assert.strictEqual(profile.rpcUrl, TESTNET_RPC)
  assert.strictEqual(profile.explorerBaseUrl, TESTNET_EXPLORER)
}

// ── 4. mismatched endpoints are rejected ────────────────────────────────────

{
  assertThrowsNetwork(
    () => resolveNetworkProfile({ network: STELLAR_TESTNET, horizonUrl: PUBNET_HORIZON }),
    'MISMATCHED_ENDPOINT',
    /STELLAR_HORIZON_URL.*stellar:testnet/
  )
  assertThrowsNetwork(
    () =>
      resolveNetworkProfile({
        network: STELLAR_TESTNET,
        rpcUrl: 'https://soroban-mainnet.stellar.org',
      }),
    'MISMATCHED_ENDPOINT',
    /STELLAR_RPC_URL.*stellar:testnet/
  )
  assertThrowsNetwork(
    () => resolveNetworkProfile({ network: STELLAR_TESTNET, explorerUrl: PUBNET_EXPLORER }),
    'MISMATCHED_ENDPOINT',
    /STELLAR_EXPLORER_URL.*stellar:testnet/
  )
}

// ── 5. unknown networks are rejected with a useful error ────────────────────

{
  assertThrowsNetwork(
    () => resolveNetworkProfile({ network: 'stellar:futurenet' }),
    'UNSUPPORTED_NETWORK',
    /Unsupported Stellar network "stellar:futurenet".*stellar:testnet/
  )
}

// ── 6. known-but-disabled networks are rejected, not silently used ──────────

{
  const pubnet = getNetworkProfile(STELLAR_PUBNET)
  assert.ok(pubnet, 'pubnet should be a recognised profile')
  assert.strictEqual(pubnet.supported, false)
  assert.strictEqual(pubnet.passphrase, Networks.PUBLIC)

  assertThrowsNetwork(
    () => resolveNetworkProfile({ network: STELLAR_PUBNET, rpcUrl: 'https://rpc.example.com' }),
    'UNSUPPORTED_NETWORK',
    /recognised but not enabled.*stellar:testnet/
  )
}

// ── 7. funding helpers cannot be enabled for another profile ────────────────

{
  const testnet = resolveNetworkProfile({})
  assert.strictEqual(
    getFriendbotUrl(testnet),
    'https://friendbot.stellar.org',
    'testnet must expose Friendbot'
  )

  const pubnet = getNetworkProfile(STELLAR_PUBNET)
  assertThrowsNetwork(
    () => getFriendbotUrl(pubnet),
    'FUNDING_UNSUPPORTED',
    /only available on stellar:testnet/
  )
}

// ── 8. explorer links follow the profile of the recorded transaction ────────

{
  const testnet = resolveNetworkProfile({})
  const pubnet = getNetworkProfile(STELLAR_PUBNET)

  assert.strictEqual(explorerTxUrl(testnet, 'abc123'), `${TESTNET_EXPLORER}/tx/abc123`)
  assert.strictEqual(explorerAccountUrl(testnet, 'GABC'), `${TESTNET_EXPLORER}/account/GABC`)
  assert.strictEqual(explorerTxUrl(pubnet, 'abc123'), `${PUBNET_EXPLORER}/tx/abc123`)
  assert.strictEqual(explorerTxUrl(testnet, null), null)
  assert.strictEqual(explorerAccountUrl(testnet, ''), null)
}

// ── 9. the profile list stays self-describing ───────────────────────────────

{
  const profiles = listNetworkProfiles()
  const ids = profiles.map((profile) => profile.network).sort()
  assert.deepStrictEqual(ids, [STELLAR_PUBNET, STELLAR_TESTNET])
  for (const profile of profiles) {
    assert.ok(profile.passphrase, `${profile.network} must define a passphrase`)
    assert.ok(profile.horizonUrl, `${profile.network} must define a Horizon origin`)
    assert.ok(profile.explorerBaseUrl, `${profile.network} must define an explorer origin`)
    assert.ok(profile.usdc?.issuer, `${profile.network} must define a USDC issuer`)
  }
}

// ── 10. the hard-coded testnet facts do not creep back in ───────────────────

{
  const wallet = read('src/stellar/wallet.js')
  assert.ok(
    !/horizon-testnet\.stellar\.org/.test(wallet),
    'wallet.js must resolve Horizon from the profile, not hard-code testnet'
  )
  assert.ok(
    !/stellar\.expert\/explorer\/testnet/.test(wallet),
    'wallet.js must build explorer links from the profile'
  )
  assert.ok(
    !/friendbot\.stellar\.org/.test(wallet),
    'wallet.js must gate Friendbot through the profile'
  )
  assert.ok(
    !/Networks\.TESTNET/.test(wallet),
    'wallet.js must take the passphrase from the profile'
  )

  const orchestrator = read('src/agents/orchestrator.js')
  assert.ok(
    !/stellar\.expert\/explorer\/testnet/.test(orchestrator),
    'orchestrator.js must build explorer links from the profile'
  )
}

console.log('✅ network profile validation checks passed')
