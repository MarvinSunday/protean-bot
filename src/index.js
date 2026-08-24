import { Bot } from "grammy";
import { isAddress } from "viem";
import { BOT_TOKEN, monadTestnet } from "./config.js";
import { registerChat, getChatDAO, unregisterChat, registerDistributor, getChatDistributor } from "./db.js";
import {
  getDaoInfo,
  getProposalCount,
  getProposal,
  getTreasuryBalance,
  getVotingPower,
  getDistributorInfo,
  hasAlreadyClaimed,
  distributeWelcomeGrant,
  createDaoOnChain,
  ensureGasFunded,
  stakeTokens,
  proposeOnChain,
  castVoteOnChain,
  formatEther,
} from "./contracts.js";
import { short, stateLine, formatDate } from "./format.js";
import { deriveUserWallet, isWalletDerivationConfigured } from "./wallet.js";

const bot = new Bot(BOT_TOKEN);

console.log("Protean bot starting (long polling)...");

/** Requires the chat to have a linked DAO; replies and returns null if not. */
async function requireDAO(ctx) {
  const address = getChatDAO(ctx.chat.id);
  if (!address) {
    await ctx.reply(
      "This group isn't linked to a DAO yet. An admin can run:\n`/register 0xYourGovernanceAddress`",
      { parse_mode: "Markdown" }
    );
    return null;
  }
  return address;
}

/*//////////////////////////////////////////////////////////////
                            /start, /help
//////////////////////////////////////////////////////////////*/

bot.command("start", (ctx) =>
  ctx.reply("👋 I'm Protean — I connect this chat to an on-chain DAO.\n\nRun /help to see what I can do.")
);

bot.command("help", (ctx) =>
  ctx.reply(
    [
      "*Setup*",
      "/createdao `<name> <symbol> <initialSupply> <maxSupply>` — deploy a new DAO and link it here",
      "/register `<governance_address>` — link this group to an existing DAO (admin)",
      "/unregister — unlink this group (admin)",
      "/setdistributor `<address>` — link a welcome-token distributor (admin)",
      "",
      "*Your wallet*",
      "/wallet — show your wallet address (generated automatically, no setup needed)",
      "",
      "*DAO info*",
      "/dao — DAO name, token, treasury, config",
      "/treasury — current treasury balance",
      "/contribute — get the treasury address to send funds to",
      "/balance `[address]` — staked voting power (yours, or an address)",
      "",
      "*Proposals & voting*",
      "/proposals — list proposals",
      "/proposal `<id>` — full detail on one proposal",
      "/stake `<amount>` — stake tokens to activate voting power",
      "/propose `<target> <value> <data> <description>` — create a proposal",
      "/vote `<id> for|against|abstain` — cast a vote",
      "",
      "*Welcome tokens*",
      "/claim — claim your welcome tokens",
    ].join("\n"),
    { parse_mode: "Markdown" }
  )
);

/*//////////////////////////////////////////////////////////////
                            /createdao
//////////////////////////////////////////////////////////////*/

bot.command("createdao", async (ctx) => {
  const args = ctx.match?.trim().split(/\s+/) ?? [];

  if (args.length !== 4) {
    await ctx.reply(
      [
        "Usage: `/createdao <name> <symbol> <initialSupply> <maxSupply>`",
        "",
        "Example: `/createdao ArkDAO ARK 1000000 10000000`",
        "",
        "⚠️ Name and symbol must be single words (no spaces) for now.",
      ].join("\n"),
      { parse_mode: "Markdown" }
    );
    return;
  }

  const [name, symbol, initialSupplyStr, maxSupplyStr] = args;
  const initialSupply = Number(initialSupplyStr);
  const maxSupply = Number(maxSupplyStr);

  if (!Number.isFinite(initialSupply) || !Number.isFinite(maxSupply) || initialSupply <= 0 || maxSupply <= 0) {
    await ctx.reply("Initial supply and max supply must be positive numbers.");
    return;
  }
  if (initialSupply > maxSupply) {
    await ctx.reply("Initial supply can't exceed max supply.");
    return;
  }

  const statusMsg = await ctx.reply("⏳ Creating DAO on-chain — this takes a moment…");

  try {
    const result = await createDaoOnChain(name, symbol, initialSupply, maxSupply);

    // Auto-link this chat to the new DAO, saving a manual /register step.
    registerChat(ctx.chat.id, result.governance);

    const lines = [
      `✅ *${name}* created and linked to this group.`,
      "",
      `Governance: \`${short(result.governance)}\``,
      `Token (staking wrapper): \`${short(result.governanceToken)}\``,
      `Underlying token: \`${short(result.underlyingToken)}\``,
      `Treasury: \`${short(result.treasury)}\``,
      "",
      `⚠️ The entire initial supply (${initialSupply} ${symbol}) is currently held by the bot's operator wallet, not any individual — this is a temporary shortcut until DAO creation moves to protean-connect. Someone will need to receive and distribute it manually for now.`,
    ];

    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, lines.join("\n"), {
      parse_mode: "Markdown",
    });
  } catch (err) {
    console.error(err);
    await ctx.api.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      `Couldn't create the DAO: ${err.message}`
    );
  }
});

