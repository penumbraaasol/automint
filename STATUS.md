# Status — 2026-08-19 (updated: autonomous mode)

An unattended OpenSea SeaDrop mint executor, packaged as a Zerion CLI partner
skill. Built and verified against live mainnet over one session.

## What works

Every item below was verified by running it, not by inspection.

| Area | State |
|---|---|
| OpenSea MCP server | Connected, 30 tools |
| OpenSea REST v2 | Authenticated, live data |
| `watch` | Reconciles OpenSea stage data against the contract |
| `check` | Classifies stage as public (prebuildable) vs gated |
| `simulate` | Builds the tx, dry-runs via `eth_call`, decodes reverts |
| `arm` | Waits, heartbeats, simulates, runs rails, would broadcast |
| Rails | max-price, max-gas, max-total, cap, balance, chainId, one-shot |
| Keystore | Web3 Secret Storage v3, verified against the official spec vector |
| Skill | `.claude/skills/zerion-automint/SKILL.md` |

Full 4-beat demo sequence runs in **~42 seconds**, entirely in dry run.

## Verified findings

- SeaDrop v1 `0x00005ea00ac477b1030ce78506496e8c2de24bf5` — 21,081 bytes on Base
- `mintPublic(address,address,address,uint256)` = `0x161ac21f` (computed, matched)
- Locally built calldata is **byte-identical** to OpenSea's `/drops/{slug}/mint`
- `POST /drops/{slug}/mint` returns **409 while a stage is inactive** — it cannot
  be prefetched, so it can never sit in the hot path. Calldata is built locally.
- Revert `0x13da22f2` identified as `NotActive(uint256,uint256,uint256)`
- Onchain `getPublicDrop` matches OpenSea's price, window, and per-wallet cap
- REST returns flat snake_case; the MCP server normalizes to camelCase

## Blockers

### RESOLVED: first live mint executed

Minted 1x Collectr on Base, tx
`0xaa80a1d973a2b5c101bb624d3f7cbd19aa05ea43b2dc3cfc59c55fb1642cdaae`,
block 50191357. 0.0056 ETH + $0.002 gas. NFT indexed on OpenSea ~80s later.

### 1. (was) Funding — the live mint has never run

The mint needs **0.0056016 ETH (~$10.71)** on Base. Current state:

| Wallet | Base ETH | Short by |
|---|---|---|
| bot `0x844ae723…e128` | 0 | 0.0056016 |
| treasury-test `0x52Fb9149…8e59` | 0.0016487 | 0.0039529 |

treasury-test holds **176.82 USDC on Ethereum** (verified onchain), so the value
exists — it is on the wrong chain and in the wrong form.

Two things block moving it automatically:

- `reviewThreshold: 0` on treasury-test routes every transaction to the Zerion
  web app for human approval. Correct behaviour, but not automatable.
- Claude Code's permission classifier blocks fund-moving CLI commands, so the
  bridge/swap must be run by a human.

### 2. Nothing has ever been broadcast

No live mint has been performed. Specifically, the
`rails all passed → would have sent` path has **never executed**, because every
dry run so far has stopped at `insufficient balance` first. That path should not
run for the first time during a recording.

### 3. Gated stages are implemented but untested

No drop in OpenSea's featured feed currently has a non-public active stage, so
the allowlist / signed-presale fallback has never run end to end. Stage
classification is tested; the proof path is not.

### 4. Base USDC does not reconcile

Zerion reports ~$7.08 of USDC on Base across five positions, but the canonical
Base USDC contract (`0x8335…2913`) shows only **1.673847**. The remainder is
likely bridged variants (USDbC) or held inside protocols, and therefore not
directly swappable. **The swap-only funding route may not actually work** — this
needs checking before committing to it over the bridge.

### 5. Ethereum mainnet untested

Everything was exercised on Base, where gas is ~0.007 gwei and a failed mint
costs fractions of a cent. Those economics say nothing about mainnet behaviour.

## Autonomous mode (new)

`discover` / `scan` / `watch-*` / `auto` close the loop from "you name a drop"
to "the bot finds one".

- **discover** pulls all three OpenSea feeds (`featured`, `upcoming`,
  `recently_minted`) -- 105 drops, ~17 actionable. That is the entire
  discoverable universe; there is no search endpoint.
- **scan** enriches each with collection stats and ranks them.
- **auto** discovers, scores, gates, and mints.

### The scoring bug worth knowing about

The first scorer ranked on OpenSea's advertised floor price. That is a
**listing**, not a trade. Two examples it got badly wrong:

| Collection | Advertised floor | Actually cleared | First score | Corrected |
|---|---|---|---|---|
| knuckle-up | 1 ETH | ~0.0015 ETH (13 sales/7d) | 50.5 (#1) | 10.5 |
| bone-theater | 1 ETH | **nothing in 7d** | 50.3 (#1) | 4.6 |

Both were ranked top picks on the strength of a single unsold listing. The
scorer now uses the realized clearing price (volume/sales, 7d then 30d) and
only trusts the floor when the two agree within 3x. A collection with no trades
in 30 days scores **zero** on economics, not a discounted high number.

This is the difference between a scorer that ranks and one that confidently
recommends garbage.

### Auto-mode gates

Stacked on top of the per-mint rails, not replacing them:

| Gate | Default |
|---|---|
| dry run unless `--live` | on |
| `--min-score` | 20 |
| confidence must be `measured` | enforced -- `unknown` / `untested` refused |
| `--budget <eth>` across the run | none unless set |
| `--max-mints` | 1 |
| one-shot (already minted) | enforced |

Verified: with `--budget 0.01` the run stopped because 0.0056 was already spent
on the real mint, and with the one-shot guard collectr is refused outright.

## Next step

Fund the minting wallet, then re-run the dry run against a funded wallet before
going live. Funding requires a human-approved swap or bridge — see Blocker 1.

## Not in this repo

`.env` (OpenSea API key), `.keystore/` (encrypted wallet), and `.state/`
(one-shot mint records) are gitignored and must never be committed.
