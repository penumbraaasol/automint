import { readdirSync, existsSync } from 'node:fs';
import { createPublicClient, http } from 'viem';
import { readState, writeState } from './rails.js';
import { CHAINS } from './chains.js';

const STATE_DIR = new URL('../.state/', import.meta.url).pathname;

/**
 * Resolve state files stuck in `pending`.
 *
 * A mint writes `pending` on broadcast and `confirmed` on receipt. If the
 * process dies in between -- the machine sleeps, launchd restarts it, someone
 * closes the lid -- the file stays `pending` forever and the one-shot rail
 * blocks that drop permanently, even though the mint actually succeeded.
 *
 * Observed in the wild: a drop minted successfully (token received, tx in
 * block) sat `pending` for hours and refused every later attempt.
 *
 * This asks the chain what really happened and rewrites the file accordingly.
 */
export async function reconcilePending({ log = console.log } = {}) {
  if (!existsSync(STATE_DIR)) return { checked: 0, resolved: [] };

  const files = readdirSync(STATE_DIR).filter((f) => f.endsWith('.json'));
  const resolved = [];
  let checked = 0;

  for (const f of files) {
    const m = f.match(/^(.+)-(\d+)\.json$/);
    if (!m) continue;
    const [, slug, chainIdStr] = m;
    const chainId = Number(chainIdStr);
    const state = readState(slug, chainId);
    if (state?.status !== 'pending' || !state.txHash) continue;

    checked++;
    const entry = Object.values(CHAINS).find((c) => c.chain.id === chainId);
    if (!entry) { log(`  ${slug}: unknown chainId ${chainId}, leaving pending`); continue; }

    const client = createPublicClient({
      chain: entry.chain,
      transport: http(process.env[entry.rpcEnv] || undefined),
    });

    try {
      const r = await client.getTransactionReceipt({ hash: state.txHash });
      const status = r.status === 'success' ? 'confirmed' : 'failed';
      writeState(slug, chainId, {
        ...state, status,
        block: Number(r.blockNumber),
        confirmedAt: new Date().toISOString(),
        reconciled: true,
      });
      resolved.push({ slug, status, block: Number(r.blockNumber) });
      log(`  ${slug}: pending -> ${status} (block ${r.blockNumber})`);
    } catch {
      // No receipt: either still in the mempool or dropped. Distinguish, because
      // "still pending" should keep blocking while "dropped" should not.
      const tx = await client.getTransaction({ hash: state.txHash }).catch(() => null);
      if (tx) {
        log(`  ${slug}: still genuinely pending in mempool -- leaving blocked`);
      } else {
        writeState(slug, chainId, { ...state, status: 'dropped', reconciled: true });
        resolved.push({ slug, status: 'dropped' });
        log(`  ${slug}: tx vanished from mempool -> dropped, drop is re-armable`);
      }
    }
  }

  return { checked, resolved };
}