/*//////////////////////////////////////////////////////////////
                            /register
//////////////////////////////////////////////////////////////*/

bot.command("register", async (ctx) => {
  const address = ctx.match?.trim();

  if (!address || !isAddress(address)) {
    await ctx.reply("Usage: `/register 0xYourGovernanceAddress`", { parse_mode: "Markdown" });
    return;
  }

  try {
    // Sanity check: does this actually look like a Governance contract?
    // A cheap read that only a real Governance deployment will answer.
    await getDaoInfo(address);
  } catch (err) {
    await ctx.reply(
      `Couldn't read a DAO at that address on ${monadTestnet.name}. Double-check it's a deployed Governance contract.`
    );
    return;
  }

  registerChat(ctx.chat.id, address);
  await ctx.reply(`✅ This group is now linked to the DAO at \`${short(address)}\`.`, {
    parse_mode: "Markdown",
  });
});

bot.command("unregister", async (ctx) => {
  unregisterChat(ctx.chat.id);
  await ctx.reply("Unlinked. Run /register to link a DAO again.");
});

bot.command("setdistributor", async (ctx) => {
  const address = ctx.match?.trim();

  if (!address || !isAddress(address)) {
    await ctx.reply("Usage: `/setdistributor 0xYourWelcomeDistributorAddress`", {
      parse_mode: "Markdown",
    });
    return;
  }

  let info;
  try {
    info = await getDistributorInfo(address);
  } catch (err) {
    await ctx.reply("Couldn't read a WelcomeDistributor at that address. Double-check it's deployed correctly.");
    return;
  }

  registerDistributor(ctx.chat.id, address);
  await ctx.reply(
    `✅ Welcome distributor linked. New members will be offered ${info.amountPerClaim} tokens once they've connected a wallet.`
  );
});

/*//////////////////////////////////////////////////////////////
                              /wallet
//////////////////////////////////////////////////////////////*/

bot.command("wallet", async (ctx) => {
  if (!isWalletDerivationConfigured()) {
    await ctx.reply("Wallets aren't set up yet - ask an admin to configure MASTER_WALLET_SEED.");
    return;
  }

  try {
    const account = deriveUserWallet(ctx.from.id);
    await ctx.reply(
      `Your wallet:\n\`${account.address}\`\n\nTap the address above to copy it. This wallet is generated automatically from your Telegram account — no separate connect step needed.`,
      { parse_mode: "Markdown" }
    );
  } catch (err) {
    console.error(err);
    await ctx.reply("Couldn't generate your wallet right now.");
  }
});

/*//////////////////////////////////////////////////////////////
                            /contribute
//////////////////////////////////////////////////////////////*/

bot.command("contribute", async (ctx) => {
  const address = await requireDAO(ctx);
  if (!address) return;

  try {
    const { daoName, treasuryAddress } = await getDaoInfo(address);
    const message = [
      `💰 *Contribute to ${daoName}*`,
      "",
      "Send MON (or any supported token) directly to the treasury:",
      `\`${treasuryAddress}\``,
      "",
      `Explorer: ${monadTestnet.blockExplorers.default.url}/address/${treasuryAddress}`,
      "",
      "⚠️ Funds sent here become DAO-controlled — moving them back out requires a passed governance proposal, not a unilateral withdrawal.",
    ].join("\n");

    try {
      await ctx.api.sendMessage(ctx.from.id, message, { parse_mode: "Markdown" });
      if (ctx.chat.type !== "private") {
        await ctx.reply("📬 Sent you the treasury address.");
      }
    } catch (dmErr) {
      // DM failed (user hasn't started a chat with the bot yet) - fall
      // back to posting in the group instead of failing silently. The
      // treasury address isn't sensitive, so this is a safe fallback,
      // unlike /connect's wallet-linking link.
      await ctx.reply(message, { parse_mode: "Markdown" });
    }
  } catch (err) {
    console.error(err);
    await ctx.reply("Couldn't read the treasury address right now.");
  }
});

