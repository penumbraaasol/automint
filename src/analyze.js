import { createPublicClient, http, formatEther } from 'viem';
import { getDrop } from './opensea.js';
import { resolveChain } from './chains.js';
import { readPublicDrop } from './seadrop.js';
import { getStats, getBestOffer, scoreDrop } from './score.js';
import { classifyStage } from './eligibility.js';
import { targetStage } from './discover.js';
import { duration, iso } from './format.js';

/**
 * Assess a single named drop and say what can and cannot be known about it.
 *
 * This deliberately does NOT return a buy/sell call dressed as certainty. The
 * score ranks *observable* data -- what a collection currently clears at, how
 * liquid it is, whether we can even mint it. Whether a drop will be worth
 * anything later is not in the data, and two scorer bugs found during
 * development both produced confident recommendations for worthless drops.
 *
 * So the verdict names the evidence on each side and is explicit when the
 * honest answer is "unknowable".
 */
export async function analyze(slug, { minter = null, quantity = 1 } = {}) {
  const drop = await getDrop(slug);
  const { chain, rpcEnv } = resolveChain(drop.chain);
  const client = createPublicClient({ chain, transport: http(process.env[rpcEnv] || undefined) });

  // Assess the stage we could actually execute. `targetStage` returns whatever
  // comes next chronologically, which on a multi-stage drop is usually a
  // presale we cannot mint -- judging that would answer the wrong question.
  const publicStage = (drop.stages ?? []).find((s) => s.stageType === 'public_sale');
  const stage = publicStage
    ? { ...publicStage,
        startMs: publicStage.startTime ? Date.parse(publicStage.startTime) : null,
        endMs: publicStage.endTime ? Date.parse(publicStage.endTime) : null,
        get isOpen() {
          return this.startMs != null && Date.now() >= this.startMs
            && (this.endMs == null || Date.now() < this.endMs);
        } }
    : targetStage(drop);
  const cls = classifyStage(stage);
  const otherStages = (drop.stages ?? []).filter((s) => s.stageType !== 'public_sale');
  const stats = await getStats(slug).catch(() => null);
  const offers = await getBestOffer(slug).catch(() => null);

  let onchain = null;
  try { onchain = await readPublicDrop(client, drop.contractAddress); } catch { /* not configured */ }

  const scored = scoreDrop({ drop, stage, stats, offers });
  const total = Number(drop.totalSupply), max = Number(drop.maxSupply);
  const remaining = Number.isFinite(total) && Number.isFinite(max) ? max - total : null;
  const soldOut = remaining != null && remaining <= 0;
  const openEdition = Number.isFinite(max) && max > 1_000_000;

  const forIt = [];
  const against = [];

  // --- price -------------------------------------------------------------
  const priceEth = scored.mintEth;
  if (priceEth === 0) forIt.push('free mint -- the only cost is gas, so the downside is bounded at pennies');
  else if (priceEth != null) {
    if (scored.ratio != null && scored.ratio > 1.5) {
      forIt.push(`clears at ${scored.ratio.toFixed(2)}x the mint price on recent sales`);
    } else if (scored.ratio != null && scored.ratio < 1) {
      against.push(`underwater: recent sales clear BELOW the mint price (${scored.ratio.toFixed(2)}x)`);
    }
  }

  // --- the bid side ------------------------------------------------------
  if (offers?.hasBids && scored.exitRatio != null) {
    if (scored.exitRatio >= 1) {
      forIt.push(
        `you could sell it today: best live bid ${offers.best} ${offers.symbol} `
        + `($${offers.bestUsd?.toFixed(2)}) is ${scored.exitRatio.toFixed(2)}x the mint`
      );
    } else {
      against.push(
        `EXIT UNDERWATER: the best live bid is only ${offers.best} ${offers.symbol} `
        + `($${offers.bestUsd?.toFixed(2)}), ${(1 / scored.exitRatio).toFixed(1)}x less than the mint costs`
      );
    }
    if (offers.depth <= 2) against.push(`thin bid book -- only ${offers.depth} outstanding offer(s)`);
  } else if (offers && !offers.hasBids && priceEth > 0) {
    against.push(
      scored.confidence === 'measured'
        ? 'NO live bids at any price, despite trading history -- there is nothing to sell into'
        : 'no live bids yet'
    );
  }

  // --- demand evidence ---------------------------------------------------
  if (scored.confidence === 'measured') {
    const s7 = stats?.sevenDay?.sales ?? 0;
    if (s7 > 0) forIt.push(`${s7} sales in the last 7 days -- there is an actual market`);
  } else if (scored.confidence === 'untested') {
    against.push('a floor exists but nothing has traded in 30 days -- the price is unsupported by any sale');
  } else {
    against.push('brand new collection: no sales, no floor, nothing to measure');
  }

  // --- supply ------------------------------------------------------------
  if (soldOut) against.push(`SOLD OUT (${total}/${max}) -- cannot mint`);
  else if (openEdition) against.push(`open edition (max ${max.toLocaleString()}) -- supply is effectively unlimited, so scarcity will not support a price`);
  else if (remaining != null) forIt.push(`capped supply, ${remaining} of ${max} left`);

  // --- accessibility -----------------------------------------------------
  if (cls.kind === 'gated') against.push(`${stage?.stageType} stage needs an allowlist proof we may not have`);
  if (stage?.maxPerWallet != null && Number(stage.maxPerWallet) === 1) {
    forIt.push('1 per wallet -- limits bot accumulation and spreads distribution');
  }

  // --- timing ------------------------------------------------------------
  let timing = 'unknown';
  if (stage?.startMs) {
    timing = stage.isOpen
      ? `OPEN, closes in ${duration(stage.endMs - Date.now())}`
      : `opens in ${duration(stage.startMs - Date.now())}`;
  }

  // --- verdict -----------------------------------------------------------
  let verdict, rationale;
  if (soldOut) {
    verdict = 'CANNOT MINT';
    rationale = 'The supply is exhausted. Nothing else matters.';
  } else if (cls.kind === 'gated') {
    verdict = 'BLOCKED';
    rationale = 'This stage is gated. Minting needs a proof only the drop\'s backend holds, and that path is untested here.';
  } else if (priceEth === 0) {
    verdict = 'REASONABLE PUNT';
    rationale = 'A free mint costs only gas, so this is a cheap option rather than an investment. '
      + (scored.confidence === 'unknown'
        ? 'There is no data to judge the collection itself -- you are betting on the drop, not on evidence.'
        : 'The collection has some history to look at.');
  } else if (offers && !offers.hasBids && scored.confidence === 'measured') {
    // Traded before, nobody bidding now. The strongest negative available.
    verdict = 'NO EXIT';
    rationale = 'This collection has traded, yet there is not one live bid at any price. '
      + 'Whatever you pay to mint, there is currently nobody to sell it to.';
  } else if (scored.exitRatio != null && scored.exitRatio < 1) {
    verdict = 'EXIT UNDERWATER';
    rationale = `The best live bid is ${(1 / scored.exitRatio).toFixed(1)}x below the mint price. `
      + 'You would be buying above the only price anyone is actually offering.';
  } else if (scored.confidence !== 'measured') {
    verdict = 'UNKNOWABLE';
    rationale = 'This costs real money and there is no trading data to justify it. '
      + 'Any confident opinion here would be invented.';
  } else if (scored.ratio != null && scored.ratio < 1) {
    verdict = 'POOR VALUE';
    rationale = 'The collection currently trades below what the mint costs. You could buy it cheaper on the secondary market.';
  } else if (scored.score >= 15) {
    verdict = 'DEFENSIBLE';
    rationale = 'The measurable signals are favourable: it clears above mint price and has real trading activity.';
  } else {
    verdict = 'MARGINAL';
    rationale = 'Nothing disqualifying, but the measurable edge is thin.';
  }

  // Earlier gated stages eat supply before the public window opens -- the
  // single biggest reason a public mint is sold out on arrival.
  if (otherStages.length) {
    const cap = otherStages.reduce((n, s) => n + (Number(s.maxPerWallet) || 0), 0);
    against.push(
      `${otherStages.length} earlier gated stage(s) run before the public window ` +
      `and will consume supply first (combined per-wallet caps ${cap})`
    );
  }

  return {
    drop, stage, stats, onchain, scored, cls, otherStages,
    supply: { total, max, remaining, soldOut, openEdition },
    timing, verdict, rationale, forIt, against,
    priceEth,
  };
}

