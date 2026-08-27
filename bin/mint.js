#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';
import { toHex } from 'viem';
import { watch } from '../src/watch.js';
import { simulate } from '../src/simulate.js';
import { arm } from '../src/execute.js';
import { encryptKeystore, decryptKeystore, saveKeystore, loadKeystore } from '../src/keystore.js';
import { promptPassword } from '../src/prompt.js';
import { getDrop } from '../src/opensea.js';
import { checkEligibility } from '../src/eligibility.js';
import { readState } from '../src/rails.js';
import { discoverAll, assessActionability, targetStage } from '../src/discover.js';
import { scoreAll } from '../src/score.js';
import { renderScanTable, renderDetail } from '../src/report.js';
import * as watchlist from '../src/watchlist.js';
import { auto } from '../src/auto.js';
import { daemon } from '../src/daemon.js';
import { reconcilePending } from '../src/reconcile.js';
import { analyze, renderAnalysis } from '../src/analyze.js';
import { parseEther } from 'viem';

try { process.loadEnvFile(new URL('../.env', import.meta.url)); } catch {}

const argv = process.argv.slice(2);
const cmd = argv[0];
const positional = [];
const flags = {};
for (let i = 1; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) {
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) { flags[key] = next; i++; }
    else flags[key] = true;
  } else positional.push(a);
}

/**
 * Accept a full OpenSea URL wherever a slug is expected.
 *
 *   https://opensea.io/collection/foo/overview  ->  foo
 *   https://opensea.io/collection/0xabc.../drop ->  0xabc...
 *
 * People paste links, not slugs.
 */
