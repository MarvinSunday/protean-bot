import { Bot } from "grammy";
import { isAddress, getAddress } from "viem";
import { BOT_TOKEN, monadTestnet } from "./config.js";
import {
  registerChat,
  getChatDAO,
  getChatModel,
  unregisterChat,
  registerDistributor,
  getChatDistributor,
} from "./db.js";
import {
  getProposalCount,
  getTreasuryBalance,
  getVotingPower,
  getDistributorInfo,
  hasAlreadyClaimed,
  distributeWelcomeGrant,
  createDaoOnChain,
  ensureGasFunded,
  formatEther,
} from "./contracts.js";
import { getAdapter, SUPPORTED_MODELS } from "./governance/index.js";
import {
  stakeTokens,
  unstakeTokens,
  walletClientFor,
  getGovernanceTokenAddress,
  getDaoInfo,
  hasToken,
  PROPOSAL_STATE_LABELS,
} from "./governance/common.js";
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
  const args = ctx.match?.trim().split(/\s+/) ?? [];
  const [address, modelRaw] = args;
  const model = modelRaw || "tokenWeighted";

  if (!address || !isAddress(address)) {
    await ctx.reply(
      `Usage: \`/register 0xYourGovernanceAddress [model]\`\n\nSupported models: ${SUPPORTED_MODELS.join(", ")} (defaults to tokenWeighted if omitted)`,
      { parse_mode: "Markdown" }
    );
    return;
  }

  if (!SUPPORTED_MODELS.includes(model)) {
    await ctx.reply(`Unknown model "${model}". Supported: ${SUPPORTED_MODELS.join(", ")}`);
    return;
  }

  try {
    // Sanity check: does this actually look like a governance contract
    // of the claimed model? A cheap read that only a real deployment of
    // that specific model will answer.
    getAdapter(model); // throws if model isn't registered - already validated above, but cheap to keep
    await getGovernanceTokenAddress(model, address);
  } catch (err) {
    await ctx.reply(
      `Couldn't read a "${model}" DAO at that address on ${monadTestnet.name}. Double-check the address and model.`
    );
    return;
  }

  registerChat(ctx.chat.id, address, model);
  await ctx.reply(`✅ This group is now linked to the ${model} DAO at \`${short(address)}\`.`, {
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
    const model = getChatModel(ctx.chat.id);
    const { daoName, treasuryAddress } = await getDaoInfo(model, address);
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
    const model = getChatModel(ctx.chat.id);
    const { daoName, tokenAddress, treasuryAddress, config } = await getDaoInfo(model, address);

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
    const model = getChatModel(ctx.chat.id);
    const { treasuryAddress } = await getDaoInfo(model, address);
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

  const model = getChatModel(ctx.chat.id);
  if (!hasToken(model)) {
    await ctx.reply(
      `This DAO uses ${model} governance, which has no token or voting balance - signers act directly, with equal standing. There's no balance to check here.`
    );
    return;
  }

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
    const { tokenAddress } = await getDaoInfo(model, address);
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
    const model = getChatModel(ctx.chat.id);
    const adapter = getAdapter(model);
    const p = await adapter.getProposal(address, id);
    const stateLabel = PROPOSAL_STATE_LABELS[p.stateIndex] ?? "Unknown";

    // Vote totals are only safe to run through formatEther when they're
    // real 18-decimal token amounts - a model like Quadratic reports
    // sqrt-weighted values on a completely different scale, which would
    // formatEther into a tiny, meaningless number instead.
    const formatVotes = (v) => (p.voteWeightUnit === "token" ? formatEther(v) : v.toString());
    const voteLabel = p.voteWeightUnit === "token" ? "" : " (voting weight)";

    const lines = [
      `*Proposal #${p.id}* — ${stateLine(stateLabel)}`,
      p.metadataURI,
      "",
      `Proposer: \`${short(p.proposer)}\``,
      `For: ${formatVotes(p.forVotes)} · Against: ${formatVotes(p.againstVotes)} · Abstain: ${formatVotes(p.abstainVotes)}${voteLabel}`,
      // Not every model exposes a quorum figure directly (Quadratic's
      // quorum is based on sqrt(totalSupply) and isn't a per-proposal
      // on-chain view) - omit the line entirely rather than guess at one.
      "quorumVotes" in p ? `Quorum needed: ${formatEther(p.quorumVotes)}` : null,
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

  const model = getChatModel(ctx.chat.id);
  if (!hasToken(model)) {
    await ctx.reply(
      `This DAO uses ${model} governance, which has no token or staking - signers act directly. There's nothing to stake here.`
    );
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
  const client = walletClientFor(account);
  const statusMsg = await ctx.reply("⏳ Staking — this takes a moment…");

  try {
    await ensureGasFunded(account);
    const tokenAddress = await getGovernanceTokenAddress(model, address);
    await stakeTokens(client, tokenAddress, amount);

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

  const model = getChatModel(ctx.chat.id);
  if (model === "sowellian") {
    await ctx.reply("This DAO uses sowellian governance, which needs resolution criteria. Use `/proposecriteria` instead - see `/help` for its format.", { parse_mode: "Markdown" });
    return;
  }
  if (model === "decisionMarkets") {
    await ctx.reply("This DAO uses decisionMarkets governance, which needs seed liquidity. Use `/proposemarket` instead - see `/help` for its format.", { parse_mode: "Markdown" });
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
  const client = walletClientFor(account);
  const statusMsg = await ctx.reply("⏳ Submitting proposal…");

  try {
    await ensureGasFunded(account);
    const adapter = getAdapter(model);
    const actions = [{ target: getAddress(target), value: BigInt(value || 0), data: data || "0x" }];
    const { proposalId } = await adapter.propose(client, address, actions, description);

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
                          /proposecriteria
//////////////////////////////////////////////////////////////*/

bot.command("proposecriteria", async (ctx) => {
  const address = await requireDAO(ctx);
  if (!address) return;
  if (!isWalletDerivationConfigured()) {
    await ctx.reply("Wallets aren't set up on this bot yet - ask an admin to configure MASTER_WALLET_SEED.");
    return;
  }

  const model = getChatModel(ctx.chat.id);
  if (model !== "sowellian") {
    await ctx.reply(`This DAO uses ${model} governance, which doesn't use resolution criteria. Use /propose instead.`);
    return;
  }

  // Format: /proposecriteria <target> <value> <data> <oracle|human> <oracleAddress|-> <targetValue> <min|max> <measurementPeriodSeconds> <description...>
  const raw = ctx.match?.trim() ?? "";
  const parts = raw.split(/\s+/);
  const [target, value, data, methodRaw, oracleRaw, targetValue, directionRaw, measurementPeriod, ...descriptionParts] = parts;
  const description = descriptionParts.join(" ");
  const method = methodRaw?.toLowerCase();
  const direction = directionRaw?.toLowerCase();

  const valid =
    target && isAddress(target) && value && data &&
    (method === "oracle" || method === "human") &&
    targetValue !== undefined && !Number.isNaN(Number(targetValue)) &&
    (direction === "min" || direction === "max") &&
    measurementPeriod && /^\d+$/.test(measurementPeriod) &&
    description &&
    (method !== "oracle" || (oracleRaw && isAddress(oracleRaw)));

  if (!valid) {
    await ctx.reply(
      [
        "Usage: `/proposecriteria <target> <value> <data> <oracle|human> <oracleAddress|-> <targetValue> <min|max> <measurementPeriodSeconds> <description>`",
        "",
        "`oracle` needs a real deployed IMetricOracle address; for `human`, pass `-` in that slot.",
        "`min` means success if the metric ends up >= targetValue; `max` means success if it ends up <= targetValue.",
        "",
        "Example (human track, resolves 7 days after execution):",
        "`/proposecriteria 0xRecipient 0 0x human - 0 min 604800 Fund the community grant`",
      ].join("\n"),
      { parse_mode: "Markdown" }
    );
    return;
  }

  const account = deriveUserWallet(ctx.from.id);
  const client = walletClientFor(account);
  const statusMsg = await ctx.reply("⏳ Submitting proposal…");

  try {
    await ensureGasFunded(account);
    const adapter = getAdapter("sowellian");
    const actions = [{ target: getAddress(target), value: BigInt(value || 0), data: data || "0x" }];
    const resolutionMethod = method === "oracle" ? 0 : 1;
    const oracle = method === "oracle" ? oracleRaw : "0x0000000000000000000000000000000000000000";

    const { proposalId } = await adapter.proposeWithCriteria(
      client,
      address,
      actions,
      description,
      resolutionMethod,
      oracle,
      targetValue,
      direction === "min",
      measurementPeriod
    );

    await ctx.api.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      `✅ Proposal #${proposalId} created. Use /proposal ${proposalId} to follow it through approval voting.`
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
                          /proposemarket
//////////////////////////////////////////////////////////////*/

bot.command("proposemarket", async (ctx) => {
  const address = await requireDAO(ctx);
  if (!address) return;
  if (!isWalletDerivationConfigured()) {
    await ctx.reply("Wallets aren't set up on this bot yet - ask an admin to configure MASTER_WALLET_SEED.");
    return;
  }

  const model = getChatModel(ctx.chat.id);
  if (model !== "decisionMarkets") {
    await ctx.reply(`This DAO uses ${model} governance, which doesn't use seeded markets. Use /propose instead.`);
    return;
  }

  // Format: /proposemarket <target> <value> <data> <baseSeedAmount> <quoteSeedAmountMON> <description...>
  const raw = ctx.match?.trim() ?? "";
  const parts = raw.split(/\s+/);
  const [target, value, data, baseSeedAmount, quoteSeedAmount, ...descriptionParts] = parts;
  const description = descriptionParts.join(" ");

  const valid =
    target && isAddress(target) && value && data &&
    baseSeedAmount && !Number.isNaN(Number(baseSeedAmount)) && Number(baseSeedAmount) > 0 &&
    quoteSeedAmount && !Number.isNaN(Number(quoteSeedAmount)) && Number(quoteSeedAmount) > 0 &&
    description;

  if (!valid) {
    await ctx.reply(
      [
        "Usage: `/proposemarket <target> <value> <data> <baseSeedAmount> <quoteSeedAmountMON> <description>`",
        "",
        "`baseSeedAmount` is DAO governance tokens (needs your prior approval to the governance contract), " +
          "`quoteSeedAmountMON` is native MON you're sending to seed the other side of both markets.",
        "",
        "Example:",
        "`/proposemarket 0xRecipient 0 0x 1000 5 Fund the marketing campaign`",
      ].join("\n"),
      { parse_mode: "Markdown" }
    );
    return;
  }

  const account = deriveUserWallet(ctx.from.id);
  const client = walletClientFor(account);
  const statusMsg = await ctx.reply("⏳ Deploying and seeding both markets — this takes a moment…");

  try {
    await ensureGasFunded(account);
    const adapter = getAdapter("decisionMarkets");
    const actions = [{ target: getAddress(target), value: BigInt(value || 0), data: data || "0x" }];

    const { proposalId } = await adapter.proposeWithSeed(
      client,
      address,
      actions,
      description,
      baseSeedAmount,
      quoteSeedAmount
    );

    await ctx.api.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      `✅ Proposal #${proposalId} created, both markets are live. Use /trade to back Pass or Fail.`
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
  const [id, choiceRaw, ...reasonParts] = args;
  const choice = choiceRaw?.toLowerCase();
  const reason = reasonParts.length > 0 ? reasonParts.join(" ") : undefined;

  if (!id || !/^\d+$/.test(id) || !(choice in VOTE_CHOICES)) {
    await ctx.reply("Usage: `/vote <id> for|against|abstain [reason]`", { parse_mode: "Markdown" });
    return;
  }

  const account = deriveUserWallet(ctx.from.id);
  const client = walletClientFor(account);
  const statusMsg = await ctx.reply("⏳ Casting vote…");

  try {
    await ensureGasFunded(account);
    const model = getChatModel(ctx.chat.id);
    const adapter = getAdapter(model);
    await adapter.vote(client, address, id, VOTE_CHOICES[choice], reason);

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
                              /queue
//////////////////////////////////////////////////////////////*/

bot.command("queue", async (ctx) => {
  const address = await requireDAO(ctx);
  if (!address) return;
  if (!isWalletDerivationConfigured()) {
    await ctx.reply("Wallets aren't set up on this bot yet - ask an admin to configure MASTER_WALLET_SEED.");
    return;
  }

  const id = ctx.match?.trim();
  if (!id || !/^\d+$/.test(id)) {
    await ctx.reply(
      "Usage: `/queue 3` — queues a proposal that has passed voting, starting its timelock.",
      { parse_mode: "Markdown" }
    );
    return;
  }

  const account = deriveUserWallet(ctx.from.id);
  const client = walletClientFor(account);
  const statusMsg = await ctx.reply("⏳ Queuing proposal…");

  try {
    await ensureGasFunded(account);
    const model = getChatModel(ctx.chat.id);
    const adapter = getAdapter(model);
    await adapter.queue(client, address, id);

    await ctx.api.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      `✅ Proposal #${id} queued. Check /proposal ${id} for when it becomes executable.`
    );
  } catch (err) {
    console.error(err);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `Couldn't queue: ${err.shortMessage || err.message}`);
  }
});

/*//////////////////////////////////////////////////////////////
                              /execute
//////////////////////////////////////////////////////////////*/

bot.command("execute", async (ctx) => {
  const address = await requireDAO(ctx);
  if (!address) return;
  if (!isWalletDerivationConfigured()) {
    await ctx.reply("Wallets aren't set up on this bot yet - ask an admin to configure MASTER_WALLET_SEED.");
    return;
  }

  const args = ctx.match?.trim().split(/\s+/) ?? [];
  const [id, valueRaw] = args;
  if (!id || !/^\d+$/.test(id)) {
    await ctx.reply(
      "Usage: `/execute 3 [nativeValue]` — runs a queued proposal's actions once its timelock has passed. Omit nativeValue unless the proposal's actions require sending MON.",
      { parse_mode: "Markdown" }
    );
    return;
  }

  const account = deriveUserWallet(ctx.from.id);
  const client = walletClientFor(account);
  const statusMsg = await ctx.reply("⏳ Executing proposal…");

  try {
    await ensureGasFunded(account);
    const model = getChatModel(ctx.chat.id);
    const adapter = getAdapter(model);
    await adapter.execute(client, address, id, valueRaw ? Number(valueRaw) : 0);

    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `✅ Proposal #${id} executed.`);
  } catch (err) {
    console.error(err);
    await ctx.api.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      `Couldn't execute: ${err.shortMessage || err.message}`
    );
  }
});

/*//////////////////////////////////////////////////////////////
                              /cancel
//////////////////////////////////////////////////////////////*/

bot.command("cancel", async (ctx) => {
  const address = await requireDAO(ctx);
  if (!address) return;
  if (!isWalletDerivationConfigured()) {
    await ctx.reply("Wallets aren't set up on this bot yet - ask an admin to configure MASTER_WALLET_SEED.");
    return;
  }

  const id = ctx.match?.trim();
  if (!id || !/^\d+$/.test(id)) {
    await ctx.reply(
      "Usage: `/cancel 3` — withdraws a proposal you created, before it's been decided.",
      { parse_mode: "Markdown" }
    );
    return;
  }

  const account = deriveUserWallet(ctx.from.id);
  const client = walletClientFor(account);
  const statusMsg = await ctx.reply("⏳ Cancelling proposal…");

  try {
    await ensureGasFunded(account);
    const model = getChatModel(ctx.chat.id);
    const adapter = getAdapter(model);
    await adapter.cancel(client, address, id);

    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `✅ Proposal #${id} cancelled.`);
  } catch (err) {
    console.error(err);
    await ctx.api.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      `Couldn't cancel: ${err.shortMessage || err.message}`
    );
  }
});

/*//////////////////////////////////////////////////////////////
                              /unstake
//////////////////////////////////////////////////////////////*/

/*//////////////////////////////////////////////////////////////
                        /confirm, /revoke
//////////////////////////////////////////////////////////////*/

bot.command("confirm", async (ctx) => {
  const address = await requireDAO(ctx);
  if (!address) return;
  if (!isWalletDerivationConfigured()) {
    await ctx.reply("Wallets aren't set up on this bot yet - ask an admin to configure MASTER_WALLET_SEED.");
    return;
  }

  const model = getChatModel(ctx.chat.id);
  const adapter = getAdapter(model);
  if (typeof adapter.confirm !== "function") {
    await ctx.reply(`This DAO uses ${model} governance, which has no confirmation step - use /vote instead.`);
    return;
  }

  const id = ctx.match?.trim();
  if (!id || !/^\d+$/.test(id)) {
    await ctx.reply("Usage: `/confirm 3` — as a signer, confirms proposal #3.", { parse_mode: "Markdown" });
    return;
  }

  const account = deriveUserWallet(ctx.from.id);
  const client = walletClientFor(account);
  const statusMsg = await ctx.reply("⏳ Confirming…");

  try {
    await ensureGasFunded(account);
    await adapter.confirm(client, address, id);
    await ctx.api.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      `✅ Confirmed proposal #${id}. It queues automatically once enough signers confirm.`
    );
  } catch (err) {
    console.error(err);
    await ctx.api.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      `Couldn't confirm: ${err.shortMessage || err.message}`
    );
  }
});

bot.command("revoke", async (ctx) => {
  const address = await requireDAO(ctx);
  if (!address) return;
  if (!isWalletDerivationConfigured()) {
    await ctx.reply("Wallets aren't set up on this bot yet - ask an admin to configure MASTER_WALLET_SEED.");
    return;
  }

  const model = getChatModel(ctx.chat.id);
  const adapter = getAdapter(model);
  if (typeof adapter.revokeConfirmation !== "function") {
    await ctx.reply(`This DAO uses ${model} governance, which has no confirmation step to revoke.`);
    return;
  }

  const id = ctx.match?.trim();
  if (!id || !/^\d+$/.test(id)) {
    await ctx.reply("Usage: `/revoke 3` — withdraws your confirmation on proposal #3.", { parse_mode: "Markdown" });
    return;
  }

  const account = deriveUserWallet(ctx.from.id);
  const client = walletClientFor(account);
  const statusMsg = await ctx.reply("⏳ Revoking confirmation…");

  try {
    await ensureGasFunded(account);
    await adapter.revokeConfirmation(client, address, id);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `✅ Confirmation on proposal #${id} revoked.`);
  } catch (err) {
    console.error(err);
    await ctx.api.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      `Couldn't revoke: ${err.shortMessage || err.message}`
    );
  }
});

/*//////////////////////////////////////////////////////////////
                      /delegate, /undelegate
//////////////////////////////////////////////////////////////*/

bot.command("delegate", async (ctx) => {
  const address = await requireDAO(ctx);
  if (!address) return;
  if (!isWalletDerivationConfigured()) {
    await ctx.reply("Wallets aren't set up on this bot yet - ask an admin to configure MASTER_WALLET_SEED.");
    return;
  }

  const model = getChatModel(ctx.chat.id);
  const adapter = getAdapter(model);
  if (typeof adapter.delegate !== "function") {
    await ctx.reply(`This DAO uses ${model} governance, which has no delegation.`);
    return;
  }

  const to = ctx.match?.trim();
  if (!to || !isAddress(to)) {
    await ctx.reply("Usage: `/delegate 0xSomeAddress` — sends your voting power to someone else.", { parse_mode: "Markdown" });
    return;
  }

  const account = deriveUserWallet(ctx.from.id);
  const client = walletClientFor(account);
  const statusMsg = await ctx.reply("⏳ Delegating…");

  try {
    await ensureGasFunded(account);
    await adapter.delegate(client, address, to);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `✅ Delegated your voting power to \`${short(to)}\`.`, { parse_mode: "Markdown" });
  } catch (err) {
    console.error(err);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `Couldn't delegate: ${err.shortMessage || err.message}`);
  }
});

bot.command("undelegate", async (ctx) => {
  const address = await requireDAO(ctx);
  if (!address) return;
  if (!isWalletDerivationConfigured()) {
    await ctx.reply("Wallets aren't set up on this bot yet - ask an admin to configure MASTER_WALLET_SEED.");
    return;
  }

  const model = getChatModel(ctx.chat.id);
  const adapter = getAdapter(model);
  if (typeof adapter.undelegate !== "function") {
    await ctx.reply(`This DAO uses ${model} governance, which has no delegation.`);
    return;
  }

  const account = deriveUserWallet(ctx.from.id);
  const client = walletClientFor(account);
  const statusMsg = await ctx.reply("⏳ Undelegating…");

  try {
    await ensureGasFunded(account);
    await adapter.undelegate(client, address);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, "✅ Voting power returned to you directly.");
  } catch (err) {
    console.error(err);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `Couldn't undelegate: ${err.shortMessage || err.message}`);
  }
});

