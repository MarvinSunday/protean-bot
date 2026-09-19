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

const abi = loadAbi("Governance");

function contractFor(address) {
  return { address: getAddress(address), abi };
}

/**
 * Adapter for the original token-weighted model. Implements the shared
 * governance interface every adapter in src/governance/ follows - see
 * src/governance/index.js for the registry these all plug into.
 */

export async function propose(client, governanceAddress, actions, metadataURI) {
  const gov = contractFor(governanceAddress);

  const hash = await client.writeContract({
    ...gov,
    functionName: "propose",
    args: [actions, metadataURI],
  });
  await publicClient.waitForTransactionReceipt({ hash });

  // Proposal IDs are sequential - the count right after this tx reflects
  // the new proposal, since this account just created the latest one.
  const proposalId = await publicClient.readContract({ ...gov, functionName: "proposalCount" });

  return { hash, proposalId };
}

/**
 * `reason` is optional. The original model has both castVote and
 * castVoteWithReason - if a reason is supplied, use the richer entry
 * point; otherwise stay on the plain one.
 */
export async function vote(client, governanceAddress, proposalId, support, reason) {
  const gov = contractFor(governanceAddress);

  const hash = reason
    ? await client.writeContract({
        ...gov,
        functionName: "castVoteWithReason",
        args: [BigInt(proposalId), support, reason],
      })
    : await client.writeContract({
        ...gov,
        functionName: "castVote",
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

/**
 * `valueWhole` is the total native currency (in whole MON) the
 * proposal's actions require, summed across every action - the contract
 * checks this matches exactly. Defaults to 0, the common case.
 */
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
 * Read-only. Returns the proposal plus its state label and quorum
 * figure - forVotes/againstVotes/abstainVotes here are raw staked-token
 * amounts (18 decimals), safe to pass through formatEther for display.
 */
export async function getProposal(governanceAddress, proposalId) {
  const gov = contractFor(governanceAddress);

  const [proposal, stateIndex, quorumVotes, executableAfter] = await Promise.all([
    publicClient.readContract({ ...gov, functionName: "getProposal", args: [BigInt(proposalId)] }),
    publicClient.readContract({ ...gov, functionName: "state", args: [BigInt(proposalId)] }),
    publicClient.readContract({ ...gov, functionName: "quorumVotes", args: [BigInt(proposalId)] }),
    publicClient.readContract({ ...gov, functionName: "executableAfter", args: [BigInt(proposalId)] }),
  ]);

  return {
    ...proposal,
    stateIndex: Number(stateIndex),
    quorumVotes,
    executableAfter,
    voteWeightUnit: "token", // forVotes/against/abstain are raw 18-decimal token amounts
  };
}
