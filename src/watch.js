import { createPublicClient, http, formatEther } from 'viem';
import { getDrop } from './opensea.js';
import { resolveChain } from './chains.js';
import { readPublicDrop } from './seadrop.js';
import { duration, iso } from './format.js';

/**
 * Phase 1: read-only. Reconciles OpenSea's stage data against the contract's
 * own view, because the chain is the thing we actually trigger on.
 */
export async function watch(slug, { follow = false, interval = 15000 } = {}) {
  const drop = await getDrop(slug);
  const { chain, rpcEnv } = resolveChain(drop.chain);
  const client = createPublicClient({
    chain,
    transport: http(process.env[rpcEnv] || undefined),
  });

  console.log(`\n${drop.collectionName}  (${slug})`);
  console.log(`  contract  ${drop.contractAddress}`);
  console.log(`  chain     ${drop.chain}${process.env[rpcEnv] ? ' (custom RPC)' : ''}`);
  console.log(`  type      ${drop.dropType}`);
  console.log(`  supply    ${drop.totalSupply ?? '?'} / ${drop.maxSupply ?? '?'}`);

  console.log('\n  stages');
  for (const s of drop.stages ?? []) {
    const live = s.uuid === drop.activeStage?.uuid;
    console.log(
      `   ${live ? '>' : ' '} ${s.stageType.padEnd(14)} ` +
      `${formatEther(BigInt(s.price)).padStart(8)} ETH  ` +
      `max ${String(s.maxPerWallet).padStart(4)}  ${iso(s.startTime)} -> ${iso(s.endTime)}`
    );
  }

  const render = async () => {
    let onchain = null;
    try {
      onchain = await readPublicDrop(client, drop.contractAddress);
    } catch (e) {
      console.log(`\n  onchain   unreadable: ${e.shortMessage ?? e.message}`);
      return;
    }

    const now = Date.now();
    const start = Number(onchain.startTime) * 1000;
    const end = Number(onchain.endTime) * 1000;
    const open = now >= start && now < end;

    console.log(`\n  onchain public stage (authoritative)`);
    console.log(`    price       ${formatEther(onchain.mintPrice)} ETH`);
    console.log(`    window      ${iso(start)} -> ${iso(end)}`);
    console.log(`    maxPerWallet ${onchain.maxTotalMintableByWallet}`);
    console.log(
      `    status      ${open ? `OPEN (closes in ${duration(end - now)})`
        : now < start ? `opens in ${duration(start - now)}`
        : 'CLOSED'}`
    );

    // Divergence here means OpenSea's cache is stale -- always trust the chain.
    const apiStage = drop.activeStage;
    if (apiStage && BigInt(apiStage.price) !== onchain.mintPrice) {
      console.log(`    WARNING: OpenSea price ${formatEther(BigInt(apiStage.price))} != onchain ${formatEther(onchain.mintPrice)}`);
    }
  };

  await render();
  if (!follow) return;

  console.log(`\n  polling every ${interval / 1000}s -- ctrl-c to stop`);
  for (;;) {
    await new Promise((r) => setTimeout(r, interval));
    await render();
  }
}