/*//////////////////////////////////////////////////////////////
                            /challenge
//////////////////////////////////////////////////////////////*/

bot.command("challenge", async (ctx) => {
  const address = await requireDAO(ctx);
  if (!address) return;
  if (!isWalletDerivationConfigured()) {
    await ctx.reply("Wallets aren't set up on this bot yet - ask an admin to configure MASTER_WALLET_SEED.");
    return;
  }

  const model = getChatModel(ctx.chat.id);
  const adapter = getAdapter(model);
  if (typeof adapter.challenge !== "function") {
    await ctx.reply(`This DAO uses ${model} governance, which has nothing to challenge.`);
    return;
  }

  const id = ctx.match?.trim();
  if (!id || !/^\d+$/.test(id)) {
    await ctx.reply(
      "Usage: `/challenge 3` — disputes proposal #3 within its challenge window, posting the configured bond and opening a fallback vote.",
      { parse_mode: "Markdown" }
    );
    return;
  }

  const account = deriveUserWallet(ctx.from.id);
  const client = walletClientFor(account);
  const statusMsg = await ctx.reply("⏳ Challenging…");

  try {
    await ensureGasFunded(account);
    await adapter.challenge(client, address, id);
    await ctx.api.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      `✅ Proposal #${id} challenged. Fallback vote is now open - use /vote ${id} for|against|abstain.`
    );
  } catch (err) {
    console.error(err);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `Couldn't challenge: ${err.shortMessage || err.message}`);
  }
});

