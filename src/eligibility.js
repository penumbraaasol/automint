import { getMintAction } from './opensea.js';
import { buildMintCalldata, SEADROP_V1 } from './seadrop.js';

export const PUBLIC_STAGE = 'public_sale';

/**
 * Which stage would we actually be minting into, and can we build its calldata?
 *
 * Public stages are fully derivable offline, so they can be prebuilt before the
 * window opens. Gated stages (allowlist merkle proofs, signed presale
 * signatures) carry data that only the drop's own backend holds -- there is no
 * onchain source and no standard for deriving it -- so those must come from
 * OpenSea at fire time, and pay one API round-trip for the privilege.
 */
export function classifyStage(stage) {
  if (!stage) return { kind: 'none', prebuildable: false, note: 'no active stage' };
  if (stage.stageType === PUBLIC_STAGE) {
    return { kind: 'public', prebuildable: true, note: 'calldata built locally, prefetchable' };
  }
  return {
    kind: 'gated',
    prebuildable: false,
    note: `${stage.stageType} requires proof/signature from OpenSea at fire time`,
  };
}

/**
 * Resolve the transaction to send. Falls back to OpenSea's endpoint whenever we
 * cannot derive calldata ourselves.
 */
export async function resolveMintTx({ slug, drop, stage, feeRecipient, minter, quantity, unitPrice, attribute = true }) {
  const cls = classifyStage(stage);

  if (cls.prebuildable) {
    return {
      source: 'local',
      to: SEADROP_V1,
      data: buildMintCalldata({
        nftContract: drop.contractAddress, feeRecipient, minter, quantity, attribute,
      }),
      value: unitPrice * BigInt(quantity),
      classification: cls,
    };
  }

  const action = await getMintAction(slug, minter, quantity);
  if (!action.ok) {
    return { source: 'opensea', error: `OpenSea ${action.status}: ${action.error}`, classification: cls };
  }
  return {
    source: 'opensea',
    to: action.data.to,
    data: action.data.data,
    value: BigInt(action.data.value),
    classification: cls,
  };
}

/** Human-readable eligibility report -- used by `mint check`. */
export async function checkEligibility({ slug, drop, stage, minter, quantity }) {
  const cls = classifyStage(stage);
  const lines = [`stage     ${stage?.stageType ?? 'none'} -- ${cls.note}`];

  if (cls.kind === 'gated') {
    const action = await getMintAction(slug, minter, quantity);
    lines.push(
      action.ok
        ? `eligible  YES -- OpenSea served calldata for this wallet`
        : `eligible  NO  -- ${action.status === 409 ? 'stage not active' : 'OpenSea declined'}: ${String(action.error).slice(0, 160)}`
    );
  }
  return { classification: cls, lines };
}
