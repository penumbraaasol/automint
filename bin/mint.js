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
  mint import <0xprivkey> [--keystore]   Import an existing key
  mint address [--keystore <path>]       Show the keystore's address
  mint status <slug> [--chain-id <id>]   Show one-shot state for a drop

  mint arm <slug> [--quantity <n>] [--live] [--yes]
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
  const slug = positional[0];

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
      const pk = positional[0];
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

    default:
      console.log(USAGE);
      process.exit(cmd ? 1 : 0);
  }
}

main().catch((e) => {
  console.error(`\nerror: ${e.shortMessage ?? e.message}\n`);
  process.exit(1);
});