/*//////////////////////////////////////////////////////////////
              /registereligible, /withdraweligibility
//////////////////////////////////////////////////////////////*/

bot.command("registereligible", async (ctx) => {
  const address = await requireDAO(ctx);
  if (!address) return;
  if (!isWalletDerivationConfigured()) {
    await ctx.reply("Wallets aren't set up on this bot yet - ask an admin to configure MASTER_WALLET_SEED.");
    return;
  }

  const model = getChatModel(ctx.chat.id);
  const adapter = getAdapter(model);
  if (typeof adapter.registerEligible !== "function") {
    await ctx.reply(`This DAO uses ${model} governance, which has no eligibility pool.`);
    return;
  }

  const account = deriveUserWallet(ctx.from.id);
  const client = walletClientFor(account);
  const statusMsg = await ctx.reply("⏳ Registering…");

  try {
    await ensureGasFunded(account);
    await adapter.registerEligible(client, address);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, "✅ You're in the eligible pool for the next sortition draw.");
  } catch (err) {
    console.error(err);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `Couldn't register: ${err.shortMessage || err.message}`);
  }
});

bot.command("withdraweligibility", async (ctx) => {
  const address = await requireDAO(ctx);
  if (!address) return;
  if (!isWalletDerivationConfigured()) {
    await ctx.reply("Wallets aren't set up on this bot yet - ask an admin to configure MASTER_WALLET_SEED.");
    return;
  }

  const model = getChatModel(ctx.chat.id);
  const adapter = getAdapter(model);
  if (typeof adapter.withdrawEligibility !== "function") {
    await ctx.reply(`This DAO uses ${model} governance, which has no eligibility pool.`);
    return;
  }

  const account = deriveUserWallet(ctx.from.id);
  const client = walletClientFor(account);
  const statusMsg = await ctx.reply("⏳ Withdrawing from the pool…");

  try {
    await ensureGasFunded(account);
    await adapter.withdrawEligibility(client, address);
    await ctx.api.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      "✅ Removed from the eligible pool. This doesn't remove you from a council you're already serving on."
    );
  } catch (err) {
    console.error(err);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `Couldn't withdraw: ${err.shortMessage || err.message}`);
  }
});

