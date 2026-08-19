import { createPublicClient, createWalletClient, http, formatEther, formatGwei } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { getDrop } from './opensea.js';
import { resolveChain } from './chains.js';
import { SEADROP_ABI, ERROR_HINTS, readPublicDrop, readFeeRecipients } from './seadrop.js';
import { resolveMintTx } from './eligibility.js';
import { checkRails, parseLimits, readState, writeState, recordSpend } from './rails.js';
import { loadKeystore, decryptKeystore } from './keystore.js';
import { promptPassword, confirm } from './prompt.js';
import { duration, iso } from './format.js';
import { waitForWindow } from './wait.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Phase 3-5: the armed executor.
 *
 * Dry-run is the default and --live is required to broadcast. Every guard runs
 * *after* the window opens and immediately before signing, because price, gas
 * and supply can all move between arming and firing.
 */
export async function arm(slug, opts = {}) {
  const {
    keystore: ksPath, quantity = 1, live = false, at = null,
    lead = 30_000, poll = 250, yes = false, attribute = true,
    heartbeat = null, maxWait = 24 * 3600_000,
  } = opts;

  const drop = await getDrop(slug);
  const { chain, rpcEnv } = resolveChain(drop.chain);
  const transport = http(process.env[rpcEnv] || undefined);
  const client = createPublicClient({ chain, transport });

  const chainId = await client.getChainId();
  console.log(`\n${drop.collectionName} (${slug}) on ${drop.chain} [chainId ${chainId}]`);
  console.log(`  contract  ${drop.contractAddress}`);

  // Unlock before waiting, so a bad key/password fails now, not at the open.
  //
  // MINT_PRIVATE_KEY is a plaintext escape hatch for when a key cannot be moved
  // into the keystore (e.g. the source wallet's passphrase is unrecoverable).
  // It is strictly less safe than the keystore -- the key sits unencrypted on
  // disk -- so it announces itself loudly rather than working silently.
  let account;
  const envKey = process.env.MINT_PRIVATE_KEY ?? process.env.TREASURY_TEST_PRIVATE_KEY;
  if (envKey) {
    const pk = envKey.trim();
    if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) {
      throw new Error('Private key env var is set but is not a 0x-prefixed 32-byte key');
    }
    account = privateKeyToAccount(pk);
    console.log('  WARNING   signing from a plaintext key in .env, not the keystore');
  } else {
    account = privateKeyToAccount(
      decryptKeystore(loadKeystore(ksPath), await promptPassword())
    );
  }
  console.log(`  wallet    ${account.address}`);

  const wallet = createWalletClient({ account, chain, transport });

  let onchain = await readPublicDrop(client, drop.contractAddress);
  const feeRecipient = (await readFeeRecipients(client, drop.contractAddress))[0];
  const startMs = at ? Date.parse(at) : Number(onchain.startTime) * 1000;
  const endMs = Number(onchain.endTime) * 1000;

  console.log(`  price     ${formatEther(onchain.mintPrice)} ETH x ${quantity}`);
  console.log(`  window    ${iso(startMs)} -> ${iso(endMs)}${at ? '  (--at override)' : ''}`);
  console.log(`  mode      ${live ? 'LIVE -- will broadcast' : 'DRY RUN -- will not send'}`);

  // --- wait for the window ---------------------------------------------
  if (Date.now() >= endMs) throw new Error('Mint window has already closed');

  // waitForWindow re-reads the contract as it waits and may retarget, so the
  // stage it returns supersedes what we read before sleeping.
  onchain = await waitForWindow({
    client, nftContract: drop.contractAddress, onchain,
    lead, poll, at, heartbeat, maxWait,
  });
  console.log(`\n  WINDOW OPEN at ${iso(Date.now())}`);

  // --- build, simulate, check ------------------------------------------
  const stage = drop.activeStage ?? drop.stages?.[0] ?? null;
  const tx = await resolveMintTx({
    slug, drop, stage, feeRecipient,
    minter: account.address, quantity,
    unitPrice: onchain.mintPrice, attribute,
  });
  if (tx.error) throw new Error(tx.error);
  console.log(`  calldata  ${tx.source} (${tx.classification.note})`);

  const fees = await client.estimateFeesPerGas().catch(() => null);
  const maxFeePerGas = fees?.maxFeePerGas ?? null;
  const balance = await client.getBalance({ address: account.address });

  // In a dry run, lend the account a balance so the simulation answers
  // "would this mint be accepted?" independently of "is the wallet funded?".
  // Those are different failures and conflating them makes dry runs useless on
  // an unfunded wallet. Live runs simulate against real balance, no override.
  const headroom = tx.value + (maxFeePerGas ?? 0n) * 2_000_000n;
  const stateOverride = !live && balance < headroom
    ? [{ address: account.address, balance: headroom }]
    : undefined;
  if (stateOverride) console.log(`  note      dry run: simulating with a lent balance (wallet holds ${formatEther(balance)} ETH)`);

  let gasEstimate = null, simError = null;
  try {
    await client.call({ account, to: tx.to, data: tx.data, value: tx.value, stateOverride });
    gasEstimate = await client.estimateGas({ account, to: tx.to, data: tx.data, value: tx.value, stateOverride });
  } catch (e) {
    const name = e.cause?.data?.errorName;
    const detail = e.details ?? e.cause?.details ?? '';
    simError = name
      ? `${name}${ERROR_HINTS[name] ? ` -- ${ERROR_HINTS[name]}` : ''}`
      : [(e.shortMessage ?? e.message).split('\n')[0], detail].filter(Boolean).join(' | ');
  }

  if (simError) {
    console.log(`\n  SIMULATION FAILED: ${simError}`);
    console.log('  aborting -- no transaction sent');
    return { sent: false, reason: simError };
  }
  console.log(`  simulated OK (gas ${gasEstimate})`);

  const rails = checkRails({
    slug, chainId, expectedChainId: chain.id,
    unitPrice: onchain.mintPrice, quantity, value: tx.value,
    gasEstimate, maxFeePerGas, balance,
    maxPerWallet: onchain.maxTotalMintableByWallet,
    limits: parseLimits(opts), state: readState(slug, chainId),
  });

  console.log(`\n  cost      ${formatEther(tx.value)} + ~${formatEther(rails.gasCost)} gas = ~${formatEther(rails.total)} ETH`);
  if (maxFeePerGas) console.log(`  gas price ${formatGwei(maxFeePerGas)} gwei`);
  console.log(`  balance   ${formatEther(balance)} ETH`);

  if (!rails.ok) {
    console.log(`\n  RAILS BLOCKED (${rails.violations.length}):`);
    for (const v of rails.violations) console.log(`    - ${v}`);
    console.log('  aborting -- no transaction sent');
    return { sent: false, reason: 'rails', violations: rails.violations };
  }
  console.log('  rails     all passed');

  if (!live) {
    console.log('\n  DRY RUN -- would have sent this transaction. Re-run with --live to broadcast.');
    return { sent: false, reason: 'dry-run' };
  }

  if (!yes && !(await confirm(`\n  Send ${formatEther(rails.total)} ETH on ${drop.chain}? [y/N]`))) {
    console.log('  cancelled');
    return { sent: false, reason: 'cancelled' };
  }

  // --- fire -------------------------------------------------------------
  const hash = await wallet.sendTransaction({ to: tx.to, data: tx.data, value: tx.value });
  writeState(slug, chainId, {
    status: 'pending', txHash: hash, slug, chainId,
    minter: account.address, quantity, spentWei: rails.total.toString(),
    armedAt: new Date().toISOString(),
  });
  recordSpend({ slug, chainId, txHash: hash, spentWei: rails.total.toString(), quantity });
  console.log(`\n  SENT  ${hash}`);
  console.log(`  ${explorerTx(drop.chain, hash)}`);

  const receipt = await client.waitForTransactionReceipt({ hash });
  writeState(slug, chainId, {
    status: receipt.status === 'success' ? 'confirmed' : 'failed',
    txHash: hash, slug, chainId, minter: account.address, quantity,
    spentWei: (tx.value + receipt.gasUsed * (receipt.effectiveGasPrice ?? 0n)).toString(),
    block: Number(receipt.blockNumber), confirmedAt: new Date().toISOString(),
  });
  console.log(`  ${receipt.status === 'success' ? 'CONFIRMED' : 'REVERTED'} in block ${receipt.blockNumber} (gas used ${receipt.gasUsed})`);
  return { sent: true, hash, status: receipt.status };
}

export function explorerTx(chain, hash) {
  const base = { base: 'https://basescan.org', ethereum: 'https://etherscan.io' }[chain];
  return base ? `${base}/tx/${hash}` : hash;
}
