# Status — 2026-08-19

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

### 1. Funding — the live mint has never run

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

## Next step

Fund the minting wallet, then re-run the dry run against a funded wallet before
going live. Funding requires a human-approved swap or bridge — see Blocker 1.

## Not in this repo

`.env` (OpenSea API key), `.keystore/` (encrypted wallet), and `.state/`
(one-shot mint records) are gitignored and must never be committed.