/*//////////////////////////////////////////////////////////////
              /startsortition, /finalizesortition
//////////////////////////////////////////////////////////////*/

bot.command("startsortition", async (ctx) => {
  const address = await requireDAO(ctx);
  if (!address) return;
  if (!isWalletDerivationConfigured()) {
    await ctx.reply("Wallets aren't set up on this bot yet - ask an admin to configure MASTER_WALLET_SEED.");
    return;
  }

  const model = getChatModel(ctx.chat.id);
  const adapter = getAdapter(model);
  if (typeof adapter.startSortition !== "function") {
    await ctx.reply(`This DAO uses ${model} governance, which has no sortition draw.`);
    return;
  }

  const account = deriveUserWallet(ctx.from.id);
  const client = walletClientFor(account);
  const statusMsg = await ctx.reply("⏳ Requesting randomness for a new sortition round…");

  try {
    await ensureGasFunded(account);
    const { round } = await adapter.startSortition(client, address);
    await ctx.api.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      `✅ Sortition round ${round} started. Once the randomness request is fulfilled, run /finalizesortition to draw the new council.`
    );
  } catch (err) {
    console.error(err);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `Couldn't start sortition: ${err.shortMessage || err.message}`);
  }
});

bot.command("finalizesortition", async (ctx) => {
  const address = await requireDAO(ctx);
  if (!address) return;
  if (!isWalletDerivationConfigured()) {
    await ctx.reply("Wallets aren't set up on this bot yet - ask an admin to configure MASTER_WALLET_SEED.");
    return;
  }

  const model = getChatModel(ctx.chat.id);
  const adapter = getAdapter(model);
  if (typeof adapter.finalizeSortition !== "function") {
    await ctx.reply(`This DAO uses ${model} governance, which has no sortition draw.`);
    return;
  }

  const account = deriveUserWallet(ctx.from.id);
  const client = walletClientFor(account);
  const statusMsg = await ctx.reply("⏳ Drawing the new council…");

  try {
    await ensureGasFunded(account);
    await adapter.finalizeSortition(client, address);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, "✅ New council drawn. Use /council to see the roster.");
  } catch (err) {
    console.error(err);
    await ctx.api.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      `Couldn't finalize sortition (the randomness request may not be fulfilled yet): ${err.shortMessage || err.message}`
    );
  }
});

/*//////////////////////////////////////////////////////////////
                              /council
//////////////////////////////////////////////////////////////*/

bot.command("council", async (ctx) => {
  const address = await requireDAO(ctx);
  if (!address) return;

  const model = getChatModel(ctx.chat.id);
  const adapter = getAdapter(model);
  if (typeof adapter.getCouncil !== "function") {
    await ctx.reply(`This DAO uses ${model} governance, which has no council.`);
    return;
  }

  try {
    const council = await adapter.getCouncil(address);
    const lines = council.map((addr, i) => `${i + 1}. \`${short(addr)}\``);
    await ctx.reply(`*Current council* (${council.length}):\n${lines.join("\n")}`, { parse_mode: "Markdown" });
  } catch (err) {
    console.error(err);
    await ctx.reply("Couldn't read the council.");
  }
});

/*//////////////////////////////////////////////////////////////
    /startelection, /declarecandidacy, /voteinelection,
    /finalizeelection
//////////////////////////////////////////////////////////////*/

bot.command("startelection", async (ctx) => {
  const address = await requireDAO(ctx);
  if (!address) return;
  if (!isWalletDerivationConfigured()) {
    await ctx.reply("Wallets aren't set up on this bot yet - ask an admin to configure MASTER_WALLET_SEED.");
    return;
  }

  const model = getChatModel(ctx.chat.id);
  const adapter = getAdapter(model);
  if (typeof adapter.startElection !== "function") {
    await ctx.reply(`This DAO uses ${model} governance, which has no elections.`);
    return;
  }

  const account = deriveUserWallet(ctx.from.id);
  const client = walletClientFor(account);
  const statusMsg = await ctx.reply("⏳ Opening a new election…");

  try {
    await ensureGasFunded(account);
    const { electionId } = await adapter.startElection(client, address);
    await ctx.api.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      `✅ Election #${electionId} opened. Candidates: /declarecandidacy ${electionId}. Voters: /voteinelection ${electionId} once candidacy closes.`
    );
  } catch (err) {
    console.error(err);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `Couldn't start the election: ${err.shortMessage || err.message}`);
  }
});

