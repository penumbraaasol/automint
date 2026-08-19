---
name: zerion-automint
description: >
  Mint OpenSea SeaDrop NFT drops unattended: discover a drop and read its stages
  from the contract, fund the minting wallet with Zerion CLI, wait for the mint
  window, then execute with safety rails. Use when the user wants to auto-mint or
  schedule an NFT mint, check drop eligibility or timing, or fund and verify a
  wallet ahead of a drop. Not for secondary-market buying, listing, or offers.
license: MIT
---

# OpenSea SeaDrop Mint + Zerion CLI

**Purpose:** Execute OpenSea SeaDrop primary mints unattended, using Zerion CLI to
fund the minting wallet, confirm the funds landed on the right chain, and verify
the resulting transaction and portfolio change.

The two halves are genuinely separate: Zerion CLI owns the money (funding,
bridging, balance verification, post-mint confirmation), and the mint bot owns
the drop (stage timing, calldata, simulation, rails). Neither does the job alone
— see **Common Blockers** for why the mint itself cannot go through Zerion.

## Key Commands

Mint bot (from the project directory):
- `node bin/mint.js watch <slug>` — drop stages, reconciled against the contract
- `node bin/mint.js check <slug> --minter <addr>` — is this stage public or gated
- `node bin/mint.js simulate <slug> --minter <addr>` — dry-run the tx, never sends
- `node bin/mint.js arm <slug> [--live]` — wait for the window, then mint
- `node bin/mint.js keygen` — create an encrypted keystore for the bot wallet

Zerion CLI:
- `zerion wallet create --name <name>` — create a wallet
- `zerion wallet list` — list wallets and their addresses
- `zerion portfolio <wallet>` — total value and top positions
- `zerion positions <wallet>` — per-chain token balances (find what is spendable)
- `zerion bridge <from-chain> <from-token> <amount> <to-chain> <to-token>` — fund the mint chain
- `zerion history <wallet> --chain <chain>` — confirm the mint transaction
- `zerion pnl <wallet>` — post-mint accounting

## Requirements

- Node 20+ and the mint bot checked out
- Zerion CLI: `npm install -g zerion-cli`
- Zerion API key: `export ZERION_API_KEY="zk_..."`
- OpenSea API key in `.env` as `OPENSEA_API_KEY` (free instant key:
  `curl -X POST https://api.opensea.io/api/v2/auth/keys`)
- Optional but recommended before live use: `BASE_RPC_URL` / `ETH_RPC_URL`,
  since public RPCs rate-limit and add latency

## Workflow

### 1. Find the drop and read its real timing

```bash
node bin/mint.js watch pudgypenguins
```

Reports OpenSea's stage data *and* the contract's own `getPublicDrop`, warning on
divergence. Trigger on the onchain values — OpenSea's cache can lag, the chain
cannot.

### 2. Create the minting wallet

Keep this separate from any wallet holding real value. The bot signs locally, so
whatever this wallet holds is what the bot can reach.

```bash
node bin/mint.js keygen          # prompts for a password, prints the address
```

### 3. Check what you can fund it with

```bash
zerion positions treasury --positions simple
```

Look for a liquid balance on a cheap-gas chain. Bridging from an L2 costs far
less to originate than from Ethereum, though at low mainnet gas the difference
stops mattering.

### 4. Fund the mint chain

```bash
zerion bridge ethereum USDC 15 base ETH --to-address 0xBotWalletAddress
```

Then confirm it actually landed on the chain the drop is on — a bridge that
succeeded on the wrong chain looks identical to success:

```bash
zerion portfolio 0xBotWalletAddress
```

### 5. Dry-run against the funded wallet

```bash
node bin/mint.js simulate pudgypenguins --minter 0xBotWalletAddress
node bin/mint.js arm pudgypenguins --max-price 0.01 --max-gas-gwei 5 --cap 0.05
```

`arm` is dry-run by default. Run it once funded, before going live — the
`rails all passed` path behaves differently from the unfunded path and should not
execute for the first time during a real drop.

### 6. Arm for real

```bash
node bin/mint.js arm pudgypenguins --live --max-price 0.01 --max-gas-gwei 5 --cap 0.05
```

It sleeps until the window, heartbeats while waiting, re-reads the contract in
case the creator moves the stage, simulates, runs every rail, then broadcasts.

### 7. Confirm and account for it

```bash
zerion history 0xBotWalletAddress --chain base --limit 5
zerion pnl 0xBotWalletAddress
```

## Common Blockers

- **Zerion CLI cannot submit the mint itself.** Its chain-touching commands are
  `swap`, `bridge`, `send`, `consolidate`, `sign-message`, `sign-typed-data` —
  none accept arbitrary `to`/`data`/`value`. A SeaDrop `mintPublic()` call is not
  one of those shapes, so the mint signs from the bot's own keystore. Use Zerion
  for everything around the mint, not the mint.
- **A review threshold routes funding to the web app.** With
  `zerion wallet set-review-threshold <wallet> 0`, every transaction needs
  approval in the Zerion web app. Good for the funding step, fatal for anything
  unattended.
- **`arm` is dry-run unless `--live` is passed.** If nothing broadcast, check for
  the `DRY RUN` line before debugging anything else.
- **OpenSea's mint endpoint 409s while a stage is inactive**, so it cannot be
  prefetched. Public-stage calldata is built locally instead; gated stages must
  call it at fire time and pay the round-trip.
- **Gated stages need a proof that only the drop's backend holds.** There is no
  onchain source and no `isAllowlisted` standard. `check` reports which case
  applies.
- **The bot will not win contested mints.** Start times are published, so the
  race is pure propagation latency, lost to Flashbots-bundle operators. Its edge
  is never missing a window, not speed.

## Related Skills

- **zerion-analyze** — portfolio, positions, PnL for verifying funding and results
- **zerion-trading** — swap/bridge/send mechanics used in the funding step
- **zerion-wallet** — wallet creation, funding addresses, backup
- **zerion-agent-management** — agent tokens and policies, if you want Zerion-side
  guardrails on the funding wallet
