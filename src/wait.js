import { formatEther } from 'viem';
import { readPublicDrop } from './seadrop.js';
import { duration, iso } from './format.js';

/**
 * How often to report while waiting. Logging every minute through a 6-hour
 * wait produces 360 lines of noise; this tightens as the open approaches so
 * the output stays readable but never goes quiet for long.
 */
export function heartbeatInterval(remaining) {
  if (remaining > 2 * 3600_000) return 30 * 60_000;
  if (remaining > 30 * 60_000) return 5 * 60_000;
  if (remaining > 5 * 60_000) return 60_000;
  if (remaining > 60_000) return 15_000;
  return 5_000;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Wait for the mint window, re-reading the contract as we go.
 *
 * Sleeping blindly until a start time captured at arm-time is a real failure
 * mode: creators move stages. If the window shifts earlier we would miss it
 * entirely; later, we would wake into a NotActive revert. So every heartbeat
 * re-reads the authoritative onchain stage and retargets.
 *
 * Returns the latest onchain stage, which the caller should use in place of
 * whatever it read before waiting.
 */
export async function waitForWindow({
  client, nftContract, onchain, lead = 30_000, poll = 250,
  at = null, heartbeat = null, log = console.log,
  maxWait = 24 * 3600_000, maxRetargets = 20,
}) {
  // Two bounds, because a stage whose start keeps sliding forward would
  // otherwise loop forever with no output the operator could act on.
  const deadline = Date.now() + maxWait;
  let retargets = 0;
  const DRIFT_EPSILON = 5_000;   // ignore sub-5s jitter in reported times
  let current = onchain;
  let target = at ? Date.parse(at) : Number(current.startTime) * 1000;
  let endMs = Number(current.endTime) * 1000;

  if (Date.now() >= target) return current;   // already open

  log(`  waiting for ${iso(target)}${at ? '  (--at override)' : ''}`);

  while (Date.now() < target - lead) {
    const remaining = target - Date.now();
    const tick = Math.min(
      heartbeat ?? heartbeatInterval(remaining),
      Math.max(remaining - lead, 1000)
    );
    await sleep(tick);

    // Re-read the chain; --at means the operator picked the moment, so we
    // report drift but do not retarget away from their choice.
    let fresh;
    try {
      fresh = await readPublicDrop(client, nftContract);
    } catch (e) {
      log(`  [${iso(Date.now())}] heartbeat: RPC read failed (${e.shortMessage ?? e.message}) -- still waiting`);
      continue;
    }

    const newStart = Number(fresh.startTime) * 1000;
    const newEnd = Number(fresh.endTime) * 1000;

    if (Date.now() > deadline) {
      throw new Error(`Gave up after waiting ${duration(maxWait)} -- stage never opened`);
    }

    if (fresh.mintPrice !== current.mintPrice) {
      log(`  [${iso(Date.now())}] PRICE CHANGED ${formatEther(current.mintPrice)} -> ${formatEther(fresh.mintPrice)} ETH`);
    }
    if (!at && Math.abs(newStart - target) >= DRIFT_EPSILON) {
      log(`  [${iso(Date.now())}] START MOVED ${iso(target)} -> ${iso(newStart)}`);
      target = newStart;
      if (++retargets > maxRetargets) {
        throw new Error(`Start time moved ${retargets} times -- refusing to chase it further`);
      }
    }
    if (Math.abs(newEnd - endMs) >= DRIFT_EPSILON) {
      log(`  [${iso(Date.now())}] END MOVED ${iso(endMs)} -> ${iso(newEnd)}`);
      endMs = newEnd;
    }
    current = fresh;

    if (Date.now() >= endMs) throw new Error('Mint window closed while waiting');
    if (Date.now() >= target) return current;   // moved earlier, past us already

    log(`  [${iso(Date.now())}] heartbeat: ${duration(target - Date.now())} to open  (price ${formatEther(current.mintPrice)} ETH)`);
  }

  log(`  polling every ${poll}ms for open...`);
  while (Date.now() < target) await sleep(poll);
  return current;
}