bot.command("declarecandidacy", async (ctx) => {
  const address = await requireDAO(ctx);
  if (!address) return;
  if (!isWalletDerivationConfigured()) {
    await ctx.reply("Wallets aren't set up on this bot yet - ask an admin to configure MASTER_WALLET_SEED.");
    return;
  }

  const model = getChatModel(ctx.chat.id);
  const adapter = getAdapter(model);
  if (typeof adapter.declareCandidacy !== "function") {
    await ctx.reply(`This DAO uses ${model} governance, which has no elections.`);
    return;
  }

  const electionId = ctx.match?.trim();
  if (!electionId || !/^\d+$/.test(electionId)) {
    await ctx.reply("Usage: `/declarecandidacy <electionId>` — declares your candidacy in an open election.", { parse_mode: "Markdown" });
    return;
  }

  const account = deriveUserWallet(ctx.from.id);
  const client = walletClientFor(account);
  const statusMsg = await ctx.reply("⏳ Declaring candidacy…");

  try {
    await ensureGasFunded(account);
    await adapter.declareCandidacy(client, address, electionId);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `✅ You're a candidate in election #${electionId}.`);
  } catch (err) {
    console.error(err);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `Couldn't declare candidacy: ${err.shortMessage || err.message}`);
  }
});

bot.command("voteinelection", async (ctx) => {
  const address = await requireDAO(ctx);
  if (!address) return;
  if (!isWalletDerivationConfigured()) {
    await ctx.reply("Wallets aren't set up on this bot yet - ask an admin to configure MASTER_WALLET_SEED.");
    return;
  }

  const model = getChatModel(ctx.chat.id);
  const adapter = getAdapter(model);
  if (typeof adapter.voteInElection !== "function") {
    await ctx.reply(`This DAO uses ${model} governance, which has no elections.`);
    return;
  }

  // Format: /voteinelection <electionId> <candidate1> [candidate2] ...
  const parts = (ctx.match?.trim() ?? "").split(/\s+/);
  const [electionId, ...candidates] = parts;

  if (!electionId || !/^\d+$/.test(electionId) || candidates.length === 0 || !candidates.every(isAddress)) {
    await ctx.reply(
      "Usage: `/voteinelection <electionId> <candidate1> [candidate2] ...` — votes for up to councilSize distinct candidates.",
      { parse_mode: "Markdown" }
    );
    return;
  }

  const account = deriveUserWallet(ctx.from.id);
  const client = walletClientFor(account);
  const statusMsg = await ctx.reply("⏳ Casting your election vote…");

  try {
    await ensureGasFunded(account);
    await adapter.voteInElection(client, address, electionId, candidates);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `✅ Voted for ${candidates.length} candidate(s) in election #${electionId}.`);
  } catch (err) {
    console.error(err);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `Couldn't vote: ${err.shortMessage || err.message}`);
  }
});

bot.command("finalizeelection", async (ctx) => {
  const address = await requireDAO(ctx);
  if (!address) return;
  if (!isWalletDerivationConfigured()) {
    await ctx.reply("Wallets aren't set up on this bot yet - ask an admin to configure MASTER_WALLET_SEED.");
    return;
  }

  const model = getChatModel(ctx.chat.id);
  const adapter = getAdapter(model);
  if (typeof adapter.finalizeElection !== "function") {
    await ctx.reply(`This DAO uses ${model} governance, which has no elections.`);
    return;
  }

  const electionId = ctx.match?.trim();
  if (!electionId || !/^\d+$/.test(electionId)) {
    await ctx.reply("Usage: `/finalizeelection <electionId>` — closes voting and seats the top vote-getters as the new council.", { parse_mode: "Markdown" });
    return;
  }

  const account = deriveUserWallet(ctx.from.id);
  const client = walletClientFor(account);
  const statusMsg = await ctx.reply("⏳ Finalizing the election…");

  try {
    await ensureGasFunded(account);
    await adapter.finalizeElection(client, address, electionId);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, "✅ Election finalized. Use /council to see the new roster.");
  } catch (err) {
    console.error(err);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `Couldn't finalize the election: ${err.shortMessage || err.message}`);
  }
});

/*//////////////////////////////////////////////////////////////
    /initiaterecall, /voterecall, /finalizerecall
//////////////////////////////////////////////////////////////*/

bot.command("initiaterecall", async (ctx) => {
  const address = await requireDAO(ctx);
  if (!address) return;
  if (!isWalletDerivationConfigured()) {
    await ctx.reply("Wallets aren't set up on this bot yet - ask an admin to configure MASTER_WALLET_SEED.");
    return;
  }

  const model = getChatModel(ctx.chat.id);
  const adapter = getAdapter(model);
  if (typeof adapter.initiateRecall !== "function") {
    await ctx.reply(`This DAO uses ${model} governance, which has no recall.`);
    return;
  }

  const delegateAddress = ctx.match?.trim();
  if (!delegateAddress || !isAddress(delegateAddress)) {
    await ctx.reply("Usage: `/initiaterecall 0xCouncilMember` — starts a token-weighted vote to remove a sitting council member.", { parse_mode: "Markdown" });
    return;
  }

  const account = deriveUserWallet(ctx.from.id);
  const client = walletClientFor(account);
  const statusMsg = await ctx.reply("⏳ Starting a recall vote…");

  try {
    await ensureGasFunded(account);
    const { recallId } = await adapter.initiateRecall(client, address, delegateAddress);
    await ctx.api.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      `✅ Recall #${recallId} started against \`${short(delegateAddress)}\`. Vote with /voterecall ${recallId} for|against|abstain.`,
      { parse_mode: "Markdown" }
    );
  } catch (err) {
    console.error(err);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `Couldn't start the recall: ${err.shortMessage || err.message}`);
  }
});

bot.command("voterecall", async (ctx) => {
  const address = await requireDAO(ctx);
  if (!address) return;
  if (!isWalletDerivationConfigured()) {
    await ctx.reply("Wallets aren't set up on this bot yet - ask an admin to configure MASTER_WALLET_SEED.");
    return;
  }

  const model = getChatModel(ctx.chat.id);
  const adapter = getAdapter(model);
  if (typeof adapter.voteRecall !== "function") {
    await ctx.reply(`This DAO uses ${model} governance, which has no recall.`);
    return;
  }

  const [recallId, choiceRaw] = (ctx.match?.trim() ?? "").split(/\s+/);
  const choice = choiceRaw?.toLowerCase();
  if (!recallId || !/^\d+$/.test(recallId) || !(choice in VOTE_CHOICES)) {
    await ctx.reply("Usage: `/voterecall <recallId> for|against|abstain`", { parse_mode: "Markdown" });
    return;
  }

  const account = deriveUserWallet(ctx.from.id);
  const client = walletClientFor(account);
  const statusMsg = await ctx.reply("⏳ Casting your recall vote…");

  try {
    await ensureGasFunded(account);
    await adapter.voteRecall(client, address, recallId, VOTE_CHOICES[choice]);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `✅ Voted *${choice}* on recall #${recallId}.`, { parse_mode: "Markdown" });
  } catch (err) {
    console.error(err);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `Couldn't vote: ${err.shortMessage || err.message}`);
  }
});

