import { Networks } from '@stellar/stellar-sdk'

/**
 * Single source of truth for every Stellar network fact the app relies on.
 *
 * Before this module the network was described in several places that could
 * disagree: `config.network` was configurable, while `wallet.js` hard-coded the
 * testnet Horizon origin, testnet passphrase, testnet explorer links, and
 * testnet Friendbot. A deployment could therefore advertise one network while
 * signing and reading another.
 *
 * A *network profile* bundles the network identifier, transaction passphrase,
 * Horizon/RPC origins, explorer origin, and asset identity (USDC issuer) so all
 * wallet and payment components resolve the same validated values.
 *
 * Testnet is the supported profile. Other networks are recognised so the app
 * can reject them with an actionable error instead of silently describing two
 * networks at once.
 */

export const STELLAR_TESTNET = 'stellar:testnet'
export const STELLAR_PUBNET = 'stellar:pubnet'

/** Networks this deployment is allowed to run on. */
export const SUPPORTED_NETWORKS = [STELLAR_TESTNET]

export const DEFAULT_NETWORK = STELLAR_TESTNET

const NETWORK_PROFILES = {
  [STELLAR_TESTNET]: {
    network: STELLAR_TESTNET,
    label: 'testnet',
    passphrase: Networks.TESTNET,
    horizonUrl: 'https://horizon-testnet.stellar.org',
    rpcUrl: 'https://soroban-testnet.stellar.org',
    explorerBaseUrl: 'https://stellar.expert/explorer/testnet',
    usdc: {
      code: 'USDC',
      // Circle USDC issuer on Stellar testnet.
      issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
    },
    funding: {
      friendbotUrl: 'https://friendbot.stellar.org',
      faucetUrl: 'https://faucet.circle.com',
    },
    supported: true,
  },
  [STELLAR_PUBNET]: {
    network: STELLAR_PUBNET,
    label: 'mainnet',
    passphrase: Networks.PUBLIC,
    horizonUrl: 'https://horizon.stellar.org',
    // Public Soroban RPC requires an explicit provider URL; there is no default.
    rpcUrl: null,
    explorerBaseUrl: 'https://stellar.expert/explorer/public',
    usdc: {
      code: 'USDC',
      // Circle USDC issuer on Stellar mainnet.
      issuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
    },
    // No funding helpers on a public network.
    funding: { friendbotUrl: null, faucetUrl: null },
    supported: false,
  },
}

/** Raised for any inconsistent or unsupported network configuration. */
export class NetworkConfigError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'NetworkConfigError'
    this.code = code
  }
}

/** Every known profile, supported or not. Used for diagnostics and tests. */
export function listNetworkProfiles() {
  return Object.values(NETWORK_PROFILES).map((profile) => ({ ...profile }))
}

/** Look up a known profile by its CAIP-2 network identifier. */
export function getNetworkProfile(network) {
  return NETWORK_PROFILES[network] ? { ...NETWORK_PROFILES[network] } : null
}

const trimTrailingSlash = (value) => value.replace(/\/+$/, '')

/**
 * An explicit endpoint override is only accepted when it names the same origin
 * as the selected profile. Anything else means two parts of the deployment
 * describe two different networks, which is exactly what this module prevents.
 */
function resolveEndpoint({ value, canonical, variable, profile }) {
  if (!value) return canonical
  if (trimTrailingSlash(value) !== trimTrailingSlash(canonical)) {
    throw new NetworkConfigError(
      `${variable}="${value}" does not match the "${profile.network}" profile endpoint ` +
        `"${canonical}". Remove the override, or set NETWORK to the profile it belongs to.`,
      'MISMATCHED_ENDPOINT'
    )
  }
  return canonical
}

/**
 * Resolve and validate one consistent network profile.
 *
 * @param {object} env - configuration fixture, typically derived from process.env
 * @param {string} [env.network] - CAIP-2 network identifier
 * @param {string} [env.horizonUrl] - optional STELLAR_HORIZON_URL override
 * @param {string} [env.rpcUrl] - optional STELLAR_RPC_URL override
 * @param {string} [env.explorerUrl] - optional STELLAR_EXPLORER_URL override
 * @returns {Readonly<object>} the frozen, validated profile
 * @throws {NetworkConfigError} on unknown, unsupported, or mismatched config
 */
export function resolveNetworkProfile(env = {}) {
  const network = (env.network || DEFAULT_NETWORK).trim()
  const profile = NETWORK_PROFILES[network]

  if (!profile) {
    throw new NetworkConfigError(
      `Unsupported Stellar network "${network}". Supported: ${SUPPORTED_NETWORKS.join(', ')}.`,
      'UNSUPPORTED_NETWORK'
    )
  }

  if (!profile.supported) {
    throw new NetworkConfigError(
      `Stellar network "${network}" is recognised but not enabled by this deployment. ` +
        `Only ${SUPPORTED_NETWORKS.join(', ')} is supported. Testnet-only helpers such as ` +
        `Friendbot are unavailable on "${profile.label}".`,
      'UNSUPPORTED_NETWORK'
    )
  }

  const horizonUrl = resolveEndpoint({
    value: env.horizonUrl,
    canonical: profile.horizonUrl,
    variable: 'STELLAR_HORIZON_URL',
    profile,
  })

  const rpcUrl = resolveEndpoint({
    value: env.rpcUrl,
    canonical: profile.rpcUrl,
    variable: 'STELLAR_RPC_URL',
    profile,
  })

  const explorerBaseUrl = resolveEndpoint({
    value: env.explorerUrl,
    canonical: profile.explorerBaseUrl,
    variable: 'STELLAR_EXPLORER_URL',
    profile,
  })

  return Object.freeze({
    ...profile,
    horizonUrl,
    rpcUrl,
    explorerBaseUrl,
    usdc: Object.freeze({ ...profile.usdc }),
    funding: Object.freeze({ ...profile.funding }),
  })
}

/** Explorer link for a transaction, on the profile the transaction was sent to. */
export function explorerTxUrl(profile, hash) {
  return hash ? `${profile.explorerBaseUrl}/tx/${hash}` : null
}

/** Explorer link for an account, on the given profile. */
export function explorerAccountUrl(profile, address) {
  return address ? `${profile.explorerBaseUrl}/account/${address}` : null
}

/**
 * Friendbot is a testnet-only funding helper. Refuse to hand back a URL for any
 * profile that does not define one, so funding cannot be enabled on another
 * network by accident.
 */
export function getFriendbotUrl(profile) {
  const url = profile?.funding?.friendbotUrl
  if (!url) {
    throw new NetworkConfigError(
      `Friendbot funding is only available on ${STELLAR_TESTNET}; ` +
        `"${profile?.network || 'unknown'}" has no funding helper.`,
      'FUNDING_UNSUPPORTED'
    )
  }
  return url
}
