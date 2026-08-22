import { Bot } from "grammy";
import { isAddress } from "viem";
import { BOT_TOKEN, monadTestnet } from "./config.js";
import { registerChat, getChatDAO, unregisterChat } from "./db.js";
import {
  getDaoInfo,
  getProposalCount,
  getProposal,
  getTreasuryBalance,
  getVotingPower,
  formatEther,
} from "./contracts.js";
import { short, stateLine, formatDate } from "./format.js";
import { getLinkedWallet, connectLink } from "./wallets.js";

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
      "/register `<governance_address>` — link this group to a DAO (admin)",
      "/unregister — unlink this group (admin)",
      "",
      "*Your wallet*",
      "/connect — link a wallet to your Telegram account (DM)",
      "/wallet — show your linked wallet address",
      "",
      "*DAO info*",
      "/dao — DAO name, token, treasury, config",
      "/treasury — current treasury balance",
      "/contribute — get the treasury address to send funds to",
      "/balance `[address]` — staked voting power (yours, or an address)",
      "",
      "*Proposals*",
      "/proposals — list proposals",
      "/proposal `<id>` — full detail on one proposal",
    ].join("\n"),
    { parse_mode: "Markdown" }
  )
);

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

/*//////////////////////////////////////////////////////////////
                        /connect, /wallet
//////////////////////////////////////////////////////////////*/

bot.command("connect", async (ctx) => {
  const link = connectLink();
  if (!link) {
    await ctx.reply("Wallet linking isn't set up yet - ask an admin to configure CONNECT_SITE_URL.");
    return;
  }

  try {
    // DM rather than reply in-group, since this is personal.
    await ctx.api.sendMessage(
      ctx.from.id,
      `Connect your wallet here:\n${link}\n\nThis is a one-time step — after this, voting and proposing work directly from chat.`
    );
    if (ctx.chat.type !== "private") {
      await ctx.reply("📬 Sent you a DM with your connect link.");
    }
  } catch (err) {
    await ctx.reply(
      "Couldn't DM you — please start a private chat with me first (search for this bot and press Start), then try /connect again."
    );
  }
});

bot.command("wallet", async (ctx) => {
  try {
    const linked = await getLinkedWallet(ctx.from.id);
    if (!linked) {
      await ctx.reply("No wallet linked yet. Run /connect to link one.");
      return;
    }
    await ctx.reply(`Your wallet: \`${short(linked.walletAddress)}\``, { parse_mode: "Markdown" });
  } catch (err) {
    console.error(err);
    await ctx.reply("Couldn't check your linked wallet right now.");
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
    const linked = await getLinkedWallet(ctx.from.id).catch(() => null);
    if (!linked) {
      await ctx.reply(
        "No wallet linked yet, and no address given.\nRun /connect to link one, or use `/balance 0xSomeAddress`.",
        { parse_mode: "Markdown" }
      );
      return;
    }
    target = linked.walletAddress;
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
                            ERROR HANDLING
//////////////////////////////////////////////////////////////*/

bot.catch((err) => {
  console.error("Unhandled bot error:", err);
});

bot.start();

process.on("SIGINT", () => {
  bot.stop();
  process.exit(0);
});