bot.command("finalizerecall", async (ctx) => {
  const address = await requireDAO(ctx);
  if (!address) return;
  if (!isWalletDerivationConfigured()) {
    await ctx.reply("Wallets aren't set up on this bot yet - ask an admin to configure MASTER_WALLET_SEED.");
    return;
  }

  const model = getChatModel(ctx.chat.id);
  const adapter = getAdapter(model);
  if (typeof adapter.finalizeRecall !== "function") {
    await ctx.reply(`This DAO uses ${model} governance, which has no recall.`);
    return;
  }

  const recallId = ctx.match?.trim();
  if (!recallId || !/^\d+$/.test(recallId)) {
    await ctx.reply("Usage: `/finalizerecall <recallId>` — closes voting and removes the council member if the recall passed.", { parse_mode: "Markdown" });
    return;
  }

  const account = deriveUserWallet(ctx.from.id);
  const client = walletClientFor(account);
  const statusMsg = await ctx.reply("⏳ Finalizing the recall…");

  try {
    await ensureGasFunded(account);
    await adapter.finalizeRecall(client, address, recallId);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, "✅ Recall finalized. Use /council to check the roster.");
  } catch (err) {
    console.error(err);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `Couldn't finalize the recall: ${err.shortMessage || err.message}`);
  }
});

/*//////////////////////////////////////////////////////////////
    SOWELLIAN LIFECYCLE - approval vote, positions, both
    resolution tracks, adjudication, settlement
//////////////////////////////////////////////////////////////*/

const OUTCOME_CHOICES = { success: 1, failure: 2 }; // Outcome.Unresolved (0) deliberately excluded - invalid for these calls

bot.command("castapprovalvote", async (ctx) => {
  const address = await requireDAO(ctx);
  if (!address) return;
  if (!isWalletDerivationConfigured()) {
    await ctx.reply("Wallets aren't set up on this bot yet - ask an admin to configure MASTER_WALLET_SEED.");
    return;
  }

  const model = getChatModel(ctx.chat.id);
  const adapter = getAdapter(model);
  if (typeof adapter.castApprovalVote !== "function") {
    await ctx.reply(`This DAO uses ${model} governance, which has no approval vote.`);
    return;
  }

  const [id, choiceRaw] = (ctx.match?.trim() ?? "").split(/\s+/);
  const choice = choiceRaw?.toLowerCase();
  if (!id || !/^\d+$/.test(id) || !(choice in VOTE_CHOICES)) {
    await ctx.reply("Usage: `/castapprovalvote <id> for|against|abstain` — votes on whether a proposal opens for betting.", { parse_mode: "Markdown" });
    return;
  }

  const account = deriveUserWallet(ctx.from.id);
  const client = walletClientFor(account);
  const statusMsg = await ctx.reply("⏳ Casting approval vote…");

  try {
    await ensureGasFunded(account);
    await adapter.castApprovalVote(client, address, id, VOTE_CHOICES[choice]);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `✅ Voted *${choice}* on proposal #${id}'s approval.`, { parse_mode: "Markdown" });
  } catch (err) {
    console.error(err);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `Couldn't vote: ${err.shortMessage || err.message}`);
  }
});

bot.command("finalizeapproval", async (ctx) => {
  const address = await requireDAO(ctx);
  if (!address) return;
  if (!isWalletDerivationConfigured()) {
    await ctx.reply("Wallets aren't set up on this bot yet - ask an admin to configure MASTER_WALLET_SEED.");
    return;
  }

  const model = getChatModel(ctx.chat.id);
  const adapter = getAdapter(model);
  if (typeof adapter.finalizeApproval !== "function") {
    await ctx.reply(`This DAO uses ${model} governance, which has no approval vote.`);
    return;
  }

  const id = ctx.match?.trim();
  if (!id || !/^\d+$/.test(id)) {
    await ctx.reply("Usage: `/finalizeapproval <id>` — closes the approval vote and opens the positions market if it passed.", { parse_mode: "Markdown" });
    return;
  }

  const account = deriveUserWallet(ctx.from.id);
  const client = walletClientFor(account);
  const statusMsg = await ctx.reply("⏳ Finalizing approval…");

  try {
    await ensureGasFunded(account);
    await adapter.finalizeApproval(client, address, id);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `✅ Approval finalized for proposal #${id}. Check /proposal ${id} for the outcome.`);
  } catch (err) {
    console.error(err);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `Couldn't finalize: ${err.shortMessage || err.message}`);
  }
});

bot.command("takeposition", async (ctx) => {
  const address = await requireDAO(ctx);
  if (!address) return;
  if (!isWalletDerivationConfigured()) {
    await ctx.reply("Wallets aren't set up on this bot yet - ask an admin to configure MASTER_WALLET_SEED.");
    return;
  }

  const model = getChatModel(ctx.chat.id);
  const adapter = getAdapter(model);
  if (typeof adapter.takePosition !== "function") {
    await ctx.reply(`This DAO uses ${model} governance, which has no positions market.`);
    return;
  }

  const [id, sideRaw, amount] = (ctx.match?.trim() ?? "").split(/\s+/);
  const side = sideRaw?.toLowerCase();
  if (!id || !/^\d+$/.test(id) || (side !== "yes" && side !== "no") || !amount || Number.isNaN(Number(amount)) || Number(amount) <= 0) {
    await ctx.reply(
      "Usage: `/takeposition <id> yes|no <amount>` — backs the metric ending up true (yes) or false (no). Positions can only grow, never shrink.",
      { parse_mode: "Markdown" }
    );
    return;
  }

  const account = deriveUserWallet(ctx.from.id);
  const client = walletClientFor(account);
  const statusMsg = await ctx.reply("⏳ Taking your position…");

  try {
    await ensureGasFunded(account);
    await adapter.takePosition(client, address, id, side === "yes" ? 0 : 1, amount);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `✅ Backed *${side}* on proposal #${id} with ${amount} tokens.`, { parse_mode: "Markdown" });
  } catch (err) {
    console.error(err);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `Couldn't take that position: ${err.shortMessage || err.message}`);
  }
});

bot.command("resolveviaoracle", async (ctx) => {
  const address = await requireDAO(ctx);
  if (!address) return;
  if (!isWalletDerivationConfigured()) {
    await ctx.reply("Wallets aren't set up on this bot yet - ask an admin to configure MASTER_WALLET_SEED.");
    return;
  }

  const model = getChatModel(ctx.chat.id);
  const adapter = getAdapter(model);
  if (typeof adapter.resolveViaOracle !== "function") {
    await ctx.reply(`This DAO uses ${model} governance, which has no oracle-track resolution.`);
    return;
  }

  const id = ctx.match?.trim();
  if (!id || !/^\d+$/.test(id)) {
    await ctx.reply("Usage: `/resolveviaoracle <id>` — reads the proposal's configured oracle and finalizes automatically.", { parse_mode: "Markdown" });
    return;
  }

  const account = deriveUserWallet(ctx.from.id);
  const client = walletClientFor(account);
  const statusMsg = await ctx.reply("⏳ Reading the oracle and resolving…");

  try {
    await ensureGasFunded(account);
    await adapter.resolveViaOracle(client, address, id);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `✅ Proposal #${id} resolved via oracle. Use /claimposition ${id} to collect a winning position.`);
  } catch (err) {
    console.error(err);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `Couldn't resolve: ${err.shortMessage || err.message}`);
  }
});