function normalizeSlug(input) {
  if (!input) return input;
  const m = String(input).match(/opensea\.io\/collection\/([^/?#]+)/i);
  if (m) return decodeURIComponent(m[1]);
  // Also tolerate an item URL: /assets/<chain>/<contract>/<id>
  const a = String(input).match(/opensea\.io\/assets\/[^/]+\/([^/?#]+)/i);
  if (a) return a[1];
  return input;
}

const DEFAULT_KEYSTORE = new URL('../.keystore/mint.json', import.meta.url).pathname;
const ks = () => flags.keystore || DEFAULT_KEYSTORE;

const USAGE = `
opensea-mint-bot -- SeaDrop mint watcher / simulator / executor

  mint watch <slug> [--follow] [--interval <sec>]
      Show drop stages; reconcile OpenSea's data against the contract.

  mint simulate <slug> --minter <address> [--quantity <n>]
      Build the mint tx and dry-run it. Never sends.

  mint check <slug> --minter <address> [--quantity <n>]
      Report which stage is active and whether this wallet is eligible.

  mint keygen [--keystore <path>]        Create a new encrypted wallet
  mint import [--keystore <path>]         Import a key (prompts; never pass it as an argument)
  mint address [--keystore <path>]       Show the keystore's address
  mint status <slug> [--chain-id <id>]   Show one-shot state for a drop
  mint reconcile                         Resolve attempts stuck on 'pending'
  mint analyze <slug>                    Assess a drop and give a reasoned verdict

  mint discover [--chain <c>] [--max-price <eth>] [--verbose]
      Pull every OpenSea drop feed and list what this bot could execute.

  mint scan [--chain <c>] [--max-price <eth>] [--limit <n>] [--detail]
      Discover, enrich with collection stats, score, and rank.

  mint watch-add <slug> [--quantity <n>] [--max-price <eth>] [--note <s>]
  mint watch-list
  mint watch-remove <slug>
      Manage the persistent watchlist.

  mint auto [--min-score <n>] [--max-mints <n>] [--budget <eth>] [--live]
      Discover, score, rank, and mint autonomously. DRY RUN unless --live.
      Refuses any drop whose score rests on no trading data.
      Add --watchlist to restrict to watched slugs only.

  mint run [--interval <sec>] [--budget <eth>] [--live] [--watchlist]
      Continuous autonomous mode. Re-scans on an interval and mints whatever
      clears the gates, unattended, without prompting. DRY RUN unless --live.
      Stops when --budget is exhausted or on ctrl-c.

  mint arm <slug> [--quantity <n>] [--live] [--yes] [--no-analysis]
      Wait for the window, simulate, run rails, then mint.
      DRY RUN unless --live is passed.

      Rails:  --max-price <eth>      reject if unit price exceeds
              --max-gas-gwei <n>     reject if gas exceeds
              --max-total <eth>      reject if total cost exceeds
              --cap <eth>            lifetime spend cap across all runs
      Timing: --at <iso8601>         override the open time
              --lead <ms>            wake this long before open (default 30000)
              --poll <ms>            poll interval once awake (default 250)
              --heartbeat <sec>      force heartbeat cadence (default: adaptive)
              --max-wait <sec>       give up if not open by then (default 24h)
`;

async function main() {
  const slug = normalizeSlug(positional[0]);

  switch (cmd) {
    case 'watch':
      if (!slug) throw new Error('slug required');
      return watch(slug, { follow: !!flags.follow, interval: Number(flags.interval ?? 15) * 1000 });

    case 'simulate':
      if (!slug) throw new Error('slug required');
      return simulate(slug, {
        minter: flags.minter,
        quantity: Number(flags.quantity ?? 1),
        attribute: !flags['no-attribution'],
      });

    case 'check': {
      if (!slug) throw new Error('slug required');
      if (!flags.minter) throw new Error('--minter <address> required');
      const drop = await getDrop(slug);
      const { lines } = await checkEligibility({
        slug, drop, stage: drop.activeStage,
        minter: flags.minter, quantity: Number(flags.quantity ?? 1),
      });
      console.log(`\n${drop.collectionName} (${slug}) on ${drop.chain}`);
      for (const l of lines) console.log(`  ${l}`);
      console.log();
      return;
    }

    case 'keygen': {
      const pk = toHex(randomBytes(32));
      const password = await promptPassword('New keystore password: ');
      const again = await promptPassword('Confirm password: ');
      if (password !== again) throw new Error('Passwords do not match');
      if (password.length < 8) throw new Error('Password must be at least 8 characters');
      saveKeystore(ks(), encryptKeystore(pk, password));
      console.log(`\n  address   ${privateKeyToAccount(pk).address}`);
      console.log(`  keystore  ${ks()}`);
      console.log(`\n  Fund this address before arming. The keystore is the ONLY copy of this key.\n`);
      return;
    }

    case 'import': {
      // Reading the key from argv would leave it in shell history. Prefer stdin.
      const pk = positional[0] ?? (await promptPassword('Private key (hidden): ')).trim();
      if (positional[0]) {
        console.warn('\n  WARNING: the key was passed as an argument and is now in your shell history.');
        console.warn('  Consider running `history -d` on that entry, or rotate the key.\n');
      }
      if (!/^0x[0-9a-fA-F]{64}$/.test(pk ?? '')) throw new Error('Provide a 0x-prefixed 32-byte private key');
      const password = await promptPassword('New keystore password: ');
      if (password.length < 8) throw new Error('Password must be at least 8 characters');
      saveKeystore(ks(), encryptKeystore(pk, password));
      console.log(`\n  address   ${privateKeyToAccount(pk).address}`);
      console.log(`  keystore  ${ks()}\n`);
      return;
    }

    case 'address': {
      const k = loadKeystore(ks());
      console.log(`\n  0x${k.address}   (${ks()})\n`);
      return;
    }

    case 'analyze': {
      if (!slug) throw new Error('slug required');
      const a = await analyze(slug, { quantity: Number(flags.quantity ?? 1) });
      console.log(renderAnalysis(a));
      console.log();
      return;
    }

    case 'reconcile': {
      console.log('\n  checking unresolved attempts against the chain...');
      const r = await reconcilePending();
      console.log(r.checked ? `\n  ${r.checked} checked, ${r.resolved.length} resolved\n` : '  none pending\n');
      return;
    }

    case 'status': {
      if (!slug) throw new Error('slug required');
      const state = readState(slug, Number(flags['chain-id'] ?? 8453));
      console.log(state ? `\n${JSON.stringify(state, null, 2)}\n` : `\n  no recorded run for ${slug}\n`);
      return;
    }

    case 'arm':
      if (!slug) throw new Error('slug required');
      return arm(slug, {
        keystore: ks(),
        explain: !flags['no-analysis'],
        quiet: !!flags.quiet,
        quantity: Number(flags.quantity ?? 1),
        live: !!flags.live,
        yes: !!flags.yes,
        at: flags.at || null,
        lead: Number(flags.lead ?? 30000),
        poll: Number(flags.poll ?? 250),
        heartbeat: flags.heartbeat ? Number(flags.heartbeat) * 1000 : null,
        maxWait: flags['max-wait'] ? Number(flags['max-wait']) * 1000 : undefined,
        maxPrice: flags['max-price'],
        maxGasGwei: flags['max-gas-gwei'],
        maxTotal: flags['max-total'],
        cap: flags.cap,
        attribute: !flags['no-attribution'],
      });

    case 'discover': {
      const { drops, errors } = await discoverAll();
      for (const e of errors) console.error(`  feed error: ${e}`);
      const maxPriceWei = flags['max-price'] ? parseEther(String(flags['max-price'])) : null;
      const chains = flags.chain ? [flags.chain] : undefined;
      const assessed = drops.map((d) => ({ drop: d, ...assessActionability(d, { chains, maxPriceWei }) }));
      const ok = assessed.filter((a) => a.actionable);
      console.log(`\n  discovered ${drops.length} drops across all OpenSea feeds`);
      console.log(`  actionable: ${ok.length}\n`);
      for (const a of ok) {
        const st = a.stage;
        console.log(`   + ${a.drop.slug.padEnd(34)} ${String(a.drop.chain).padEnd(10)} ${st?.isOpen ? 'OPEN' : 'scheduled'}`);
      }
      if (flags.verbose) {
        console.log('\n  not actionable:');
        for (const a of assessed.filter((x) => !x.actionable)) {
          console.log(`   - ${a.drop.slug.padEnd(34)} ${a.reasons.join('; ')}`);
        }
      }
      console.log();
      return;
    }

    case 'scan': {
      const { drops, errors } = await discoverAll();
      for (const e of errors) console.error(`  feed error: ${e}`);
      const maxPriceWei = flags['max-price'] ? parseEther(String(flags['max-price'])) : null;
      const chains = flags.chain ? [flags.chain] : undefined;
      const ok = drops.map((d) => ({ drop: d, ...assessActionability(d, { chains, maxPriceWei }) }))
                      .filter((a) => a.actionable)
                      .map(({ drop, stage }) => ({ drop, stage }));
      if (!ok.length) { console.log('\n  no actionable drops found\n'); return; }
      console.log(`\n  scoring ${ok.length} actionable drops...`);
      const scored = await scoreAll(ok);
      renderScanTable(scored, { limit: Number(flags.limit ?? 20) });
      if (flags.detail) {
        for (const r of scored.slice(0, Number(flags.detail === true ? 3 : flags.detail))) renderDetail(r);
      }
      console.log(`\n  'measured' = has trading history. 'unknown' = new collection, no signal.`);
      console.log(`  Score ranks observable data. It does not predict value.\n`);
      return;
    }

    case 'run':
      return daemon({
        keystore: ks(),
        interval: Number(flags.interval ?? 300) * 1000,
        maxCycles: flags.cycles ? Number(flags.cycles) : Infinity,
        minScore: Number(flags['min-score'] ?? 20),
        maxMints: Number(flags['max-mints'] ?? 1),
        budget: flags.budget ?? null,
        chain: flags.chain ?? null,
        maxPrice: flags['max-price'] ?? null,
        quantity: Number(flags.quantity ?? 1),
        useWatchlist: !!flags.watchlist,
        live: !!flags.live,
        maxGasGwei: flags['max-gas-gwei'],
      });

    case 'auto':
      return auto({
        keystore: ks(),
        minScore: Number(flags['min-score'] ?? 20),
        maxMints: Number(flags['max-mints'] ?? 1),
        budget: flags.budget ?? null,
        chain: flags.chain ?? null,
        maxPrice: flags['max-price'] ?? null,
        quantity: Number(flags.quantity ?? 1),
        useWatchlist: !!flags.watchlist,
        live: !!flags.live,
        maxGasGwei: flags['max-gas-gwei'],
        cap: flags.cap,
      });

    case 'watch-add': {
      if (!slug) throw new Error('slug required');
      const r = watchlist.add(slug, { quantity: Number(flags.quantity ?? 1), maxPrice: flags['max-price'] ?? null, note: flags.note ?? null });
      console.log(r.added ? `\n  watching ${slug}\n` : `\n  ${slug}: ${r.reason}\n`);
      return;
    }

    case 'watch-list': {
      const wl = watchlist.load();
      if (!wl.entries.length) { console.log('\n  watchlist empty\n'); return; }
      console.log();
      for (const e of wl.entries) {
        console.log(`  ${e.slug.padEnd(34)} qty ${e.quantity}  ${e.maxPrice ? `max ${e.maxPrice} ETH` : 'no price limit'}${e.note ? `  -- ${e.note}` : ''}`);
      }
      console.log();
      return;
    }

    case 'watch-remove': {
      if (!slug) throw new Error('slug required');
      console.log(watchlist.remove(slug).removed ? `\n  removed ${slug}\n` : `\n  ${slug} not on watchlist\n`);
      return;
    }

    default:
      console.log(USAGE);
      process.exit(cmd ? 1 : 0);
  }
}

main().catch((e) => {
  console.error(`\nerror: ${e.shortMessage ?? e.message}\n`);
  process.exit(1);
});
