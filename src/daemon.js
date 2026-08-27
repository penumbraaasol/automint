import { formatEther, parseEther } from 'viem';
import { auto } from './auto.js';
import { totalSpent } from './rails.js';
import { iso, duration } from './format.js';
import { reconcilePending } from './reconcile.js';

/**
 * Continuous autonomous mode.
 *
 * `auto` scans once and exits; this re-runs it on an interval so the bot acts
 * on drops that open later without anyone present. It does not prompt.
 *
 * The budget is the only thing that ends a live run early, and it is checked
 * against spend recorded across every previous run -- not just this process --
 * so restarting the daemon does not reset it.
 */
export async function daemon(opts = {}) {
  const {
    interval = 300_000, budget = null, live = false,
    maxCycles = Infinity, ...autoOpts
  } = opts;

  const budgetWei = budget != null ? parseEther(String(budget)) : null;
  const startedAt = Date.now();
  let cycle = 0;
  const minted = [];

  console.log(`\n${'='.repeat(70)}`);
  console.log(`  AUTOMINT DAEMON  ${live ? 'LIVE -- will spend real funds unattended' : 'DRY RUN'}`);
  console.log(`  interval   every ${duration(interval)}`);
  console.log(`  budget     ${budgetWei ? `${formatEther(budgetWei)} ETH lifetime` : 'NONE -- will spend until the wallet is empty'}`);
  console.log(`  started    ${iso(startedAt)}`);
  console.log(`  stop with  ctrl-c`);
  console.log('='.repeat(70));

  let stopping = false;
  const onSig = () => {
    if (stopping) process.exit(1);       // second ctrl-c: hard exit
    stopping = true;
    console.log('\n  stopping after this cycle (ctrl-c again to force)');
  };
  process.on('SIGINT', onSig);
  process.on('SIGTERM', onSig);

  // A previous run may have been suspended between broadcast and receipt,
  // leaving a state file stuck on `pending` that blocks its drop forever.
  console.log('\n  reconciling any unresolved attempts...');
  const rec = await reconcilePending().catch((e) => {
    console.error(`  reconcile failed: ${e.shortMessage ?? e.message}`);
    return { checked: 0, resolved: [] };
  });
  if (!rec.checked) console.log('  none pending');

  while (!stopping && cycle < maxCycles) {
    cycle++;
    const spent = totalSpent();

    console.log(`\n--- cycle ${cycle}  ${iso(Date.now())}  spent ${formatEther(spent)} ETH ---`);

    if (budgetWei != null && spent >= budgetWei) {
      console.log(`  BUDGET EXHAUSTED: ${formatEther(spent)} >= ${formatEther(budgetWei)} -- daemon stopping`);
      break;
    }

    try {
      const res = await auto({ ...autoOpts, budget, live });
      if (res?.minted?.length) {
        minted.push(...res.minted);
        for (const m of res.minted) console.log(`  MINTED ${m.slug} ${m.hash} (${m.status})`);
      }
    } catch (e) {
      // A bad cycle must not kill the daemon -- an RPC blip should not end an
      // overnight run.
      console.error(`  cycle error: ${e.shortMessage ?? e.message}`);
    }

    if (stopping || cycle >= maxCycles) break;
    console.log(`  sleeping ${duration(interval)} until next scan...`);
    await new Promise((r) => setTimeout(r, interval));
  }

  console.log(`\n${'='.repeat(70)}`);
  console.log(`  daemon stopped after ${cycle} cycle(s), ${duration(Date.now() - startedAt)} elapsed`);
  console.log(`  minted ${minted.length}:`);
  for (const m of minted) console.log(`    ${m.slug}  ${m.hash}`);
  console.log(`  total spent ${formatEther(totalSpent())} ETH`);
  console.log('='.repeat(70) + '\n');

  return { minted, cycles: cycle };
}
