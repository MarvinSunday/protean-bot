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

const abi = loadAbi("SortitionGovernance");

function contractFor(address) {
  return { address: getAddress(address), abi };
}

/**
 * Adapter for SortitionGovernance. Superficially similar to
 * delegate.js - both have a "council" that proposes and votes - but two
 * real differences, confirmed directly from source rather than assumed
 * from the similar naming:
 *
 * 1. queue/execute/cancel use the STANDARD names here (queueProposal,
 *    executeProposal, cancelProposal), NOT Delegate's *CouncilProposal
 *    versions. Only propose/vote keep the "Council" name
 *    (proposeCouncilAction/castCouncilVote).
 *
 * 2. proposeCouncilAction has NO onlyCouncilMember restriction here -
 *    anyone meeting the configured eligibilityThreshold can propose,
 *    not just sitting council members. Only castCouncilVote is actually
 *    restricted to the current council. Delegate restricts both.
 *
 * Council selection itself is a genuinely different mechanism from
 * every other model: no election, no voting for candidates - eligible
 * token holders opt into a pool (registerEligible), and the council is
 * drawn from that pool via a verifiable random shuffle
 * (startSortition/finalizeSortition), using whatever IRandomnessSource
 * this DAO was deployed with. There is no recall mechanism here, unlike
 * DelegateGovernance.
 *
 * Vote weight on getProposal is "councilVoteCount", same category as
 * delegate.js - forVotes/against/abstain are a plain uint16 headcount
 * of council members, confirmed from source, not token-weighted.
 */

export async function propose(client, governanceAddress, actions, metadataURI) {
  const gov = contractFor(governanceAddress);

  const hash = await client.writeContract({
    ...gov,
    functionName: "proposeCouncilAction",
    args: [actions, metadataURI],
  });
  await publicClient.waitForTransactionReceipt({ hash });

  const proposalId = await publicClient.readContract({ ...gov, functionName: "proposalCount" });

  return { hash, proposalId };
}

/**
 * `reason` is accepted for shared-interface consistency but has no
 * equivalent here - silently ignored. Only current council members can
 * actually call this - a non-council caller gets a real on-chain revert,
 * even though propose() itself has no such restriction.
 */
export async function vote(client, governanceAddress, proposalId, support, _reason) {
  const gov = contractFor(governanceAddress);

  const hash = await client.writeContract({
    ...gov,
    functionName: "castCouncilVote",
    args: [BigInt(proposalId), support],
  });
  await publicClient.waitForTransactionReceipt({ hash });
  return { hash };
}

export async function queue(client, governanceAddress, proposalId) {
  const gov = contractFor(governanceAddress);

  const hash = await client.writeContract({
    ...gov,
    functionName: "queueProposal",
    args: [BigInt(proposalId)],
  });
  await publicClient.waitForTransactionReceipt({ hash });
  return { hash };
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
 * Read-only. No quorumVotes field - same situation as quadratic.js/
 * liquid.js, no per-proposal quorum view exposed by the contract.
 */
export async function getProposal(governanceAddress, proposalId) {
  const gov = contractFor(governanceAddress);

  const [proposal, stateIndex, executableAfter] = await Promise.all([
    publicClient.readContract({ ...gov, functionName: "getProposal", args: [BigInt(proposalId)] }),
    publicClient.readContract({ ...gov, functionName: "state", args: [BigInt(proposalId)] }),
    publicClient.readContract({ ...gov, functionName: "executableAfter", args: [BigInt(proposalId)] }),
  ]);

  return {
    ...proposal,
    stateIndex: Number(stateIndex),
    executableAfter,
    voteWeightUnit: "councilVoteCount",
  };
}

/*//////////////////////////////////////////////////////////////
    MODEL-SPECIFIC EXTRAS - eligibility pool, open to any
    qualifying token holder
//////////////////////////////////////////////////////////////*/

/** Opts the caller into the eligible pool for future sortition draws. */
export async function registerEligible(client, governanceAddress) {
  const gov = contractFor(governanceAddress);
  const hash = await client.writeContract({ ...gov, functionName: "registerEligible", args: [] });
  await publicClient.waitForTransactionReceipt({ hash });
  return { hash };
}

/**
 * Removes the caller from the eligible pool. Does not remove them from
 * a council they're already serving on - confirmed directly from the
 * contract's own doc comment.
 */
export async function withdrawEligibility(client, governanceAddress) {
  const gov = contractFor(governanceAddress);
  const hash = await client.writeContract({ ...gov, functionName: "withdrawEligibility", args: [] });
  await publicClient.waitForTransactionReceipt({ hash });
  return { hash };
}

/*//////////////////////////////////////////////////////////////
    MODEL-SPECIFIC EXTRAS - the sortition draw itself
//////////////////////////////////////////////////////////////*/

/**
 * Starts a new sortition round - requests randomness from this DAO's
 * configured IRandomnessSource. Only callable once the current term has
 * ended and the eligible pool is non-empty; both checked on-chain.
 */
export async function startSortition(client, governanceAddress) {
  const gov = contractFor(governanceAddress);
  const hash = await client.writeContract({ ...gov, functionName: "startSortition", args: [] });
  await publicClient.waitForTransactionReceipt({ hash });

  const round = await publicClient.readContract({ ...gov, functionName: "sortitionRound" });
  return { hash, round };
}

/**
 * Finalizes the active sortition round once its randomness request has
 * been fulfilled - draws the new council via an unbiased shuffle seeded
 * by the verified random value. Reverts if the randomness source hasn't
 * fulfilled the request yet; the caller (or the bot's command handler)
 * is expected to retry later rather than this function polling.
 */
export async function finalizeSortition(client, governanceAddress) {
  const gov = contractFor(governanceAddress);
  const hash = await client.writeContract({ ...gov, functionName: "finalizeSortition", args: [] });
  await publicClient.waitForTransactionReceipt({ hash });
  return { hash };
}

/** Read-only: the current council roster. */
export async function getCouncil(governanceAddress) {
  const gov = contractFor(governanceAddress);
  return publicClient.readContract({ ...gov, functionName: "getCouncil", args: [] });
}

/** Read-only: everyone currently opted into the eligible pool. */
export async function getEligiblePool(governanceAddress) {
  const gov = contractFor(governanceAddress);
  return publicClient.readContract({ ...gov, functionName: "getEligiblePool", args: [] });
}