export function renderAnalysis(a) {
  const L = [];
  L.push(`\n${a.drop.collectionName}  (${a.drop.collectionSlug ?? ''})`);
  L.push(`  chain     ${a.drop.chain}`);
  L.push(`  contract  ${a.drop.contractAddress}`);
  L.push(`  price     ${a.priceEth === 0 ? 'FREE (gas only)' : `${a.priceEth} ETH`}`);
  L.push(`  supply    ${a.supply.total} / ${a.supply.openEdition ? 'open edition' : a.supply.max}`);
  L.push(`  stage     ${a.stage?.stageType ?? 'none'} -- ${a.timing}`);
  if (a.stage?.maxPerWallet != null) L.push(`  per wallet ${a.stage.maxPerWallet}`);

  if (a.stats?.sales > 0) {
    L.push(`  history   floor ${a.stats.floor} ${a.stats.floorSymbol} | ${a.stats.sales} sales | ${a.stats.owners} owners`);
  } else {
    L.push(`  history   none -- new collection`);
  }

  L.push(`\n  VERDICT: ${a.verdict}   (score ${a.scored.score}, confidence ${a.scored.confidence})`);
  L.push(`  ${a.rationale}`);

  if (a.forIt.length) {
    L.push('\n  in favour');
    for (const f of a.forIt) L.push(`    + ${f}`);
  }
  if (a.against.length) {
    L.push('\n  against');
    for (const f of a.against) L.push(`    - ${f}`);
  }
  if (a.scored.flags.length) {
    L.push('\n  data warnings');
    for (const f of a.scored.flags) L.push(`    ! ${f}`);
  }

  L.push('\n  This ranks what is measurable today. It does not predict future value.');
  return L.join('\n');
}
