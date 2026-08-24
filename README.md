# Protean — DAO Governance Telegram Bot

Turns a Telegram group into a fully functioning DAO. Deploy a governance
system, get a wallet, stake, propose, and vote — all without leaving the
chat.

## Status

Fully write-capable. Every user gets a real, working wallet automatically
(no external wallet app, no separate connect step), and can stake, propose,
and vote directly from Telegram. This is a live, in-progress build — see
[What's not fully tested yet](#whats-not-fully-tested-yet) before relying
on it for anything real.

## How wallets work

Every Telegram user gets a wallet **derived deterministically** from their
Telegram ID and a single server-side secret (`MASTER_WALLET_SEED`) — the
same user always gets the same address, computed on the spot, nothing
stored. No OAuth flow, no third-party wallet provider, no separate app to
visit first.

This is a **custodial** model: the bot's backend can regenerate any user's
private key at any time from that one secret. It trades some
decentralization for zero-friction onboarding. See
[Security](#security---read-this-before-deploying) below.

## Commands

### Setup
- `/createdao <name> <symbol> <initialSupply> <maxSupply>` — deploys a new DAO (token, treasury, governance) and links it to this group
- `/register <governance_address>` — link this group to an existing DAO (admin)
- `/unregister` — unlink this group (admin)
- `/setdistributor <address>` — link a welcome-token distributor (admin)

### Wallet
- `/wallet` — shows your wallet's full address (tap to copy)

### DAO info (read-only)
- `/dao` — name, token, treasury, governance config
- `/treasury` — current treasury Chain Native Token balance
- `/contribute` — DMs the treasury address so anyone can send funds directly
- `/balance [address]` — staked voting power for yourself or a given address

### Proposals & voting
- `/proposals` — list recent proposals with their state
- `/proposal <id>` — full detail on one: vote tally, quorum, timing
- `/stake <amount>` — stake tokens to activate voting power
- `/propose <target> <value> <data> <description>` — create a proposal (advanced/low-level for now — see below)
- `/vote <id> for|against|abstain` — cast a vote

### Welcome tokens
- Automatic on join, if a distributor is linked
- `/claim` — manual pickup, or fallback if auto-distribution missed you

## Setup

```bash
git submodule update --init --recursive   # if cloned via the protean umbrella repo
npm install
cp .env.example .env
```

Fill in `.env`:

| Variable | Required for | Notes |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | everything | from BotFather |
| `RPC_URL` | everything | defaults to Chain's public RPC |
| `FACTORY_ADDRESS` | `/createdao` | from `DeployDAOFactory.s.sol`'s output |
| `OPERATOR_PRIVATE_KEY` | `/claim`, auto-distribution, `/createdao`, gas-funding user wallets | fund this wallet with Native Token |
| `MASTER_WALLET_SEED` | wallets, `/stake`, `/propose`, `/vote` | **the most sensitive value in this project** — see Security |

```bash
npm start
```

## Security — read this before deploying anywhere real

**`MASTER_WALLET_SEED`** can derive every user's private key, for every DAO
this bot operates. There is no way to rotate an individual user out of a
leak — only changing the seed, which changes *everyone's* address at once.
Generate it with `openssl rand -hex 32`, never commit it, never log it.

**`OPERATOR_PRIVATE_KEY`** pays gas for three things: `/claim`,
`/createdao`, and automatically topping up any user wallet that's low on
MON before their first `/stake`/`/propose`/`/vote`. Keep it funded, but
don't over-fund it — it's a live hot wallet.

**`/createdao`'s known limitation:** the entire initial token supply mints
to the *bot's operator wallet*, not the person who ran the command, and
`creator` is recorded on-chain as the operator too (cosmetic only — no
special permissions are gated behind `creator` in the contracts). This is
a deliberate shortcut, not a bug; distributing that initial supply to the
actual community currently requires a manual step afterward.

## What's not fully tested yet

Everything above has been verified as far as this development environment
allows — every file compiles/runs, module wiring is confirmed, wallet
derivation is confirmed deterministic and correctly signing. What **can't**
be verified without a live deployment and real testnet funds:

- An actual `/stake`, `/propose`, `/vote`, `/claim`, or `/createdao`
  transaction landing on-chain successfully
- The full stake → propose → vote → queue → execute loop end-to-end through
  the bot specifically (the underlying contracts have full test coverage;
  the bot's orchestration of them does not yet)

Test these yourself before trusting them for anything real — see the
"testing checklist" discussion in project notes for a suggested order
(`/wallet` → `/createdao` or `/register` → fund your wallet → `/stake` →
`/propose` → `/vote`).

## What's not built yet

- `/queue` and `/execute` — proposals can be created and voted on, but
  nothing in the bot currently queues or executes a succeeded proposal
- A guided, template-based `/propose` flow — right now it takes raw
  target/value/calldata, which is unforgiving for non-technical users
- Any UI for browsing/building multi-action proposals (the contracts
  support them; the bot only exposes single-action proposals)
- **Deploy `WelcomeDistributor` directly from the bot** — currently a
  manual Foundry script (`DeployWelcomeDistributor.s.sol`) run outside
  Telegram, then linked via `/setdistributor`. A `/deploydistributor`
  command (mirroring how `/createdao` already wraps `DeployDAOFactory`)
  would let an admin do this without leaving the chat.
- **Tipping** — sending tokens directly between members in-chat (e.g.
  `/tip @username 50`), separate from governance actions.
- **A transaction compiler** — `/propose` currently requires hand-crafted
  hex calldata, which is the single biggest usability gap in the bot right
  now. The plan is a JSON-to-calldata converter: the user describes an
  action in structured JSON (function name + args), and the bot compiles
  it into the correct calldata automatically before submitting the
  proposal — removing the need to understand ABI encoding at all.
- **Group-wide gas sponsorship** — the bot already covers small,
  automatic top-ups for a user's *first* transaction when their wallet is
  low (`ensureGasFunded`, funded from `OPERATOR_PRIVATE_KEY`). The planned
  version is more deliberate: an admin-toggleable mode where the DAO
  sponsors gas for *every* member action in the group — proposals, votes,
  staking — rather than relying on threshold-triggered top-ups. Likely
  needs its own funding pool and spending limits, separate from the
  general operator wallet, so one member's usage can't drain funds meant
  for governance actions.
- **Migrate off custodial derived wallets to Privy (non-custodial)** —
  the current wallet model (`src/wallet.js`) is custodial by design: the
  bot can regenerate any user's key from `MASTER_WALLET_SEED`. An earlier
  attempt to use Privy's embedded wallets (genuinely non-custodial,
  Telegram OAuth-based) hit two separate unresolved problems, not one:
  (1) the connect site couldn't reliably read back the created wallet's
  address from Privy's SDK response, and (2) transaction *signing* through
  Privy was never actually built — that needs the session-key/permissions
  layer (ERC-7715) discussed early in this project, a scoped grant letting
  the bot request signatures without a wallet popup per action, which is
  separate, additional work on top of just fixing address resolution. The
  `protean-connect` project has the address-resolution debugging in
  progress and is not currently wired into the bot. See
  [`protean-connect/README.md`](https://github.com/MarvinSunday/protean-connect/blob/main/README.md) for the full current status and the exact
  next step needed to unblock it.

## Architecture

- `src/config.js` — The Specific chain definition, viem clients, operator wallet
- `src/wallet.js` — deterministic per-user wallet derivation
- `src/contracts.js` — all on-chain reads and writes (Governance, Treasury, tokens, distributor)
- `src/db.js` — chat↔DAO and chat↔distributor link storage (flat JSON file — fine for now, not concurrency-safe, swap for a real DB before scaling)
- `src/format.js` — chat-message formatting helpers
- `src/index.js` — bot entrypoint, all command handlers

## Deploying it somewhere persistent

This needs to run as a long-lived process (it holds an open connection to
Telegram, not a request/response server) — **not** compatible with
serverless platforms like Vercel. Railway or Render work: point at this
repo, `npm install` as the build command, `npm start` as the run command,
set the same env vars as above in the platform's dashboard.

## Try it live

[**@proteandao_bot**](https://t.me/proteandao_bot) — assuming it's
currently deployed and running somewhere persistent (see above), you
should be able to message it directly and try the commands listed in this
README yourself.