bot.command("proposeresolution", async (ctx) => {
  const address = await requireDAO(ctx);
  if (!address) return;
  if (!isWalletDerivationConfigured()) {
    await ctx.reply("Wallets aren't set up on this bot yet - ask an admin to configure MASTER_WALLET_SEED.");
    return;
  }

  const model = getChatModel(ctx.chat.id);
  const adapter = getAdapter(model);
  if (typeof adapter.proposeResolution !== "function") {
    await ctx.reply(`This DAO uses ${model} governance, which has no human-track resolution.`);
    return;
  }

  const [id, outcomeRaw] = (ctx.match?.trim() ?? "").split(/\s+/);
  const outcome = outcomeRaw?.toLowerCase();
  if (!id || !/^\d+$/.test(id) || !(outcome in OUTCOME_CHOICES)) {
    await ctx.reply(
      "Usage: `/proposeresolution <id> success|failure` — states what you believe the real outcome was, posting a bond. Others can dispute within the challenge window.",
      { parse_mode: "Markdown" }
    );
    return;
  }

  const account = deriveUserWallet(ctx.from.id);
  const client = walletClientFor(account);
  const statusMsg = await ctx.reply("⏳ Proposing resolution…");

  try {
    await ensureGasFunded(account);
    await adapter.proposeResolution(client, address, id, OUTCOME_CHOICES[outcome]);
    await ctx.api.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      `✅ Proposed *${outcome}* for proposal #${id}. If unchallenged, run /finalizeunchallenged ${id} once the window closes.`,
      { parse_mode: "Markdown" }
    );
  } catch (err) {
    console.error(err);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `Couldn't propose a resolution: ${err.shortMessage || err.message}`);
  }
});

bot.command("challengeresolution", async (ctx) => {
  const address = await requireDAO(ctx);
  if (!address) return;
  if (!isWalletDerivationConfigured()) {
    await ctx.reply("Wallets aren't set up on this bot yet - ask an admin to configure MASTER_WALLET_SEED.");
    return;
  }

  const model = getChatModel(ctx.chat.id);
  const adapter = getAdapter(model);
  if (typeof adapter.challengeResolution !== "function") {
    await ctx.reply(`This DAO uses ${model} governance, which has no resolution to dispute.`);
    return;
  }

  const id = ctx.match?.trim();
  if (!id || !/^\d+$/.test(id)) {
    await ctx.reply(
      "Usage: `/challengeresolution <id>` — disputes a proposed resolution, posting a bond and opening the adjudication vote.",
      { parse_mode: "Markdown" }
    );
    return;
  }

  const account = deriveUserWallet(ctx.from.id);
  const client = walletClientFor(account);
  const statusMsg = await ctx.reply("⏳ Challenging the resolution…");

  try {
    await ensureGasFunded(account);
    await adapter.challengeResolution(client, address, id);
    await ctx.api.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      `✅ Resolution challenged for proposal #${id}. Adjudication vote is open - use /castadjudicationvote ${id} success|failure.`
    );
  } catch (err) {
    console.error(err);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `Couldn't challenge: ${err.shortMessage || err.message}`);
  }
});

bot.command("finalizeunchallenged", async (ctx) => {
  const address = await requireDAO(ctx);
  if (!address) return;
  if (!isWalletDerivationConfigured()) {
    await ctx.reply("Wallets aren't set up on this bot yet - ask an admin to configure MASTER_WALLET_SEED.");
    return;
  }

  const model = getChatModel(ctx.chat.id);
  const adapter = getAdapter(model);
  if (typeof adapter.finalizeUnchallenged !== "function") {
    await ctx.reply(`This DAO uses ${model} governance - for optimistic proposals, use /queue instead, which handles this automatically.`);
    return;
  }

  const id = ctx.match?.trim();
  if (!id || !/^\d+$/.test(id)) {
    await ctx.reply("Usage: `/finalizeunchallenged <id>` — finalizes a resolution that went unchallenged through its full window.", { parse_mode: "Markdown" });
    return;
  }

  const account = deriveUserWallet(ctx.from.id);
  const client = walletClientFor(account);
  const statusMsg = await ctx.reply("⏳ Finalizing…");

  try {
    await ensureGasFunded(account);
    await adapter.finalizeUnchallenged(client, address, id);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `✅ Proposal #${id} finalized as originally proposed.`);
  } catch (err) {
    console.error(err);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `Couldn't finalize: ${err.shortMessage || err.message}`);
  }
});

bot.command("castadjudicationvote", async (ctx) => {
  const address = await requireDAO(ctx);
  if (!address) return;
  if (!isWalletDerivationConfigured()) {
    await ctx.reply("Wallets aren't set up on this bot yet - ask an admin to configure MASTER_WALLET_SEED.");
    return;
  }

  const model = getChatModel(ctx.chat.id);
  const adapter = getAdapter(model);
  if (typeof adapter.castAdjudicationVote !== "function") {
    await ctx.reply(`This DAO uses ${model} governance, which has no adjudication vote.`);
    return;
  }

  const [id, outcomeRaw] = (ctx.match?.trim() ?? "").split(/\s+/);
  const outcome = outcomeRaw?.toLowerCase();
  if (!id || !/^\d+$/.test(id) || !(outcome in OUTCOME_CHOICES)) {
    await ctx.reply("Usage: `/castadjudicationvote <id> success|failure` — votes on the true outcome of a disputed resolution.", { parse_mode: "Markdown" });
    return;
  }

  const account = deriveUserWallet(ctx.from.id);
  const client = walletClientFor(account);
  const statusMsg = await ctx.reply("⏳ Casting adjudication vote…");

  try {
    await ensureGasFunded(account);
    await adapter.castAdjudicationVote(client, address, id, OUTCOME_CHOICES[outcome]);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `✅ Voted *${outcome}* on proposal #${id}'s adjudication.`, { parse_mode: "Markdown" });
  } catch (err) {
    console.error(err);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `Couldn't vote: ${err.shortMessage || err.message}`);
  }
});

bot.command("finalizeadjudication", async (ctx) => {
  const address = await requireDAO(ctx);
  if (!address) return;
  if (!isWalletDerivationConfigured()) {
    await ctx.reply("Wallets aren't set up on this bot yet - ask an admin to configure MASTER_WALLET_SEED.");
    return;
  }

  const model = getChatModel(ctx.chat.id);
  const adapter = getAdapter(model);
  if (typeof adapter.finalizeAdjudication !== "function") {
    await ctx.reply(`This DAO uses ${model} governance, which has no adjudication vote.`);
    return;
  }

  const id = ctx.match?.trim();
  if (!id || !/^\d+$/.test(id)) {
    await ctx.reply("Usage: `/finalizeadjudication <id>` — closes the adjudication vote and settles the resolver/challenger bonds.", { parse_mode: "Markdown" });
    return;
  }

  const account = deriveUserWallet(ctx.from.id);
  const client = walletClientFor(account);
  const statusMsg = await ctx.reply("⏳ Finalizing adjudication…");

  try {
    await ensureGasFunded(account);
    await adapter.finalizeAdjudication(client, address, id);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `✅ Adjudication finalized for proposal #${id}. Use /claimposition ${id} to collect a winning position.`);
  } catch (err) {
    console.error(err);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `Couldn't finalize: ${err.shortMessage || err.message}`);
  }
});

