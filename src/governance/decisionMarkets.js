import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getAddress, parseEther } from "viem";
import { publicClient } from "../config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadAbi(name) {
  const raw = fs.readFileSync(path.join(__dirname, "..", "abis", `${name}.json`), "utf8");
  return JSON.parse(raw);
}

const abi = loadAbi("DecisionMarketsGovernance");

function contractFor(address) {
  return { address: getAddress(address), abi };
}

/**
 * Adapter for DecisionMarketsGovernance - the one model with no vote of
 * any kind, confirmed directly from source: no castVote, no support(),
 * no confirmations, nothing. A proposal's two possible outcomes each
 * get their own live trading market (deployed and seeded inside
 * propose() itself); people trade whichever side they believe in; and
 * finalizeProposal() compares the two markets' time-weighted average
 * prices - pass must exceed fail's TWAP by the configured threshold.
 * No oracle, no resolver, no challenge - the price comparison itself is
 * the entire verdict.
 *
 * Three of five shared-interface functions throw explicitly:
 *
 * - propose() throws: the real propose() needs a third parameter
 *   (baseSeedAmount) and is itself payable (msg.value supplies the
 *   quote-side WMON seed) - genuinely doesn't fit the standard
 *   4-argument, non-payable shape. Use proposeWithSeed() instead.
 *
 * - vote() throws: there is nothing to vote on. Use trade() to actually
 *   participate in either market.
 *
 * - queue() throws: there is no separate queueProposal - finalizeProposal()
 *   itself sets the queued timestamp directly the moment it determines
 *   the proposal passed. Nothing else to call.
 *
 * execute() and cancel() both map directly - same names, same shapes,
 * standard timelock-gated execution once finalized and passed.
 *
 * trade()'s closed-window revert previously reused finalizeProposal()'s
 * TradingWindowStillOpen error, which was misleadingly named for that
 * usage (the actual condition being checked was correct throughout -
 * only the shared name was confusing). Fixed at the contract level:
 * trade() now reverts with its own TradingWindowClosed instead. Nothing
 * in this adapter needed to change as a result - it never referenced
 * the specific error name, only let reverts surface as-is - but the ABI
 * above was regenerated to include the new error.
 */

export async function propose() {
  throw new Error(
    "DecisionMarketsGovernance's propose() takes a required baseSeedAmount and is itself payable " +
      "(msg.value supplies the quote-side WMON seed) - use proposeWithSeed() instead, which exposes " +
      "the real signature."
  );
}

export async function vote() {
  throw new Error(
    "DecisionMarketsGovernance has no voting at all - a proposal's fate is decided by comparing two " +
      "live markets' prices. Use trade() to actually back the outcome you believe in."
  );
}

export async function queue() {
  throw new Error(
    "DecisionMarketsGovernance has no separate queue step - finalizeProposal() itself queues the " +
      "proposal the moment it determines the pass market's TWAP beat the fail market's by enough."
  );
}

export async function execute(client, governanceAddress, proposalId, valueWhole = 0) {
  const gov = contractFor(governanceAddress);

  const hash = await client.writeContract({
    ...gov,
    functionName: "executeProposal",
    args: [BigInt(proposalId)],
    value: parseEther(String(valueWhole)),
  });
  await publicClient.waitForTransactionReceipt({ hash });
  return { hash };
}

export async function cancel(client, governanceAddress, proposalId) {
  const gov = contractFor(governanceAddress);

  const hash = await client.writeContract({
    ...gov,
    functionName: "cancelProposal",
    args: [BigInt(proposalId)],
  });
  await publicClient.waitForTransactionReceipt({ hash });
  return { hash };
}

/**
 * Read-only. No forVotes/against/abstain, no phase enum at all - status
 * is derived here from the struct's own boolean flags, since the
 * contract itself exposes no single state()/phase value. "Open" covers
 * both "still trading" and "trading closed but not yet finalized" -
 * genuinely indistinguishable from these fields alone without comparing
 * tradingDeadline against the current time, which this function
 * deliberately does not do (avoiding an extra RPC call here) - both
 * tradingDeadline and the current proposal fields are returned raw so a
 * caller who needs that distinction can compute it themselves.
 */
