import { createPublicClient, http, formatEther, formatGwei } from 'viem';
import { getDrop, getMintAction } from './opensea.js';
import { resolveChain } from './chains.js';
import { SEADROP_V1, SEADROP_ABI, ERROR_HINTS, readPublicDrop, readFeeRecipients, buildMintCalldata } from './seadrop.js';
import { duration, iso } from './format.js';

/**
 * Phase 2: build the exact transaction and dry-run it against current state.
 * This is the rail that matters most -- eth_call surfaces not-started,
 * sold-out, wrong-price and not-eligible before any gas is spent.
 */
export async function simulate(slug, { minter, quantity = 1, attribute = true } = {}) {
  if (!minter) throw new Error('--minter <address> is required');

  const drop = await getDrop(slug);
  const { chain, rpcEnv } = resolveChain(drop.chain);
  const client = createPublicClient({ chain, transport: http(process.env[rpcEnv] || undefined) });

  const onchain = await readPublicDrop(client, drop.contractAddress);
  const recipients = await readFeeRecipients(client, drop.contractAddress);
  const feeRecipient = recipients[0];
  if (!feeRecipient) throw new Error('No allowed fee recipient on this contract');

  const value = onchain.mintPrice * BigInt(quantity);
  const data = buildMintCalldata({
    nftContract: drop.contractAddress,
    feeRecipient,
    minter,
    quantity,
    attribute,
  });

  console.log(`\n${drop.collectionName} (${slug}) on ${drop.chain}`);
  console.log(`  minter    ${minter}`);
  console.log(`  quantity  ${quantity}  @ ${formatEther(onchain.mintPrice)} ETH = ${formatEther(value)} ETH`);
  console.log(`  to        ${SEADROP_V1}`);
  console.log(`  fee recip ${feeRecipient}`);
  console.log(`  calldata  ${data.slice(0, 42)}... (${(data.length - 2) / 2} bytes)`);

  const now = Date.now();
  const start = Number(onchain.startTime) * 1000;
  const end = Number(onchain.endTime) * 1000;
  if (now < start) console.log(`  window    not open -- opens in ${duration(start - now)} (${iso(start)})`);
  else if (now >= end) console.log(`  window    CLOSED (${iso(end)})`);
  else console.log(`  window    OPEN, closes in ${duration(end - now)}`);

  const balance = await client.getBalance({ address: minter });
  console.log(`  balance   ${formatEther(balance)} ETH`);

  // The dry run itself.
  let sim = { ok: false, reason: null, gas: null };
  try {
    await client.simulateContract({
      address: SEADROP_V1,
      abi: SEADROP_ABI,
      functionName: 'mintPublic',
      args: [drop.contractAddress, feeRecipient, minter, BigInt(quantity)],
      account: minter,
      value,
    });
    sim.ok = true;
    sim.gas = await client.estimateContractGas({
      address: SEADROP_V1,
      abi: SEADROP_ABI,
      functionName: 'mintPublic',
      args: [drop.contractAddress, feeRecipient, minter, BigInt(quantity)],
      account: minter,
      value,
    }).catch(() => null);
  } catch (e) {
    // viem puts the decoded custom error / signature in metaMessages; the
    // shortMessage alone is usually just "reverted with the following signature".
    const name = e.cause?.data?.errorName;
    const args = e.cause?.data?.args;
    sim.error = name ?? null;
    sim.reason = name
      ? `${name}${args?.length ? `(${args.join(', ')})` : ''}${ERROR_HINTS[name] ? ` -- ${ERROR_HINTS[name]}` : ''}`
      : (e.shortMessage ?? e.message).split('\n')[0];
  }

  console.log(`\n  SIMULATION: ${sim.ok ? 'WOULD SUCCEED' : 'WOULD REVERT'}`);
  if (!sim.ok) console.log(`  reason    ${sim.reason}`);

  if (sim.gas) {
    const fees = await client.estimateFeesPerGas().catch(() => null);
    const cost = fees?.maxFeePerGas ? sim.gas * fees.maxFeePerGas : null;
    console.log(`  gas       ${sim.gas}${fees?.maxFeePerGas ? ` @ ${formatGwei(fees.maxFeePerGas)} gwei` : ''}`);
    if (cost !== null) {
      console.log(`  gas cost  ~${formatEther(cost)} ETH`);
      console.log(`  total     ~${formatEther(value + cost)} ETH`);
      if (balance < value + cost) console.log(`  INSUFFICIENT BALANCE (short ${formatEther(value + cost - balance)} ETH)`);
    }
  }

  // Cross-check against OpenSea's own calldata, when the stage is live enough to serve it.
  const action = await getMintAction(slug, minter, quantity);
  if (action.ok) {
    const theirs = action.data;
    const dataMatch = theirs?.data?.toLowerCase() === data.toLowerCase();
    const toMatch = theirs?.to?.toLowerCase() === SEADROP_V1.toLowerCase();
    const valueMatch = BigInt(theirs?.value ?? -1) === value;
    const all = dataMatch && toMatch && valueMatch;
    console.log(`\n  cross-check vs OpenSea: ${all ? 'IDENTICAL' : 'DIVERGENT'}`);
    if (!all) {
      if (!toMatch) console.log(`    to     ours ${SEADROP_V1} / theirs ${theirs?.to}`);
      if (!valueMatch) console.log(`    value  ours ${value} / theirs ${theirs?.value}`);
      if (!dataMatch) {
        console.log(`    ours   ${data}`);
        console.log(`    theirs ${theirs?.data}`);
      }
    }
  } else {
    const why = action.status === 409 ? 'stage not active -- expected before a stage opens'
      : action.status === 400 ? 'request rejected'
      : 'API error';
    console.log(`\n  cross-check vs OpenSea: unavailable (${action.status}) -- ${why}`);
  }

  return sim;
}
