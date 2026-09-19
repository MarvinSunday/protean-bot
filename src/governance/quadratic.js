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

const abi = loadAbi("QuadraticGovernance");

function contractFor(address) {
  return { address: getAddress(address), abi };
}

/**
 * Adapter for QuadraticGovernance. Implements the exact same shared
 * interface as tokenWeighted.js - see src/governance/index.js for the
 * registry these plug into - except this model has no
 * castVoteWithReason equivalent, so `reason` is silently ignored if
 * supplied rather than causing an error. The sqrt-of-balance voting
 * weight calculation happens entirely on-chain; nothing here needs to
 * know or replicate that math.
 */

export async function propose(client, governanceAddress, actions, metadataURI) {
  const gov = contractFor(governanceAddress);

  const hash = await client.writeContract({
    ...gov,
    functionName: "propose",
    args: [actions, metadataURI],
  });
  await publicClient.waitForTransactionReceipt({ hash });

  const proposalId = await publicClient.readContract({ ...gov, functionName: "proposalCount" });

  return { hash, proposalId };
}

export async function vote(client, governanceAddress, proposalId, support, _reason) {
  // _reason intentionally unused - this model has no equivalent entry
  // point, so a caller-supplied reason is silently dropped rather than
  // causing an error, matching the shared-interface design decision.
  const gov = contractFor(governanceAddress);

  const hash = await client.writeContract({
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
 * Read-only. Returns the proposal plus its state label.
 *
 * IMPORTANT, two real differences from tokenWeighted.js's getProposal:
 *
 * 1. No quorumVotes field - QuadraticGovernance has no quorumVotes(id)
 *    view function at all (quorum here is based on sqrt(totalSupply),
 *    not exposed as a per-proposal figure). Deliberately not
 *    recomputed client-side either - getting the sqrt math even
 *    slightly out of sync with the contract's own Babylonian
 *    implementation would silently show a WRONG number, which is worse
 *    than showing none. Whether quorum was met is still fully reflected
 *    in stateLabel (Succeeded vs Defeated), just without a specific
 *    figure attached.
 *
 * 2. forVotes/againstVotes/abstainVotes are sums of sqrt-weighted vote
 *    weight, NOT raw token amounts - do NOT pass these through
 *    formatEther. sqrt(balance) produces a number on a completely
 *    different scale than the balance itself (e.g. sqrt(100 tokens'
 *    raw wei value) is nowhere near 100 "tokens" worth of formatEther
 *    output) - formatEther-ing it would silently show a tiny,
 *    meaningless number. voteWeightUnit flags this so callers display
 *    it correctly (a plain number, clearly labeled "voting weight",
 *    not a token amount).
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
    voteWeightUnit: "sqrtWeight", // NOT raw tokens - see doc comment above
  };
}

/**
 * Quadratic-specific extra: previews what a given balance's voting
 * weight would actually be (sqrt of it) before someone commits to
 * voting - QuadraticGovernance exposes this directly, and the original
 * model has no equivalent, so this is intentionally NOT part of the
 * shared interface - callers that want it need to know they're talking
 * to this specific adapter.
 */
export async function previewWeight(governanceAddress, balance) {
  const gov = contractFor(governanceAddress);
  return publicClient.readContract({ ...gov, functionName: "previewWeight", args: [balance] });
}
