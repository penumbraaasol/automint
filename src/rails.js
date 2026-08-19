import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { formatEther, formatGwei, parseEther, parseGwei } from 'viem';

const STATE_DIR = new URL('../.state/', import.meta.url).pathname;

/** Key a run by slug+chain so the same drop on two chains is tracked separately. */
const stateFile = (slug, chainId) => `${STATE_DIR}${slug}-${chainId}.json`;

export function readState(slug, chainId) {
  const f = stateFile(slug, chainId);
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null;
}

export function writeState(slug, chainId, state) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(stateFile(slug, chainId), JSON.stringify(state, null, 2));
}

/** Total spent across every recorded run -- backs the session spend cap. */
export function totalSpent() {
  if (!existsSync(STATE_DIR)) return 0n;
  return readdirSync(STATE_DIR)
    .filter((f) => f.endsWith('.json'))
    .reduce((sum, f) => {
      try {
        const s = JSON.parse(readFileSync(STATE_DIR + f, 'utf8'));
        return sum + BigInt(s.spentWei ?? 0);
      } catch { return sum; }
    }, 0n);
}

export function parseLimits(opts = {}) {
  return {
    maxGasGwei: opts.maxGasGwei ? parseGwei(String(opts.maxGasGwei)) : null,
    maxPrice: opts.maxPrice ? parseEther(String(opts.maxPrice)) : null,
    maxTotal: opts.maxTotal ? parseEther(String(opts.maxTotal)) : null,
    capWei: opts.cap ? parseEther(String(opts.cap)) : null,
  };
}

/**
 * Every guard that must pass before a transaction is allowed to leave the
 * machine. Returns violations rather than throwing so the caller can print
 * all of them at once -- one failure per run is a slow way to learn.
 */
export function checkRails({
  slug, chainId, expectedChainId, unitPrice, quantity, value,
  gasEstimate, maxFeePerGas, balance, maxPerWallet, limits, state,
}) {
  const v = [];

  if (chainId !== expectedChainId) {
    v.push(`chain mismatch: RPC reports ${chainId}, drop is on ${expectedChainId}`);
  }

  if (state?.status === 'confirmed') {
    v.push(`already minted (tx ${state.txHash}) -- one-shot guard, delete .state/${slug}-${chainId}.json to re-arm`);
  }
  if (state?.status === 'pending') {
    v.push(`a previous attempt is unresolved (tx ${state.txHash}) -- resolve it before re-arming`);
  }

  if (limits.maxPrice !== null && unitPrice > limits.maxPrice) {
    v.push(`mint price ${formatEther(unitPrice)} ETH exceeds --max-price ${formatEther(limits.maxPrice)}`);
  }
  if (limits.maxGasGwei !== null && maxFeePerGas !== null && maxFeePerGas > limits.maxGasGwei) {
    v.push(`gas ${formatGwei(maxFeePerGas)} gwei exceeds --max-gas-gwei ${formatGwei(limits.maxGasGwei)}`);
  }

  const gasCost = gasEstimate !== null && maxFeePerGas !== null ? gasEstimate * maxFeePerGas : 0n;
  const total = value + gasCost;

  if (limits.maxTotal !== null && total > limits.maxTotal) {
    v.push(`total ${formatEther(total)} ETH exceeds --max-total ${formatEther(limits.maxTotal)}`);
  }
  if (balance < total) {
    v.push(`insufficient balance: have ${formatEther(balance)}, need ${formatEther(total)} ETH`);
  }
  if (maxPerWallet != null && quantity > Number(maxPerWallet)) {
    v.push(`quantity ${quantity} exceeds per-wallet cap ${maxPerWallet}`);
  }
  if (limits.capWei !== null) {
    const spent = totalSpent();
    if (spent + total > limits.capWei) {
      v.push(`session cap: ${formatEther(spent)} already spent + ${formatEther(total)} exceeds --cap ${formatEther(limits.capWei)}`);
    }
  }

  return { ok: v.length === 0, violations: v, total, gasCost };
}
