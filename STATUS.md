# Status — 2026-08-19 (live and autonomous)

An unattended OpenSea SeaDrop mint executor, packaged as a Zerion CLI partner
skill. Built and verified against live mainnet in one session.

**It is running.** A launchd daemon scans every 10 minutes and mints without a
human or a Claude session present. Three real mints have been executed.

## Live results

| Drop | Chain | Cost | Tx |
|---|---|---|---|
| Collectr | base | 0.005601 ETH | `0xaa80a1d9…` (manual, block 50191357) |
| Collectr | base | 0.005601 ETH | `0x8c531872…` (autonomous, block 50194522) |
| Gunflower Rising | ethereum | 0.001658 ETH | `0x9714b9e7…` (daemon, block 25792284) |

Lifetime spend **0.012860 ETH** against a 0.03 budget. The third was chosen,
armed, and bought by the daemon with no session running.

## Architecture

```
discover  → all three OpenSea drop feeds (105 drops, ~17 actionable)
scan      → enrich with collection stats + remaining supply, score, rank
auto      → gate, then arm the survivors
run       → repeat on an interval, unattended
```

Zerion CLI handles funding and verification; the bot handles drop timing,
calldata, simulation, and rails. Zerion cannot submit the mint itself — none of
its commands accept arbitrary `to`/`data`/`value` — so the mint signs locally.

## Gates and rails

Auto-mode gates, stacked on top of the per-mint rails rather than replacing
them:

| Gate | Default |
|---|---|
| dry run unless `--live` | on |
| `--min-score` | 20 (daemon runs 5) |
| confidence must be `measured` | `unknown` / `untested` refused |
| sold out | refused |
| affordable on that drop's chain | refused |
| already minted (one-shot) | refused |
| `--budget` across all runs | none unless set |

Per-mint rails: max price, max gas, max total, balance, chainId, per-wallet cap.
Every one has been observed firing.

## Bugs found and fixed

Each was caught by testing, not inspection, and each would have been invisible
in production.

**The floor price is a listing, not a trade.** The first scorer ranked on
OpenSea's advertised floor. Two collections advertising a 1 ETH floor ranked #1
while actually clearing at 0.0015 ETH — or not trading at all. It now uses the
realized clearing price (volume/sales, 7d then 30d) and trusts the floor only
when the two agree within 3x. No trades in 30 days scores **zero** on
economics, not a discounted high number.

**Sold-out drops still show as MINTING.** Three of seventeen actionable drops
were sold out; the top-ranked pick was one of them. The only other symptom is a
`MintQuantityExceedsMaxSupply` revert at simulation time, which an unattended
daemon would rediscover every cycle forever. Remaining supply is now a gate.

**Funds do not travel between chains.** The scorer ranked drops without regard
to where the money is, so the bot would arm a 0.256 ETH mint (~$490) against a
0.0029 ETH balance and fail every cycle. Balances and gas are now fetched once
per run and unaffordable drops rejected up front.

**The budget shared files with the one-shot guard.** Deleting a state file to
re-arm a drop silently reset the budget to zero — the difference between "mint
this again" and "spend without limit" for an unattended bot. Spend is now an
append-only ledger.

**A moving stage could hang the waiter forever.** Fixed with a retarget limit
and `--max-wait`.

## Verified findings

- SeaDrop v1 `0x00005ea00ac477b1030ce78506496e8c2de24bf5` — same address, and
  21,081 bytes of bytecode, on both Base and Ethereum
- `mintPublic(address,address,address,uint256)` = `0x161ac21f` (computed, matched)
- Locally built calldata is **byte-identical** to OpenSea's mint endpoint
- `POST /drops/{slug}/mint` returns **409 while a stage is inactive**, so it can
  never sit in the hot path — calldata is built locally instead
- Reverts decoded from selectors: `0x13da22f2` = `NotActive(uint256,uint256,uint256)`,
  `0xe12d2314` = `MintQuantityExceedsMaxSupply(uint256,uint256)`
- Onchain `getPublicDrop` matches OpenSea's price, window, and per-wallet cap
- REST returns flat snake_case; the MCP server normalizes to camelCase
- Keystore decrypts the official Web3 Secret Storage test vector

## Running it

```sh
./daemon/botctl.sh install     # launchd agent; survives logout and reboot
./daemon/botctl.sh status | logs | stop | uninstall
./daemon/botctl.sh spend       # lifetime spend from the ledger
```

## Known limits

- **Ethereum funds are nearly exhausted** (~0.0012 ETH). Since 16 of 17
  actionable drops are on Ethereum, top up there, not Base.
- **The private key is plaintext in `.env`.** It has been on disk unencrypted;
  rotate it. The encrypted keystore path exists and is preferable.
- **Gated stages are untested.** No live allowlist stage existed to exercise the
  OpenSea proof fallback; only the classification is tested.
- **The scorer ranks observable data. It does not predict value.** Two serious
  bugs were found in it in a few hours, both of which confidently recommended
  worthless drops. Treat `--min-score` as a filter, not a judgement.
- **Zero priority fee.** Transactions are sent without an explicit tip. That
  confirmed in 3 blocks on a quiet Ethereum (baseFee 0.35 gwei) but would stall
  when gas is contested.

## Not in this repo

`.env`, `.keystore/`, `.state/`, `daemon/*.log`, and `.claude/settings.local.json`
are gitignored and must never be committed.
