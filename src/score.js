import { formatEther } from 'viem';

const BASE_URL = 'https://api.opensea.io/api/v2';

/**
 * Collection stats. A brand-new collection returns zeros -- that is meaningful
 * (no history to judge) and must not be confused with "bad".
 */
export async function getStats(slug) {
  const res = await fetch(`${BASE_URL}/collections/${slug}/stats`, {
    headers: { 'x-api-key': process.env.OPENSEA_API_KEY, accept: 'application/json' },
  });
  if (!res.ok) return null;
  const j = await res.json();
  const iv = Object.fromEntries((j.intervals ?? []).map((i) => [i.interval, i]));
  return {
    volume: j.total?.volume ?? 0,
    sales: j.total?.sales ?? 0,
    owners: j.total?.num_owners ?? 0,
    floor: j.total?.floor_price ?? 0,
    floorSymbol: j.total?.floor_price_symbol ?? 'ETH',
    oneDay: iv.one_day ?? null,
    sevenDay: iv.seven_day ?? null,
    thirtyDay: iv.thirty_day ?? null,
  };
}

/**
 * Score a drop on observable signals only.
 *
 * IMPORTANT: this ranks what can be measured today. It does not predict whether
 * a drop will be worth anything. The economic input is the price at which the
 * collection actually CLEARS (volume/sales), not its advertised floor -- an
 * unsold listing is not a market. Collections with no history score `unknown`;
 * collections whose floor is unsupported by any recent sale score `untested`.
 * Neither should be auto-minted.
 *
 * Every component is returned so a ranking can be audited rather than trusted.
 */
