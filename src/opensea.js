const BASE_URL = 'https://api.opensea.io/api/v2';

function apiKey() {
  const key = process.env.OPENSEA_API_KEY;
  if (!key) throw new Error('OPENSEA_API_KEY is not set (expected in .env)');
  return key;
}

async function get(path) {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { 'x-api-key': apiKey(), accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`OpenSea ${res.status} on GET ${path}: ${await res.text()}`);
  }
  return res.json();
}

/** The REST API returns flat snake_case; normalize to the camelCase shape we use. */
function normalizeStage(s) {
  return {
    uuid: s.uuid,
    stageType: s.stage_type,
    label: s.label,
    price: s.price,
    startTime: s.start_time,
    endTime: s.end_time,
    maxPerWallet: s.max_per_wallet,
  };
}

/** Drop metadata: contract, chain, supply, and every mint stage. */
export async function getDrop(slug) {
  const d = await get(`/drops/${slug}`);
  return {
    collectionSlug: d.collection_slug,
    collectionName: d.collection_name,
    chain: d.chain,
    contractAddress: d.contract_address,
    dropType: d.drop_type,
    isMinting: d.is_minting,
    totalSupply: d.total_supply,
    maxSupply: d.max_supply,
    stages: (d.stages ?? []).map(normalizeStage),
    activeStage: d.active_stage ? normalizeStage(d.active_stage) : null,
    nextStage: d.next_stage ? normalizeStage(d.next_stage) : null,
  };
}

/**
 * OpenSea's own mint calldata. Only succeeds while a stage is live, so this is
 * a cross-check for our locally built calldata -- never the hot path.
 */
export async function getMintAction(slug, minter, quantity) {
  const res = await fetch(`${BASE_URL}/drops/${slug}/mint`, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey(),
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ minter, quantity }),
  });
  if (!res.ok) {
    return { ok: false, status: res.status, error: await res.text() };
  }
  return { ok: true, data: await res.json() };
}
