# Protean — DAO Governance Telegram Bot

Read-only phase: lets a Telegram group link itself to a deployed `Governance`
contract and query proposals, treasury balance, and voting power directly
from Monad Testnet. No wallet/signing yet — that's the next phase (see
project notes).

## Setup

1. Copy the env template and fill in your bot token:
   ```bash
   cp .env.example .env
   ```
   Get `TELEGRAM_BOT_TOKEN` from BotFather (see the "how do I create my bot"
   walkthrough — `/newbot`, then it gives you the token directly).

2. Install dependencies:
   ```bash
   npm install
   ```

3. Run it:
   ```bash
   npm start
   ```
   Or for auto-restart on file changes during development:
   ```bash
   npm run dev
   ```

4. Add the bot to a Telegram group (or DM it directly to test), then run:
   ```
   /register 0xYourDeployedGovernanceAddress
   ```

## Commands (current, read-only)

- `/dao` — DAO name, token, treasury, governance config
- `/treasury` — current treasury MON balance
- `/proposals` — list recent proposals with their state
- `/proposal <id>` — full detail on one proposal
- `/balance <address>` — staked voting power for an address
- `/register <governance_address>` — link this chat to a DAO
- `/unregister` — unlink

## How it stores chat↔DAO links

`data/chats.json` — a flat JSON file, created automatically on first
`/register`. Fine for one bot instance during development; swap for a real
database (Postgres, SQLite, etc.) before running this anywhere with real
users or across multiple server instances, since a JSON file has no
concurrency safety.

## Architecture notes

- `src/config.js` — Monad Testnet chain definition + viem public client
- `src/contracts.js` — read-only wrappers around Governance/Treasury/
  StakedGovernanceToken, using the same ABIs as the frontend (generated
  directly from the compiled contract source, not hand-written)
- `src/db.js` — chat↔DAO link storage
- `src/format.js` — chat-message formatting helpers
- `src/index.js` — bot entrypoint, all command handlers

## What's not here yet

Wallet linking, staking, voting, proposing, and the auto-welcome token
distribution are all deliberately out of scope for this phase — they need
the Telegram OAuth + embedded-wallet linking site built first. This bot is
the read-only foundation that phase builds on top of.