/*//////////////////////////////////////////////////////////////
                                /dao
//////////////////////////////////////////////////////////////*/

bot.command("dao", async (ctx) => {
  const address = await requireDAO(ctx);
  if (!address) return;

  try {
    const { daoName, tokenAddress, treasuryAddress, config } = await getDaoInfo(address);

    const lines = [
      `*${daoName}*`,
      `Governance: \`${short(address)}\``,
      `Token: \`${short(tokenAddress)}\``,
      `Treasury: \`${short(treasuryAddress)}\``,
      "",
      `Quorum: ${Number(config.quorumBps) / 100}%`,
      `Approval threshold: ${Number(config.approvalThresholdBps) / 100}%`,
      `Voting delay: ${config.votingDelay} blocks`,
      `Voting period: ${config.votingPeriod} blocks`,
      `Timelock: ${Number(config.timelockDelay) / 3600}h`,
      `Execution window: ${Number(config.executionPeriod) / 3600}h`,
      `Proposal threshold: ${formatEther(config.proposalThreshold)} tokens`,
    ];

    await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
  } catch (err) {
    console.error(err);
    await ctx.reply("Couldn't read DAO info — the linked address may be stale.");
  }
});

/*//////////////////////////////////////////////////////////////
                            /treasury
//////////////////////////////////////////////////////////////*/

bot.command("treasury", async (ctx) => {
  const address = await requireDAO(ctx);
  if (!address) return;

  try {
    const { treasuryAddress } = await getDaoInfo(address);
    const balance = await getTreasuryBalance(treasuryAddress);
    await ctx.reply(`🏦 Treasury \`${short(treasuryAddress)}\`\nBalance: *${balance} MON*`, {
      parse_mode: "Markdown",
    });
  } catch (err) {
    console.error(err);
    await ctx.reply("Couldn't read the treasury balance.");
  }
});

/*//////////////////////////////////////////////////////////////
                            /balance
//////////////////////////////////////////////////////////////*/

bot.command("balance", async (ctx) => {
  const address = await requireDAO(ctx);
  if (!address) return;

  let target = ctx.match?.trim();
  if (target && !isAddress(target)) {
    await ctx.reply("That doesn't look like a valid address.");
    return;
  }

  if (!target) {
    if (!isWalletDerivationConfigured()) {
      await ctx.reply(
        "No address given, and wallets aren't set up.\nUse `/balance 0xSomeAddress`.",
        { parse_mode: "Markdown" }
      );
      return;
    }
    target = deriveUserWallet(ctx.from.id).address;
  }

  try {
    const { tokenAddress } = await getDaoInfo(address);
    const { staked, activeVotes, delegatedTo } = await getVotingPower(tokenAddress, target);

    const delegationNote =
      delegatedTo === "0x0000000000000000000000000000000000000000"
        ? "\n⚠️ Not delegated — staked balance carries zero voting power until delegated (staking auto-delegates to self, so this shouldn't normally happen)."
        : `\nDelegated to: \`${short(delegatedTo)}\``;

    await ctx.reply(
      `*${short(target)}*\nStaked: ${staked}\nActive voting power: ${activeVotes}${delegationNote}`,
      { parse_mode: "Markdown" }
    );
  } catch (err) {
    console.error(err);
    await ctx.reply("Couldn't read voting power for that address.");
  }
});

/*//////////////////////////////////////////////////////////////
                            /proposals
//////////////////////////////////////////////////////////////*/

bot.command("proposals", async (ctx) => {
  const address = await requireDAO(ctx);
  if (!address) return;

  try {
    const count = await getProposalCount(address);
    if (count === 0) {
      await ctx.reply("No proposals yet. Use /propose to create one (coming soon).");
      return;
    }

    // Most recent first, capped so one command can't dump a huge wall of text.
    const ids = Array.from({ length: Math.min(count, 10) }, (_, i) => count - i);
    const proposals = await Promise.all(ids.map((id) => getProposal(address, id)));

    const lines = proposals.map(
      (p) => `#${p.id} — ${stateLine(p.stateLabel)}\n${p.metadataURI.slice(0, 80)}`
    );

    await ctx.reply(
      `*Proposals* (showing ${ids.length} of ${count})\n\n${lines.join("\n\n")}\n\nUse /proposal \`<id>\` for full detail.`,
      { parse_mode: "Markdown" }
    );
  } catch (err) {
    console.error(err);
    await ctx.reply("Couldn't load proposals.");
  }
});

