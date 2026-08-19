# opensea-mint-bot

Unattended SeaDrop mint executor. Phases 1-2 (watch + simulate) are built and
verified; nothing can sign or send yet.

## Design decisions

| Decision | Choice | Why |
|---|---|---|
| Custody | Encrypted local keystore | Not yet implemented -- phase 3 |
| Scope | SeaDrop v1 only | OpenSea supplies discovery, stages, price, caps |
| Chain | Base first | Gas ~0.007 gwei, so a lost mint costs fractions of a cent |
| Trigger | Scheduled off `startTime` | Start times are public; isolated behind one interface |

## Why this is a scheduler, not a sniper

SeaDrop publishes `startTime` in advance, so there is no information edge and
the race reduces to propagation latency -- which a Node CLI loses to operators
submitting Flashbots bundles. The real edge is *presence*: never missing a 4am
window, and executing correctly with rails. Many stages run for days
(one observed live drop had a 13-day public window), so most of these are not
races at all.

## Verified facts

Everything below was confirmed mechanically, not assumed:

- SeaDrop v1: `0x00005ea00ac477b1030ce78506496e8c2de24bf5` (21081 bytes on Base)
- `mintPublic(address,address,address,uint256)` = selector `0x161ac21f`
- OpenSea appends 4 attribution bytes (`0x3d958fe2`) past the ABI args
- Locally built calldata is **byte-identical** to OpenSea's `/drops/{slug}/mint`
- Onchain `getPublicDrop` matches OpenSea's stage data (price, window, cap)
- `POST /drops/{slug}/mint` returns **409 while a stage is not active**, so it
  can never sit in the hot path -- we build calldata ourselves
- REST returns flat snake_case; the MCP server normalizes it. Do not assume
  the MCP shape when calling REST.

## Usage

```sh
node bin/mint.js watch <slug> [--follow] [--interval <sec>]
node bin/mint.js simulate <slug> --minter <address> [--quantity <n>]
```

`simulate` builds the exact transaction and dry-runs it via `eth_call`. It
decodes SeaDrop's custom errors, so a failure reports e.g.
`NotActive(now, start, end) -- public stage is not open right now` rather than a
raw selector.

## Phases 3-5 (built)

**3. Armed executor** -- `mint arm` waits for the window, simulates, runs rails,
then mints. Dry run is the default; `--live` is required to broadcast and
prompts for confirmation unless `--yes`.

**4. Rails** -- every guard runs *after* the window opens and immediately before
signing, because price, gas and supply all move between arming and firing.
Violations are collected and printed together rather than one per run.

| Rail | Flag |
|---|---|
| Unit price ceiling | `--max-price <eth>` |
| Gas price ceiling | `--max-gas-gwei <n>` |
| Total cost ceiling | `--max-total <eth>` |
| Lifetime spend cap | `--cap <eth>` |
| Balance sufficiency | automatic |
| chainId assertion | automatic |
| Per-wallet cap | automatic (read onchain) |
| One-shot / no double-mint | automatic (`.state/<slug>-<chainId>.json`) |

**5. Allowlist / gated stages** -- `classifyStage` splits stages into
*prebuildable* (public) and *gated* (allowlist merkle proof, signed presale).
Gated proofs exist only in the drop's backend -- no onchain source, no standard
for deriving them -- so those fall back to OpenSea's endpoint at fire time and
pay one round-trip. `mint check` reports which case applies.

### Waiting (heartbeat)

`arm` never goes silent. While waiting it re-reads the contract and reports on
an adaptive cadence -- sparse when the open is hours out, tightening as it
approaches -- so you can always tell it is alive:

| Time to open | Heartbeat |
|---|---|
| > 2h | every 30m |
| > 30m | every 5m |
| > 5m | every 1m |
| > 1m | every 15s |
| < 1m | every 5s |

Each tick re-reads the authoritative onchain stage, because **creators move
stages**. Sleeping blindly on a start time captured at arm-time means missing a
window that shifts earlier, or waking into a `NotActive` revert if it shifts
later. Drift is reported and the target updated:

```
[02:54:15Z] START MOVED 2026-08-19 02:55:12Z -> 2026-08-19 02:54:15Z
[02:54:15Z] PRICE CHANGED 0.001 -> 0.005 ETH
```

Two bounds keep a moving stage from hanging the bot forever: `--max-wait`
(default 24h) and a retarget limit (default 20) that refuses to keep chasing a
start time that keeps receding. Sub-5s jitter is ignored so clock noise does not
spam the log.

### Custody

Web3 Secret Storage v3 keystore (scrypt, aes-128-ctr, keccak256 MAC), verified
against the official spec test vector -- so the file is readable by other
wallets, not just this tool. `mint keygen` / `mint import` / `mint address`.

### Dry-run balance lending

A dry run on an unfunded wallet simulates with a lent balance via state
override, so the simulation answers "would this mint be accepted?" separately
from "is the wallet funded?". Conflating those makes dry runs useless before
funding. Live runs never override.

## Verified

- Keystore decrypts the official Web3 Secret Storage pbkdf2 vector; rejects a
  wrong password on MAC mismatch; scrypt round-trips
- Rails fire individually: max-price, max-gas, session cap, balance, one-shot
- Scheduler sleeps, polls, and fires at the target instant (`--at`)
- Stage classification handles public / signed_presale / allow_list / none
- Heartbeat: retargets when the start moves earlier and fires immediately;
  aborts on a receding start (retarget limit) and on `--max-wait`; sub-5s
  jitter produces zero spurious drift lines

## Not verified

- **The gated-stage path has never run against a live gated stage.** No drop in
  the featured feed currently has a non-public active stage, so the OpenSea
  proof fallback is implemented but unexercised end to end.
- **Nothing has been broadcast.** No live mint has been performed.
- Ethereum mainnet is untested; all runs were Base.

## Environment

`.env` holds `OPENSEA_API_KEY`. Optional `BASE_RPC_URL` / `ETH_RPC_URL`
override the public RPCs -- worth setting before live use.
