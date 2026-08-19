import { formatEther, parseEther } from 'viem';
import { discoverAll, assessActionability } from './discover.js';
import { scoreAll } from './score.js';
import { renderDetail } from './report.js';
import { arm } from './execute.js';
import { totalSpent, readState } from './rails.js';
import * as watchlist from './watchlist.js';
import { resolveChain, CHAINS } from './chains.js';

/**
 * Autonomous mode: discover, score, rank, then mint the survivors.
 *
 * This is the only place the bot spends money on something a human did not
 * name, so the gates are deliberately strict and stack on top of the per-mint
 * rails rather than replacing them:
 *
 *   - dry run unless --live
 *   - a minimum score, defaulting high
 *   - `unknown` (no history) and `untested` (no recent trades) are refused
 *     outright: a score computed from no data is not a low score, it is no
 *     score, and auto-minting it is gambling
 *   - a hard budget across the whole run, checked before each mint
 *   - at most --max-mints targets
 *
 * A drop that passes every gate here still has to pass simulation and all the
 * usual rails inside arm().
 */
export async function auto(opts = {}) {
  const {
    minScore = 20, maxMints = 1, budget = null, chain = null,
    maxPrice = null, live = false, quantity = 1, useWatchlist = false,
  } = opts;

  const budgetWei = budget != null ? parseEther(String(budget)) : null;
  const maxPriceWei = maxPrice != null ? parseEther(String(maxPrice)) : null;

  console.log(`\n  AUTO MODE  ${live ? 'LIVE -- will spend real funds' : 'DRY RUN'}`);
  console.log(`  gates      score >= ${minScore}, max ${maxMints} mint(s)` +
    `${budgetWei ? `, budget ${formatEther(budgetWei)} ETH` : ', NO BUDGET CAP'}`);

  // --- discover ----------------------------------------------------------
  const { drops, errors } = await discoverAll();
  for (const e of errors) console.error(`  feed error: ${e}`);

  let candidates = drops
    .map((d) => ({ drop: d, ...assessActionability(d, { chains: chain ? [chain] : undefined, maxPriceWei }) }))
    .filter((a) => a.actionable)
    .map(({ drop, stage }) => ({ drop, stage }));

  if (useWatchlist) {
    const wl = new Set(watchlist.load().entries.map((e) => e.slug));
    candidates = candidates.filter((c) => wl.has(c.drop.slug));
    console.log(`  source     watchlist (${wl.size} entries)`);
  }

  console.log(`  discovered ${drops.length} drops, ${candidates.length} actionable`);
  if (!candidates.length) { console.log('  nothing to do\n'); return { minted: [] }; }

  // --- score -------------------------------------------------------------
  const scored = await scoreAll(candidates);

  // --- gate --------------------------------------------------------------
  const rejected = [];
  const passed = [];
  for (const r of scored) {
    if (r.confidence !== 'measured') { rejected.push([r, `confidence '${r.confidence}' -- refuse to buy on no data`]); continue; }
    if (r.score < minScore) { rejected.push([r, `score ${r.score} < ${minScore}`]); continue; }
    // State files are keyed by chainId, so resolve it rather than guessing.
    const chainId = CHAINS[r.drop.chain]?.chain.id ?? null;
    const prior = chainId != null ? readState(r.drop.slug, chainId) : null;
    if (prior?.status === 'confirmed') { rejected.push([r, `already minted (${prior.txHash.slice(0, 12)}...)`]); continue; }
    if (prior?.status === 'pending') { rejected.push([r, 'previous attempt unresolved']); continue; }
    passed.push(r);
  }

  console.log(`\n  passed gates: ${passed.length} of ${scored.length}`);
  for (const [r, why] of rejected.slice(0, 8)) {
    console.log(`    - ${r.drop.slug.padEnd(30)} ${why}`);
  }
  if (!passed.length) { console.log('\n  no drop cleared the gates -- nothing minted\n'); return { minted: [] }; }

  // --- execute -----------------------------------------------------------
  const targets = passed.slice(0, maxMints);
  const minted = [];

  for (const r of targets) {
    console.log(`\n${'='.repeat(70)}`);
    renderDetail(r);

    if (budgetWei != null) {
      const spent = totalSpent();
      const cost = r.mintEth != null ? parseEther(String(r.mintEth)) * BigInt(quantity) : 0n;
      if (spent + cost > budgetWei) {
        console.log(`\n  BUDGET STOP: ${formatEther(spent)} spent + ${formatEther(cost)} exceeds ${formatEther(budgetWei)}`);
        break;
      }
    }

    console.log(`\n  --> arming ${r.drop.slug}`);
    try {
      const res = await arm(r.drop.slug, {
        ...opts, quantity, live,
        maxPrice: maxPrice ?? undefined,
        yes: true,   // auto mode already confirmed via its own gates
      });
      if (res?.sent) minted.push({ slug: r.drop.slug, hash: res.hash, status: res.status });
    } catch (e) {
      console.log(`  arm failed: ${e.shortMessage ?? e.message}`);
    }
  }

  console.log(`\n  auto run complete -- ${minted.length} minted\n`);
  return { minted };
}