/*//////////////////////////////////////////////////////////////
                        /proposal <id>
//////////////////////////////////////////////////////////////*/

bot.command("proposal", async (ctx) => {
  const address = await requireDAO(ctx);
  if (!address) return;

  const id = ctx.match?.trim();
  if (!id || !/^\d+$/.test(id)) {
    await ctx.reply("Usage: `/proposal 3`", { parse_mode: "Markdown" });
    return;
  }

  try {
    const p = await getProposal(address, id);

    const lines = [
      `*Proposal #${p.id}* — ${stateLine(p.stateLabel)}`,
      p.metadataURI,
      "",
      `Proposer: \`${short(p.proposer)}\``,
      `For: ${formatEther(p.forVotes)} · Against: ${formatEther(p.againstVotes)} · Abstain: ${formatEther(p.abstainVotes)}`,
      `Quorum needed: ${formatEther(p.quorumVotes)}`,
      "",
      `Voting: block ${p.startBlock} → ${p.endBlock}`,
      p.queuedAt > 0n ? `Queued at: ${formatDate(p.queuedAt)}` : null,
      p.executableAfter > 0n ? `Executable after: ${formatDate(p.executableAfter)}` : null,
      `Actions: ${p.actions.length}`,
    ].filter(Boolean);

    await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
  } catch (err) {
    console.error(err);
    await ctx.reply(`Couldn't find proposal #${id} — check the ID and try again.`);
  }
});

/*//////////////////////////////////////////////////////////////
                              /stake
//////////////////////////////////////////////////////////////*/

bot.command("stake", async (ctx) => {
  const address = await requireDAO(ctx);
  if (!address) return;
  if (!isWalletDerivationConfigured()) {
    await ctx.reply("Wallets aren't set up on this bot yet - ask an admin to configure MASTER_WALLET_SEED.");
    return;
  }

  const amountStr = ctx.match?.trim();
  const amount = Number(amountStr);
  if (!amountStr || !Number.isFinite(amount) || amount <= 0) {
    await ctx.reply("Usage: `/stake 100` — stakes 100 of your tokens to activate voting power.", {
      parse_mode: "Markdown",
    });
    return;
  }

  const account = deriveUserWallet(ctx.from.id);
  const statusMsg = await ctx.reply("⏳ Staking — this takes a moment…");

  try {
    await ensureGasFunded(account);
    const { tokenAddress } = await getDaoInfo(address);
    await stakeTokens(account, tokenAddress, amount);

    await ctx.api.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      `✅ Staked ${amount} tokens. Your voting power is now active.`
    );
  } catch (err) {
    console.error(err);
    await ctx.api.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      `Couldn't stake: ${err.shortMessage || err.message}`
    );
  }
});

/*//////////////////////////////////////////////////////////////
                              /propose
//////////////////////////////////////////////////////////////*/

bot.command("propose", async (ctx) => {
  const address = await requireDAO(ctx);
  if (!address) return;
  if (!isWalletDerivationConfigured()) {
    await ctx.reply("Wallets aren't set up on this bot yet - ask an admin to configure MASTER_WALLET_SEED.");
    return;
  }

  // Format: /propose <target> <value> <data> <description...>
  const raw = ctx.match?.trim() ?? "";
  const parts = raw.split(/\s+/);
  const [target, value, data, ...descriptionParts] = parts;
  const description = descriptionParts.join(" ");

  if (!target || !isAddress(target) || !value || !data || !description) {
    await ctx.reply(
      [
        "Usage: `/propose <target> <value> <data> <description>`",
        "",
        "Example (no-op proposal for testing):",
        "`/propose 0xRecipient 0 0x Send a test proposal`",
        "",
        "⚠️ `data` must be `0x` or a full hex-encoded calldata string — this is a low-level, advanced-users command for now.",
      ].join("\n"),
      { parse_mode: "Markdown" }
    );
    return;
  }

  const account = deriveUserWallet(ctx.from.id);
  const statusMsg = await ctx.reply("⏳ Submitting proposal…");

  try {
    await ensureGasFunded(account);
    const { proposalId } = await proposeOnChain(account, address, target, value, data, description);

    await ctx.api.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      `✅ Proposal #${proposalId} created.\n\nUse /proposal ${proposalId} to check on it, or /vote ${proposalId} for|against|abstain once voting opens.`
    );
  } catch (err) {
    console.error(err);
    await ctx.api.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      `Couldn't create the proposal: ${err.shortMessage || err.message}`
    );
  }
});

/*//////////////////////////////////////////////////////////////
                              /vote
//////////////////////////////////////////////////////////////*/