bot.command("claimposition", async (ctx) => {
  const address = await requireDAO(ctx);
  if (!address) return;
  if (!isWalletDerivationConfigured()) {
    await ctx.reply("Wallets aren't set up on this bot yet - ask an admin to configure MASTER_WALLET_SEED.");
    return;
  }

  const model = getChatModel(ctx.chat.id);
  const adapter = getAdapter(model);
  if (typeof adapter.claimPosition !== "function") {
    await ctx.reply(`This DAO uses ${model} governance, which has no positions to claim.`);
    return;
  }

  const id = ctx.match?.trim();
  if (!id || !/^\d+$/.test(id)) {
    await ctx.reply("Usage: `/claimposition <id>` — collects your share of the pool if you backed the winning side.", { parse_mode: "Markdown" });
    return;
  }

  const account = deriveUserWallet(ctx.from.id);
  const client = walletClientFor(account);
  const statusMsg = await ctx.reply("⏳ Claiming…");

  try {
    await ensureGasFunded(account);
    await adapter.claimPosition(client, address, id);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `✅ Position claimed for proposal #${id}.`);
  } catch (err) {
    console.error(err);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `Couldn't claim: ${err.shortMessage || err.message}`);
  }
});

/*//////////////////////////////////////////////////////////////
    DECISION MARKETS - trade, finalize, reclaim liquidity
//////////////////////////////////////////////////////////////*/

bot.command("trade", async (ctx) => {
  const address = await requireDAO(ctx);
  if (!address) return;
  if (!isWalletDerivationConfigured()) {
    await ctx.reply("Wallets aren't set up on this bot yet - ask an admin to configure MASTER_WALLET_SEED.");
    return;
  }

  const model = getChatModel(ctx.chat.id);
  const adapter = getAdapter(model);
  if (typeof adapter.trade !== "function") {
    await ctx.reply(`This DAO uses ${model} governance, which has no trading markets.`);
    return;
  }

  // Format: /trade <id> pass|fail base|quote <amountIn> <minAmountOut>
  const [id, marketRaw, sideRaw, amountIn, minAmountOut] = (ctx.match?.trim() ?? "").split(/\s+/);
  const marketChoice = marketRaw?.toLowerCase();
  const sideChoice = sideRaw?.toLowerCase();
  const valid =
    id && /^\d+$/.test(id) &&
    (marketChoice === "pass" || marketChoice === "fail") &&
    (sideChoice === "base" || sideChoice === "quote") &&
    amountIn && !Number.isNaN(Number(amountIn)) && Number(amountIn) > 0 &&
    minAmountOut !== undefined && !Number.isNaN(Number(minAmountOut)) && Number(minAmountOut) >= 0;

  if (!valid) {
    await ctx.reply(
      [
        "Usage: `/trade <id> pass|fail base|quote <amountIn> <minAmountOut>`",
        "",
        "`pass`/`fail` picks which market; `base`/`quote` picks which conditional token you're selling (base = the DAO token side, quote = the MON side).",
        "`minAmountOut` is real slippage protection - never leave it at 0 in practice.",
      ].join("\n"),
      { parse_mode: "Markdown" }
    );
    return;
  }

  const account = deriveUserWallet(ctx.from.id);
  const client = walletClientFor(account);
  const statusMsg = await ctx.reply("⏳ Trading…");

  try {
    await ensureGasFunded(account);
    await adapter.trade(
      client,
      address,
      id,
      marketChoice === "pass" ? 0 : 1,
      sideChoice === "base" ? 0 : 1,
      amountIn,
      minAmountOut
    );
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `✅ Traded on the *${marketChoice}* market for proposal #${id}.`, { parse_mode: "Markdown" });
  } catch (err) {
    console.error(err);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `Couldn't trade: ${err.shortMessage || err.message}`);
  }
});

bot.command("finalizeproposal", async (ctx) => {
  const address = await requireDAO(ctx);
  if (!address) return;
  if (!isWalletDerivationConfigured()) {
    await ctx.reply("Wallets aren't set up on this bot yet - ask an admin to configure MASTER_WALLET_SEED.");
    return;
  }

  const model = getChatModel(ctx.chat.id);
  const adapter = getAdapter(model);
  if (typeof adapter.finalizeProposal !== "function") {
    await ctx.reply(`This DAO uses ${model} governance, which has no trading markets to finalize.`);
    return;
  }

  const id = ctx.match?.trim();
  if (!id || !/^\d+$/.test(id)) {
    await ctx.reply("Usage: `/finalizeproposal <id>` — compares both markets' TWAP and resolves pass or fail. Callable by anyone once trading closes.", { parse_mode: "Markdown" });
    return;
  }

  const account = deriveUserWallet(ctx.from.id);
  const client = walletClientFor(account);
  const statusMsg = await ctx.reply("⏳ Comparing market prices and finalizing…");

  try {
    await ensureGasFunded(account);
    await adapter.finalizeProposal(client, address, id);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `✅ Proposal #${id} finalized. Check /proposal ${id} for whether it passed.`);
  } catch (err) {
    console.error(err);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `Couldn't finalize: ${err.shortMessage || err.message}`);
  }
});

bot.command("reclaimliquidity", async (ctx) => {
  const address = await requireDAO(ctx);
  if (!address) return;
  if (!isWalletDerivationConfigured()) {
    await ctx.reply("Wallets aren't set up on this bot yet - ask an admin to configure MASTER_WALLET_SEED.");
    return;
  }

  const model = getChatModel(ctx.chat.id);
  const adapter = getAdapter(model);
  if (typeof adapter.reclaimLiquidity !== "function") {
    await ctx.reply(`This DAO uses ${model} governance, which has no seed liquidity to reclaim.`);
    return;
  }

  const id = ctx.match?.trim();
  if (!id || !/^\d+$/.test(id)) {
    await ctx.reply("Usage: `/reclaimliquidity <id>` — recovers a finalized proposal's seed liquidity back to its original proposer.", { parse_mode: "Markdown" });
    return;
  }

  const account = deriveUserWallet(ctx.from.id);
  const client = walletClientFor(account);
  const statusMsg = await ctx.reply("⏳ Reclaiming liquidity…");

  try {
    await ensureGasFunded(account);
    await adapter.reclaimLiquidity(client, address, id);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `✅ Seed liquidity for proposal #${id} reclaimed.`);
  } catch (err) {
    console.error(err);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `Couldn't reclaim: ${err.shortMessage || err.message}`);
  }
});

bot.command("unstake", async (ctx) => {
  const address = await requireDAO(ctx);
  if (!address) return;
  if (!isWalletDerivationConfigured()) {
    await ctx.reply("Wallets aren't set up on this bot yet - ask an admin to configure MASTER_WALLET_SEED.");
    return;
  }

  const model = getChatModel(ctx.chat.id);
  if (!hasToken(model)) {
    await ctx.reply(
      `This DAO uses ${model} governance, which has no token or staking - signers act directly. There's nothing to unstake here.`
    );
    return;
  }

  const amountStr = ctx.match?.trim();
  const amount = Number(amountStr);
  if (!amountStr || !Number.isFinite(amount) || amount <= 0) {
    await ctx.reply("Usage: `/unstake 50` — returns 50 of your staked tokens to your liquid balance.", {
      parse_mode: "Markdown",
    });
    return;
  }

  const account = deriveUserWallet(ctx.from.id);
  const client = walletClientFor(account);
  const statusMsg = await ctx.reply("⏳ Unstaking — this takes a moment…");

  try {
    await ensureGasFunded(account);
    const tokenAddress = await getGovernanceTokenAddress(model, address);
    await unstakeTokens(client, tokenAddress, amount);

    await ctx.api.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      `✅ Unstaked ${amount} tokens back to your liquid balance.`
    );
  } catch (err) {
    console.error(err);
    await ctx.api.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      `Couldn't unstake: ${err.shortMessage || err.message}`
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