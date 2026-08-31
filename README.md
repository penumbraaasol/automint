# automint

An unattended mint executor for OpenSea SeaDrop drops, packaged as a
[Zerion CLI](https://github.com/zeriontech) partner skill.

It discovers open drops, scores them on observable market data, waits for the
mint window, simulates the transaction, runs a set of safety rails, and only
then mints. It runs as a background daemon, so it can act on a window that
opens at 4am with nobody watching.

Supports **Ethereum**, **Base**, **Robinhood Chain**, **Shape**, **ApeChain**,
and **Avalanche** — every chain OpenSea serves SeaDrop drops on where the
protocol is actually deployed.

---

## What this is, and is not

**It is a scheduler, not a sniper.** SeaDrop publishes `startTime` in advance,
so there is no information edge: everyone knows when a drop opens, and the race
reduces to propagation latency — which a Node process loses to operators
submitting Flashbots bundles from co-located nodes. If your goal is winning
contested mints, this is the wrong architecture and optimising it will not
help.

Its actual edge is **presence and correctness**: never missing a window,
refusing bad transactions, and never double-minting. Many public stages run for
days, so most are not races at all.

**The scorer ranks what is measurable. It does not predict value.** It can tell
you a collection currently clears above its mint price and has real trading
volume. It cannot tell you whether a drop will be worth anything later. Treat
the score as a filter, not a judgement — see [Honest limits](#honest-limits).

---

## Install

```sh
git clone git@github.com:penumbraaasol/automint.git
cd automint
npm install
cp .env.example .env      # then add your OpenSea API key
```

An OpenSea API key is required. A free one takes one command:

```sh
curl -X POST https://api.opensea.io/api/v2/auth/keys
```

Optional but recommended before live use — public RPCs rate-limit and add
latency:

```sh
BASE_RPC_URL=...
ETH_RPC_URL=...
ROBINHOOD_RPC_URL=...
```

---

## Quick start

```sh
# What is out there right now
node bin/mint.js discover
node bin/mint.js scan --limit 10

# Should I want this one?  (slug or a pasted OpenSea URL)
node bin/mint.js analyze https://opensea.io/collection/<slug>

# Prove the transaction works without sending it
node bin/mint.js simulate <slug> --minter 0xYourAddress

# Create a wallet, fund it, then mint for real
node bin/mint.js keygen
node bin/mint.js arm <slug> --live --max-price 0.01 --cap 0.05
```

Every command that can spend is **dry run by default**. `--live` is required to
broadcast.

---

## Commands

| Command | What it does |
|---|---|
| `discover` | Pull all three OpenSea drop feeds and list what is executable |
| `scan` | Discover, enrich with market stats and supply, score, rank |
| `analyze <slug>` | Reasoned verdict on one drop: for, against, and unknowable |
| `watch <slug>` | Show stages; reconcile OpenSea's data against the contract |
| `check <slug>` | Is this stage public, or does it need an allowlist proof |
| `simulate <slug>` | Build the tx and dry-run it via `eth_call`. Never sends |
| `arm <slug>` | Wait for the window, simulate, run rails, then mint |
| `auto` | Discover → score → gate → mint, unsupervised |
| `run` | `auto` on a loop, for the daemon |
| `reconcile` | Resolve attempts stuck on `pending` against the chain |
| `keygen` / `import` / `address` | Encrypted wallet management |
| `watch-add` / `watch-list` / `watch-remove` | Persistent watchlist |
| `status <slug>` | One-shot state for a drop |

---

## Safety rails

Every rail runs **after** the window opens and immediately before signing,
because price, gas and supply all move between arming and firing. Violations
are collected and reported together rather than one per run.

| Rail | Flag | Default |
|---|---|---|
| Unit price ceiling | `--max-price <eth>` | off |
| Gas price ceiling | `--max-gas-gwei <n>` | off |
| Total cost ceiling | `--max-total <eth>` | off |
| Lifetime spend cap | `--cap <eth>` | off |
| Balance sufficiency | — | always |
| chainId assertion | — | always |
| Per-wallet cap | — | always, read onchain |
| One-shot / no double-mint | — | always |

Simulation is the rail that matters most: an `eth_call` against the exact
calldata catches not-started, sold-out, wrong-price and not-eligible before any
gas is spent. SeaDrop's custom errors are decoded, so a failure reports
`NotActive(now, start, end)` rather than a raw selector.

### Verdicts

`analyze` returns one of these, with the evidence on each side:

| Verdict | Meaning |
|---|---|
| `CANNOT MINT` | sold out |
| `BLOCKED` | gated stage, needs a proof we do not have |
| `NO EXIT` | has traded, but not one live bid at any price |
| `EXIT UNDERWATER` | best live bid is below the mint price |
| `UNKNOWABLE` | costs real money, no trading data to justify it |
| `POOR VALUE` | trades below mint on realized sales |
| `REASONABLE PUNT` | free mint, downside bounded at gas |
| `MARGINAL` / `DEFENSIBLE` | thin or favourable measurable edge |

`arm` prints the verdict before minting. It does not block on it — when you
name a drop, the decision is yours. `--no-analysis` skips it, `--quiet` drops
the plaintext-key notice.

### Autonomous gates

`auto` and `run` stack additional gates on top, because that is the only place
the bot spends money on something a human did not name:

| Gate | Behaviour |
|---|---|
| `--live` required | dry run otherwise |
| `--min-score <n>` | reject below threshold |
| Confidence must be `measured` | `unknown` and `untested` refused outright |
| Sold out | refused |
| Affordable on that drop's chain | refused — funds do not travel |
| Already minted | refused |
| No live bids | refused — nothing to sell into |
| Best bid below mint | refused — exit underwater |
| `--budget <eth>` | lifetime, survives state deletion |

---

## Running as a daemon

```sh
./daemon/botctl.sh install     # launchd agent; starts at login, restarts on crash
./daemon/botctl.sh status      # is it alive
./daemon/botctl.sh logs [n]    # what it has been doing
./daemon/botctl.sh follow      # tail live
./daemon/botctl.sh spend       # lifetime spend from the ledger
./daemon/botctl.sh stop
./daemon/botctl.sh uninstall
```

`install` fills the committed plist template with this machine's node and
project paths, validates it, and loads it. macOS only.

**A sleeping laptop does not mint.** launchd suspends the process when the
machine sleeps and resumes it on wake. Measured over one 8-day run, a laptop
that slept normally was awake for **26%** of the elapsed time. If uptime
matters, run it somewhere that does not sleep, or hold sleep off with
`caffeinate -s -i` while on AC power.

---

## Chain support

A chain is supportable when two things hold: viem ships a definition for it,
and SeaDrop v1 is deployed there. SeaDrop is deployed via CREATE2, so it lands
at the same address — `0x00005ea00ac477b1030ce78506496e8c2de24bf5` — on every
chain it reaches, with identical bytecode.

| Chain | id | Native | SeaDrop |
|---|---|---|---|
| ethereum | 1 | ETH | present |
| base | 8453 | ETH | present |
| robinhood | 4663 | ETH | present |
| shape | 360 | ETH | present |
| ape_chain | 33139 | APE | present |
| avalanche | 43114 | AVAX | present |
| megaeth | — | — | **not deployed** |

`megaeth` appears in OpenSea's feeds but SeaDrop is not deployed there, so
there is nothing to call. It is the only chain in the feeds this bot cannot
reach.

Adding a chain is one entry in `src/chains.js`. Verify SeaDrop is present
first:

```sh
cast code 0x00005ea00ac477b1030ce78506496e8c2de24bf5 --rpc-url <rpc>
```

Note that not every chain pays in ETH. Amounts are 18-decimal everywhere so the
arithmetic is unchanged, but `nativeSymbol()` supplies the correct label —
printing "ETH" on an APE-denominated mint would misstate the cost.

## How it works

```
discover   three OpenSea drop feeds (featured, upcoming, recently_minted)
              ~105 drops; this is the entire discoverable universe, there is
              no search endpoint
   ↓
score      enrich each with collection stats and remaining supply, then rank
   ↓
gate       reject sold out, unaffordable, already minted, or unmeasurable
   ↓
wait       sleep until startTime, re-reading the contract on a heartbeat in
              case the creator moves the stage
   ↓
simulate   eth_call the exact calldata; decode any revert
   ↓
rails      all guards, reported together
   ↓
mint       sign locally and broadcast
```

### Where Zerion fits

Zerion CLI handles the money — funding, bridging, swapping, balance
verification, and post-mint accounting. The bot handles the drop — timing,
calldata, simulation, rails.

The split is not stylistic. **Zerion cannot submit the mint itself.** Its
chain-touching commands are `swap`, `bridge`, `send`, `consolidate`,
`sign-message`, and `sign-typed-data`; none accepts arbitrary `to`/`data`/
`value`. A SeaDrop `mintPublic()` call is not one of those shapes, so the mint
signs from a local keystore while Zerion does everything around it.

---

## Protocol notes

Confirmed by execution against mainnet, not by assumption:

- SeaDrop v1 lives at `0x00005ea00ac477b1030ce78506496e8c2de24bf5` on every
  supported chain, with identical bytecode (21,081 bytes)
- `mintPublic(address,address,address,uint256)` → selector `0x161ac21f`
- OpenSea appends 4 attribution bytes (`0x3d958fe2`) past the ABI-encoded args
- Locally built calldata is **byte-identical** to OpenSea's mint endpoint
- `POST /drops/{slug}/mint` returns **409 while a stage is inactive**, so it can
  never be prefetched and can never sit in the hot path. Calldata is built
  locally instead
- The REST API returns flat `snake_case`; the OpenSea MCP server normalises to
  `camelCase`. Do not assume the MCP shape when calling REST
- Custom errors decoded from selectors: `0x13da22f2` =
  `NotActive(uint256,uint256,uint256)`, `0xe12d2314` =
  `MintQuantityExceedsMaxSupply(uint256,uint256)`

### Data hazards

Two OpenSea behaviours will mislead any integration:

**The advertised floor is a listing, not a trade.** On thin collections a
single optimistic listing produces an absurd floor. Two collections advertising
a 1 ETH floor were actually clearing at 0.0015 ETH, or not trading at all.
Scoring on the floor ranked both #1. This bot uses the realised clearing price
(volume ÷ sales, 7d falling back to 30d) and trusts the floor only when the two
agree within 3×.

**A floor without bids is not a price.** The strongest valuation signal is the
*bid* side — `/collections/{slug}/offer_aggregates` returns live collection
offers, which are escrowed WETH somebody will pay right now. A floor costs
nothing to post; a bid does not. Scoring on floors and realized sales, this bot
minted 14 NFTs across 13 collections; when the bid side was added afterwards,
**every one scored negative** — either no live bids at all, or a best bid up to
19x below what the mint cost. Check what you could sell into before buying.

**A sold-out drop still reports `MINTING`.** Three of seventeen actionable
drops in one scan were sold out, including the top-ranked pick. The only other
symptom is a `MintQuantityExceedsMaxSupply` revert at simulation time — which
an unattended daemon would rediscover every cycle forever. Remaining supply is
now checked as a gate.

---

## Honest limits

- **The scorer is backward-looking and manipulable.** Its inputs are public
  listings and reported volume, both of which can be gamed. It ranks
  observable data; it does not predict value.
- **Gated stages are untested.** Allowlist merkle proofs and signed presales
  are classified correctly, but the proof-fetching fallback has never run
  against a live gated stage.
- **Transactions are sent without an explicit priority fee.** This has confirmed
  within a few blocks on quiet chains, but would stall when gas is contested.
- **Keys are held locally.** The bot signs itself, so whatever the wallet holds
  is what a bug can reach. Fund a dedicated wallet rather than pointing it at
  one holding real value, and set `--cap`.
- **macOS only** for the daemon. The CLI is portable; `botctl.sh` uses launchd.

---

## Security

`.env`, `.keystore/`, `.state/`, `daemon/*.log`, and
`.claude/settings.local.json` are gitignored and must never be committed.

Prefer the encrypted keystore (`keygen` / `import`) over a plaintext key in
`.env`. `import` reads the key from a hidden prompt so it never enters shell
history. The keystore is Web3 Secret Storage v3 (scrypt, aes-128-ctr,
keccak256 MAC), verified against the official specification test vector, so the
file is portable to other wallets.

---

## Licence

MIT
