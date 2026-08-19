import { getDrop } from './opensea.js';
import { CHAINS } from './chains.js';

const BASE_URL = 'https://api.opensea.io/api/v2';

/**
 * OpenSea exposes exactly three drop feeds. There is no search, no pagination
 * beyond these, and no way to enumerate every SeaDrop collection -- so this is
 * the complete discoverable universe, typically 50-60 drops. Anything not in
 * these feeds cannot be found automatically and must be named by hand.
 */
export const FEEDS = ['featured', 'upcoming', 'recently_minted'];

async function fetchFeed(type, limit = 100) {
  const res = await fetch(`${BASE_URL}/drops?type=${type}&limit=${limit}`, {
    headers: { 'x-api-key': process.env.OPENSEA_API_KEY, accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`OpenSea ${res.status} on /drops?type=${type}`);
  const json = await res.json();
  return (json.drops ?? json.items ?? []).map((d) => normalize(d, type));
}

function normStage(s) {
  if (!s) return null;
  return {
    uuid: s.uuid,
    stageType: s.stage_type ?? s.stageType,
    label: s.label,
    price: s.price,
    startTime: s.start_time ?? s.startTime,
    endTime: s.end_time ?? s.endTime,
    maxPerWallet: s.max_per_wallet ?? s.maxPerWallet,
  };
}

function normalize(d, feed) {
  return {
    slug: d.collection_slug ?? d.collectionSlug,
    name: d.collection_name ?? d.collectionName,
    chain: d.chain,
    contractAddress: d.contract_address ?? d.contractAddress,
    dropType: d.drop_type ?? d.dropType,
    isMinting: d.is_minting ?? d.isMinting,
    mintStatus: d.mint_status ?? d.mintStatus,
    activeStage: normStage(d.active_stage ?? d.activeStage),
    nextStage: normStage(d.next_stage ?? d.nextStage),
    feeds: [feed],
  };
}

/** Pull every feed and merge. A drop can appear in more than one. */
export async function discoverAll() {
  const results = await Promise.allSettled(FEEDS.map((f) => fetchFeed(f)));
  const bySlug = new Map();
  const errors = [];

  results.forEach((r, i) => {
    if (r.status === 'rejected') { errors.push(`${FEEDS[i]}: ${r.reason.message}`); return; }
    for (const d of r.value) {
      if (!d.slug) continue;
      const prev = bySlug.get(d.slug);
      if (prev) prev.feeds.push(FEEDS[i]);
      else bySlug.set(d.slug, d);
    }
  });

  return { drops: [...bySlug.values()], errors };
}

/**
 * The stage we would actually be minting into, and when.
 * A drop with neither an active nor a scheduled stage is not actionable.
 */
export function targetStage(drop) {
  const s = drop.activeStage ?? drop.nextStage;
  if (!s) return null;
  const start = s.startTime ? Date.parse(s.startTime) : null;
  const end = s.endTime ? Date.parse(s.endTime) : null;
  return { ...s, startMs: start, endMs: end, isOpen: start != null && Date.now() >= start && (end == null || Date.now() < end) };
}

/**
 * Filter to drops this bot could actually execute.
 * Everything rejected here carries a reason, so `discover` can explain itself
 * rather than silently returning a short list.
 */
export function assessActionability(drop, { chains = Object.keys(CHAINS), maxPriceWei = null } = {}) {
  const reasons = [];
  const stage = targetStage(drop);

  if (!CHAINS[drop.chain]) reasons.push(`chain ${drop.chain} unsupported`);
  else if (!chains.includes(drop.chain)) reasons.push(`chain ${drop.chain} excluded`);

  if (!stage) reasons.push('no active or scheduled stage');
  else {
    if (stage.stageType !== 'public_sale') reasons.push(`${stage.stageType} needs an allowlist proof`);
    if (stage.endMs != null && Date.now() >= stage.endMs) reasons.push('window closed');
    if (maxPriceWei != null && stage.price != null && BigInt(stage.price) > maxPriceWei) {
      reasons.push('above max price');
    }
  }

  return { actionable: reasons.length === 0, reasons, stage };
}