const VOTE_CHOICES = { for: 1, against: 0, abstain: 2 };

bot.command("vote", async (ctx) => {
  const address = await requireDAO(ctx);
  if (!address) return;
  if (!isWalletDerivationConfigured()) {
    await ctx.reply("Wallets aren't set up on this bot yet - ask an admin to configure MASTER_WALLET_SEED.");
    return;
  }

  const args = ctx.match?.trim().split(/\s+/) ?? [];
  const [id, choiceRaw] = args;
  const choice = choiceRaw?.toLowerCase();

  if (!id || !/^\d+$/.test(id) || !(choice in VOTE_CHOICES)) {
    await ctx.reply("Usage: `/vote <id> for|against|abstain`", { parse_mode: "Markdown" });
    return;
  }

  const account = deriveUserWallet(ctx.from.id);
  const statusMsg = await ctx.reply("⏳ Casting vote…");

  try {
    await ensureGasFunded(account);
    await castVoteOnChain(account, address, id, VOTE_CHOICES[choice]);

    await ctx.api.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      `✅ Voted *${choice}* on proposal #${id}.`,
      { parse_mode: "Markdown" }
    );
  } catch (err) {
    console.error(err);
    await ctx.api.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      `Couldn't vote: ${err.shortMessage || err.message}`
    );
  }
});

/*//////////////////////////////////////////////////////////////
                            ERROR HANDLING
//////////////////////////////////////////////////////////////*/

bot.catch((err) => {
  console.error("Unhandled bot error:", err);
});

bot.start();

/*//////////////////////////////////////////////////////////////
                    WELCOME DISTRIBUTION
//////////////////////////////////////////////////////////////*/

/**
 * Attempts to distribute the welcome grant to a Telegram user in a given
 * chat. Returns a short status string describing what happened (used by
 * both the automatic join handler and the manual /claim fallback).
 *
 * NOTE ON TRUST: this only checks "has this address already claimed" and
 * "is a wallet linked" - it does not independently verify Telegram
 * membership beyond what grammY's own event told us. See
 * WelcomeDistributor.sol's natspec for the full trust-model note.
 */
async function attemptClaim(chatId, telegramUserId) {
  const distributorAddress = getChatDistributor(chatId);
  if (!distributorAddress) return { status: "no-distributor" };

  if (!isWalletDerivationConfigured()) return { status: "no-wallet" };

  const account = deriveUserWallet(telegramUserId);

  const alreadyClaimed = await hasAlreadyClaimed(distributorAddress, account.address).catch(() => false);
  if (alreadyClaimed) return { status: "already-claimed" };

  try {
    const hash = await distributeWelcomeGrant(distributorAddress, account.address);
    return { status: "sent", hash, walletAddress: account.address };
  } catch (err) {
    console.error("distributeWelcomeGrant failed:", err);
    return { status: "error", error: err.message };
  }
}

bot.on("message:new_chat_members", async (ctx) => {
  const distributorAddress = getChatDistributor(ctx.chat.id);
  if (!distributorAddress) return; // no distributor configured, nothing to do

  for (const member of ctx.message.new_chat_members) {
    if (member.is_bot) continue;

    const result = await attemptClaim(ctx.chat.id, member.id);

    if (result.status === "sent") {
      await ctx.reply(`🎉 Welcome, ${member.first_name}! Sent your welcome tokens.`);
    }
    // "no-wallet" (MASTER_WALLET_SEED not configured), "already-claimed",
    // and "error" cases are silent here - a join event isn't the place to
    // surface a bot-wide misconfiguration to the whole group; /claim gives
    // the user a way to see what actually happened.
  }
});

bot.command("claim", async (ctx) => {
  const result = await attemptClaim(ctx.chat.id, ctx.from.id);

  switch (result.status) {
    case "no-distributor":
      await ctx.reply("No welcome distribution is set up for this group.");
      break;
    case "no-wallet":
      await ctx.reply("Wallets aren't set up on this bot yet - ask an admin to configure MASTER_WALLET_SEED.");
      break;
    case "already-claimed":
      await ctx.reply("You've already claimed your welcome tokens.");
      break;
    case "sent":
      await ctx.reply(`✅ Sent your welcome tokens to \`${short(result.walletAddress)}\`.`, {
        parse_mode: "Markdown",
      });
      break;
    case "error":
      await ctx.reply("Something went wrong sending your tokens — try again in a moment.");
      break;
  }
});

process.on("SIGINT", () => {
  bot.stop();
  process.exit(0);
});