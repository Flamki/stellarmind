import { Keypair, Horizon, Networks, TransactionBuilder, Operation, Asset } from '@stellar/stellar-sdk';

const HORIZON_URL = 'https://horizon-testnet.stellar.org';
const server = new Horizon.Server(HORIZON_URL);

/**
 * Get balance for a Stellar public key
 */
export async function getBalance(publicKey) {
  try {
    const account = await server.loadAccount(publicKey);
    return account.balances.map(b => ({
      asset: b.asset_type === 'native' ? 'XLM' : `${b.asset_code}`,
      balance: b.balance,
      issuer: b.asset_issuer || null,
    }));
  } catch (err) {
    console.error(`Failed to load balance for ${publicKey}:`, err.message);
    return [];
  }
}

/**
 * Get keypair from a secret key string
 */
export function getKeypair(secretKey) {
  return Keypair.fromSecret(secretKey);
}

/**
 * Send XLM payment between two wallets (for demo agent-to-agent payments)
 */
export async function sendPayment(senderSecret, recipientPublic, amount, memo = '') {
  try {
    const senderKeypair = Keypair.fromSecret(senderSecret);
    const senderAccount = await server.loadAccount(senderKeypair.publicKey());

    const txBuilder = new TransactionBuilder(senderAccount, {
      fee: '100',
      networkPassphrase: Networks.TESTNET,
    });

    txBuilder.addOperation(
      Operation.payment({
        destination: recipientPublic,
        asset: Asset.native(),
        amount: String(amount),
      })
    );

    if (memo) {
      txBuilder.addMemo(new (await import('@stellar/stellar-sdk')).Memo('text', memo.slice(0, 28)));
    }

    txBuilder.setTimeout(30);
    const tx = txBuilder.build();
    tx.sign(senderKeypair);

    const result = await server.submitTransaction(tx);
    return {
      success: true,
      txHash: result.hash,
      ledger: result.ledger,
      explorerUrl: `https://stellar.expert/explorer/testnet/tx/${result.hash}`,
    };
  } catch (err) {
    console.error('Payment failed:', err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Fund a wallet via Friendbot (testnet only)
 */
export async function fundWithFriendbot(publicKey) {
  try {
    const response = await fetch(`https://friendbot.stellar.org?addr=${publicKey}`);
    const data = await response.json();
    return { success: true, data };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Get recent transactions for a wallet
 */
export async function getTransactions(publicKey, limit = 10) {
  try {
    const txs = await server.transactions()
      .forAccount(publicKey)
      .order('desc')
      .limit(limit)
      .call();

    const decorated = await Promise.all(
      txs.records.map(async (tx) => {
        let operations = [];
        try {
          const opsResp = await server.operations()
            .forTransaction(tx.hash)
            .order('asc')
            .limit(10)
            .call();

          operations = opsResp.records.map((op) => {
            const assetCode = op.asset_type === 'native'
              ? 'XLM'
              : (op.asset_code || op.selling_asset_code || op.buying_asset_code || null);

            const amount = op.amount
              || op.starting_balance
              || op.send_amount
              || op.dest_amount
              || op.buy_amount
              || op.source_amount
              || null;

            return {
              id: op.id,
              type: op.type,
              amount,
              asset_code: assetCode,
              from: op.from || op.source_account || null,
              to: op.to || op.account || op.destination || null,
            };
          });
        } catch (err) {
          console.warn(`Failed to fetch operations for tx ${tx.hash}:`, err.message);
        }

        return {
          hash: tx.hash,
          ledger: tx.ledger,
          createdAt: tx.created_at,
          created_at: tx.created_at,
          memo: tx.memo || null,
          memo_type: tx.memo_type || null,
          feeCharged: tx.fee_charged,
          operationCount: tx.operation_count,
          operation_count: tx.operation_count,
          successful: tx.successful,
          operations,
          explorerUrl: `https://stellar.expert/explorer/testnet/tx/${tx.hash}`,
        };
      })
    );

    return decorated;
  } catch (err) {
    console.error('Failed to fetch transactions:', err.message);
    return [];
  }
}
