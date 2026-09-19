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

const abi = loadAbi("DelegateGovernance");

function contractFor(address) {
  return { address: getAddress(address), abi };
}

/**
 * Adapter for DelegateGovernance - the biggest one in this system so
 * far. Three genuinely separate mechanisms live on this one contract:
 *
 * 1. Council proposals - the shared propose/vote/queue/execute/cancel
 *    interface, mapped onto this contract's *CouncilAction/*CouncilVote
 *    function names. Restricted to council members only, confirmed
 *    directly from source (onlyCouncilMember on both proposeCouncilAction
 *    and castCouncilVote) - a non-council caller gets a real on-chain
 *    revert here, not a bot-side check.
 *
 * 2. Elections - open to every token holder, not just the council.
 *    declareCandidacy/voteInElection/finalizeElection have no equivalent
 *    in any other model, so they're exposed as extras outside the shared
 *    interface.
 *
 * 3. Recall - also open to every token holder, a separate token-weighted
 *    vote to remove a sitting council member early. Also extras.
 *
 * IMPORTANT vote-weight distinction: council proposal votes
 * (forVotes/against/abstain on getProposal) are a plain uint16 headcount
 * of council members - NOT a token amount and NOT sqrt-weighted, a third
 * category distinct from every other adapter's voteWeightUnit. Election
 * votes and recall votes ARE real token-weighted amounts (confirmed from
 * source: getPastVotes for elections, uint256 totals for recall) - do
 * not conflate these three different vote-weight scales living on the
 * same contract.
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
 * equivalent here - silently ignored. Only council members can actually
 * call this - a non-council caller gets a real on-chain revert.
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
    functionName: "queueCouncilProposal",
    args: [BigInt(proposalId)],
  });
  await publicClient.waitForTransactionReceipt({ hash });
  return { hash };
}

export async function execute(client, governanceAddress, proposalId, valueWhole = 0) {
  const gov = contractFor(governanceAddress);

  const hash = await client.writeContract({
    ...gov,
    functionName: "executeCouncilProposal",
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
    functionName: "cancelCouncilProposal",
    args: [BigInt(proposalId)],
  });
  await publicClient.waitForTransactionReceipt({ hash });
  return { hash };
}

/**
 * Read-only. voteWeightUnit is "councilVoteCount" here, not "token" or
 * "sqrtWeight" - forVotes/against/abstain are a plain headcount of
 * council members (max value bounded by councilSize), never safe to
 * formatEther. Display these as plain integers, e.g. "3 of 5 council
 * members voted For."
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
    MODEL-SPECIFIC EXTRAS - elections, open to every token holder
//////////////////////////////////////////////////////////////*/

/** Opens a new election - only callable once the current term has ended. */
export async function startElection(client, governanceAddress) {
  const gov = contractFor(governanceAddress);
  const hash = await client.writeContract({ ...gov, functionName: "startElection", args: [] });
  await publicClient.waitForTransactionReceipt({ hash });

  const electionCount = await publicClient.readContract({ ...gov, functionName: "electionCount" });
  return { hash, electionId: electionCount };
}

/** Declares the caller's candidacy in an open election's candidacy window. */
export async function declareCandidacy(client, governanceAddress, electionId) {
  const gov = contractFor(governanceAddress);
  const hash = await client.writeContract({ ...gov, functionName: "declareCandidacy", args: [BigInt(electionId)] });
  await publicClient.waitForTransactionReceipt({ hash });
  return { hash };
}

/**
 * Votes for up to councilSize distinct candidates in an election, using
 * real token-weighted voting power (getPastVotes at the election's own
 * snapshot block - different snapshot from any council proposal's).
 */
export async function voteInElection(client, governanceAddress, electionId, candidateAddresses) {
  const gov = contractFor(governanceAddress);
  const hash = await client.writeContract({
    ...gov,
    functionName: "voteInElection",
    args: [BigInt(electionId), candidateAddresses.map(getAddress)],
  });
  await publicClient.waitForTransactionReceipt({ hash });
  return { hash };
}

/** Finalizes a closed election - top vote-getters become the new council. */
export async function finalizeElection(client, governanceAddress, electionId) {
  const gov = contractFor(governanceAddress);
  const hash = await client.writeContract({ ...gov, functionName: "finalizeElection", args: [BigInt(electionId)] });
  await publicClient.waitForTransactionReceipt({ hash });
  return { hash };
}

/** Read-only: full details of one election. */
export async function getElection(governanceAddress, electionId) {
  const gov = contractFor(governanceAddress);
  return publicClient.readContract({ ...gov, functionName: "getElection", args: [BigInt(electionId)] });
}

/*//////////////////////////////////////////////////////////////
    MODEL-SPECIFIC EXTRAS - recall, open to every token holder
//////////////////////////////////////////////////////////////*/

/** Starts a recall vote against a sitting council member. */
export async function initiateRecall(client, governanceAddress, delegateAddress) {
  const gov = contractFor(governanceAddress);
  const hash = await client.writeContract({
    ...gov,
    functionName: "initiateRecall",
    args: [getAddress(delegateAddress)],
  });
  await publicClient.waitForTransactionReceipt({ hash });

  const recallCount = await publicClient.readContract({ ...gov, functionName: "recallCount" });
  return { hash, recallId: recallCount };
}

/**
 * Votes on a recall - real token-weighted voting, same VoteType
 * enum (For/Against/Abstain) as everything else.
 */
export async function voteRecall(client, governanceAddress, recallId, support) {
  const gov = contractFor(governanceAddress);
  const hash = await client.writeContract({
    ...gov,
    functionName: "voteRecall",
    args: [BigInt(recallId), support],
  });
  await publicClient.waitForTransactionReceipt({ hash });
  return { hash };
}

/** Finalizes a closed recall vote - removes the delegate if it passed. */
export async function finalizeRecall(client, governanceAddress, recallId) {
  const gov = contractFor(governanceAddress);
  const hash = await client.writeContract({ ...gov, functionName: "finalizeRecall", args: [BigInt(recallId)] });
  await publicClient.waitForTransactionReceipt({ hash });
  return { hash };
}

/** Read-only: full details of one recall vote. */
export async function getRecall(governanceAddress, recallId) {
  const gov = contractFor(governanceAddress);
  return publicClient.readContract({ ...gov, functionName: "getRecall", args: [BigInt(recallId)] });
}

/** Read-only: the current council roster. */
export async function getCouncil(governanceAddress) {
  const gov = contractFor(governanceAddress);
  return publicClient.readContract({ ...gov, functionName: "getCouncil", args: [] });
}