export async function getProposal(governanceAddress, proposalId) {
  const gov = contractFor(governanceAddress);

  const proposal = await publicClient.readContract({ ...gov, functionName: "getProposal", args: [BigInt(proposalId)] });

  let statusLabel;
  if (proposal.cancelled) statusLabel = "Cancelled";
  else if (proposal.executed) statusLabel = "Executed";
  else if (!proposal.finalized) statusLabel = "Open"; // trading or awaiting finalization - see doc comment
  else if (!proposal.passed) statusLabel = "Failed";
  else statusLabel = "Queued"; // finalized, passed, not yet executed

  return {
    ...proposal,
    statusLabel,
  };
}

/*//////////////////////////////////////////////////////////////
    MODEL-SPECIFIC EXTRAS
//////////////////////////////////////////////////////////////*/

/**
 * The real propose() - deploys and seeds both markets in this one call.
 * `baseSeedAmountWhole` is the DAO governance token seed (pulled via
 * transferFrom, so the caller must have approved this contract first);
 * `quoteSeedAmountWhole` is the native MON seed, sent as msg.value and
 * wrapped into WMON internally.
 */
export async function proposeWithSeed(
  client,
  governanceAddress,
  actions,
  metadataURI,
  baseSeedAmountWhole,
  quoteSeedAmountWhole
) {
  const gov = contractFor(governanceAddress);

  const hash = await client.writeContract({
    ...gov,
    functionName: "propose",
    args: [actions, metadataURI, parseEther(String(baseSeedAmountWhole))],
    value: parseEther(String(quoteSeedAmountWhole)),
  });
  await publicClient.waitForTransactionReceipt({ hash });

  const proposalId = await publicClient.readContract({ ...gov, functionName: "proposalCount" });
  return { hash, proposalId };
}

/**
 * Trades in one of the two markets. `market`: 0 = Pass, 1 = Fail.
 * `sideIn`: 0 = Base (the DAO token side), 1 = Quote (the WMON side) -
 * whichever conditional token the caller is selling. The caller must
 * already hold that conditional token (acquired by splitting real
 * tokens via the relevant ConditionalVault - not something this
 * function does for them). `minAmountOutWhole` is real slippage
 * protection, not optional in spirit even though the contract accepts
 * any value including 0 - always supply a real minimum in production
 * use.
 */
export async function trade(client, governanceAddress, proposalId, market, sideIn, amountInWhole, minAmountOutWhole) {
  const gov = contractFor(governanceAddress);

  const hash = await client.writeContract({
    ...gov,
    functionName: "trade",
    args: [BigInt(proposalId), market, sideIn, parseEther(String(amountInWhole)), parseEther(String(minAmountOutWhole))],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  return { hash, receipt };
}

/** Reads both markets' TWAP, compares them against the configured threshold, and resolves both vaults. Permissionless, callable by anyone once trading has closed. */
export async function finalizeProposal(client, governanceAddress, proposalId) {
  const gov = contractFor(governanceAddress);
  const hash = await client.writeContract({ ...gov, functionName: "finalizeProposal", args: [BigInt(proposalId)] });
  await publicClient.waitForTransactionReceipt({ hash });
  return { hash };
}

/**
 * Recovers this contract's seed liquidity from a finalized proposal's
 * two pools and sends it to the proposer - permissionless, callable
 * once per proposal, any time after finalization regardless of whether
 * the proposal passed, failed, or was ever executed.
 */
export async function reclaimLiquidity(client, governanceAddress, proposalId) {
  const gov = contractFor(governanceAddress);
  const hash = await client.writeContract({ ...gov, functionName: "reclaimLiquidity", args: [BigInt(proposalId)] });
  await publicClient.waitForTransactionReceipt({ hash });
  return { hash };
}

/** Read-only: this DAO's shared WMON address. */
export async function getWmon(governanceAddress) {
  const gov = contractFor(governanceAddress);
  return publicClient.readContract({ ...gov, functionName: "wmon", args: [] });
}