export function scoreDrop({ drop, stage, stats }) {
  const components = [];
  const flags = [];
  const mintWei = stage?.price != null ? BigInt(stage.price) : null;
  const mintEth = mintWei != null ? Number(formatEther(mintWei)) : null;

  const hasHistory = stats != null && stats.sales > 0;

  // --- 1. Economics: realized price vs mint. --------------------------------
  //
  // The advertised floor is a LISTING, not a trade. On thin collections one
  // optimistic listing produces an absurd floor (observed: floor 1 ETH on a
  // collection whose 13 recent sales averaged 0.0015 ETH -- a 650x fiction).
  // So we prefer the realized clearing price (7d volume / 7d sales) and only
  // trust the floor when the two roughly agree.
  let ratio = null;

  // Realized clearing price, preferring recent data but falling back to 30d.
  const iv7 = stats?.sevenDay, iv30 = stats?.thirtyDay;
  const realized7 = iv7?.sales > 0 ? iv7.volume / iv7.sales : null;
  const realized30 = iv30?.sales > 0 ? iv30.volume / iv30.sales : null;
  const realized = realized7 ?? realized30;
  const realizedWindow = realized7 != null ? '7d' : realized30 != null ? '30d' : null;

  if (hasHistory && mintEth != null && mintEth > 0) {
    if (realized == null) {
      // Nothing has traded in 30 days. A floor without trades is a listing
      // nobody accepted, so there is no price signal here at all -- not a
      // discounted one. Scoring it highly is how a bot talks itself into
      // buying something with no demand.
      components.push({ name: 'economics', detail: `floor ${stats.floor} but no sales in 30d -- no price signal`, points: 0 });
      flags.push('NO TRADES IN 30 DAYS -- the advertised floor is unsupported by any sale');
    } else {
      let basis = realized;
      let basisName = `realized ${realizedWindow}`;

      // Trust the floor only when it roughly agrees with what actually cleared.
      if (stats.floor > 0 && stats.floor <= realized * 3) {
        basis = stats.floor;
        basisName = 'floor';
      } else if (stats.floor > realized * 3) {
        flags.push(
          `floor ${stats.floor} is ${(stats.floor / realized).toFixed(0)}x the realized ` +
          `${realized.toFixed(5)} -- using realized; the floor is an unsold listing`
        );
      }

      ratio = basis / mintEth;
      const pts = Math.max(-30, Math.min(40, Math.log2(ratio) * 12));
      components.push({
        name: `${basisName}/mint`,
        detail: `${ratio.toFixed(2)}x (${basis.toFixed(5)} / mint ${mintEth})`,
        points: pts,
      });
      if (ratio < 1) flags.push(`underwater: ${basisName} is below mint price (${ratio.toFixed(2)}x)`);
    }
  } else if (mintEth === 0) {
    components.push({ name: 'free mint', detail: 'costs only gas', points: 15 });
  } else {
    components.push({ name: 'economics', detail: 'no history -- unmeasurable', points: 0 });
  }

  // --- 2. Liquidity: is anyone actually trading it -------------------------
  if (hasHistory) {
    const v7 = stats.sevenDay?.volume ?? 0;
    const s7 = stats.sevenDay?.sales ?? 0;
    const pts = Math.min(20, Math.log10(1 + v7) * 10);
    components.push({ name: 'liquidity', detail: `${v7.toFixed(2)} ETH / ${s7} sales (7d)`, points: pts });
    if (s7 === 0) flags.push('zero sales in 7d -- illiquid, hard to exit');
  } else {
    components.push({ name: 'liquidity', detail: 'no trading history', points: 0 });
  }

  // --- 3. Distribution: concentrated or spread ----------------------------
  if (hasHistory && stats.owners > 0) {
    const perOwner = stats.sales / stats.owners;
    const pts = Math.min(10, stats.owners / 100);
    components.push({ name: 'holders', detail: `${stats.owners} owners, ${perOwner.toFixed(1)} sales/owner`, points: pts });
  }

  // --- 4. Accessibility: can we even mint it ------------------------------
  if (stage?.stageType === 'public_sale') {
    components.push({ name: 'public stage', detail: 'no allowlist needed', points: 10 });
  } else if (stage) {
    components.push({ name: 'gated stage', detail: `${stage.stageType} -- needs a proof we may not have`, points: -25 });
    flags.push('gated stage: requires an allowlist proof or signature');
  }

  const perWallet = stage?.maxPerWallet != null ? Number(stage.maxPerWallet) : null;
  if (perWallet != null && perWallet > 500) {
    components.push({ name: 'supply cap', detail: `maxPerWallet ${perWallet} -- effectively uncapped`, points: -5 });
    flags.push('very high per-wallet cap suggests unlimited supply');
  }

  const total = components.reduce((s, c) => s + c.points, 0);

  return {
    score: Math.round(total * 10) / 10,
    confidence: !hasHistory ? 'unknown' : realized == null ? 'untested' : 'measured',
    components,
    flags,
    ratio,
    mintEth,
  };
}

/**
 * Remaining supply, from the per-drop endpoint.
 *
 * OpenSea's feed keeps listing a drop as MINTING after it sells out, and the
 * only symptom otherwise is a MintQuantityExceedsMaxSupply revert at simulation
 * time -- which an unattended daemon would rediscover every cycle forever.
 */
async function getSupply(slug) {
  try {
    const { getDrop } = await import('./opensea.js');
    const d = await getDrop(slug);
    const total = Number(d.totalSupply), max = Number(d.maxSupply);
    if (!Number.isFinite(total) || !Number.isFinite(max)) return null;
    return { total, max, remaining: max - total, soldOut: max - total <= 0 };
  } catch { return null; }
}

/** Enrich and score a list of drops, in parallel but politely. */
export async function scoreAll(drops, { concurrency = 5 } = {}) {
  const out = [];
  for (let i = 0; i < drops.length; i += concurrency) {
    const batch = drops.slice(i, i + concurrency);
    const scored = await Promise.all(batch.map(async ({ drop, stage }) => {
      const [stats, supply] = await Promise.all([
        getStats(drop.slug).catch(() => null),
        getSupply(drop.slug),
      ]);
      return { drop, stage, stats, supply, ...scoreDrop({ drop, stage, stats }) };
    }));
    out.push(...scored);
  }
  return out.sort((a, b) => b.score - a.score);
}
