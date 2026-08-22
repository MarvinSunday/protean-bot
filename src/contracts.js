import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { formatEther, getAddress } from "viem";
import { publicClient } from "./config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadAbi(name) {
  const raw = fs.readFileSync(path.join(__dirname, "abis", `${name}.json`), "utf8");
  return JSON.parse(raw);
}

const abis = {
  Governance: loadAbi("Governance"),
  Treasury: loadAbi("Treasury"),
  StakedGovernanceToken: loadAbi("StakedGovernanceToken"),
  GovernanceToken: loadAbi("GovernanceToken"),
};

// Mirrors Types.sol's ProposalState enum exactly - order and count matter.
export const PROPOSAL_STATE_LABELS = [
  "Pending",
  "Active",
  "Succeeded",
  "Queued",
  "Defeated",
  "Executed",
  "Cancelled",
  "Expired",
];

export const VOTE_TYPE = { Against: 0, For: 1, Abstain: 2 };

function governance(address) {
  return { address: getAddress(address), abi: abis.Governance };
}

export async function getDaoInfo(governanceAddress) {
  const gov = governance(governanceAddress);

  const [daoName, tokenAddress, treasuryAddress] = await Promise.all([
    publicClient.readContract({ ...gov, functionName: "daoName" }),
    publicClient.readContract({ ...gov, functionName: "governanceToken" }),
    publicClient.readContract({ ...gov, functionName: "treasury" }),
  ]);

  const config = await publicClient.readContract({ ...gov, functionName: "governanceConfig" });

  return { daoName, tokenAddress, treasuryAddress, config };
}

export async function getProposalCount(governanceAddress) {
  const gov = governance(governanceAddress);
  const count = await publicClient.readContract({ ...gov, functionName: "proposalCount" });
  return Number(count);
}

export async function getProposal(governanceAddress, proposalId) {
  const gov = governance(governanceAddress);

  const [proposal, stateIndex, quorumVotes, executableAfter] = await Promise.all([
    publicClient.readContract({ ...gov, functionName: "getProposal", args: [BigInt(proposalId)] }),
    publicClient.readContract({ ...gov, functionName: "state", args: [BigInt(proposalId)] }),
    publicClient.readContract({ ...gov, functionName: "quorumVotes", args: [BigInt(proposalId)] }),
    publicClient.readContract({ ...gov, functionName: "executableAfter", args: [BigInt(proposalId)] }),
  ]);

  return {
    ...proposal,
    stateLabel: PROPOSAL_STATE_LABELS[Number(stateIndex)] ?? "Unknown",
    quorumVotes,
    executableAfter,
  };
}

export async function getTreasuryBalance(treasuryAddress) {
  const ethBalance = await publicClient.readContract({
    address: getAddress(treasuryAddress),
    abi: abis.Treasury,
    functionName: "ethBalance",
  });
  return formatEther(ethBalance);
}

export async function getVotingPower(tokenAddress, account) {
  const token = { address: getAddress(tokenAddress), abi: abis.StakedGovernanceToken };

  const [staked, votes, delegatedTo] = await Promise.all([
    publicClient.readContract({ ...token, functionName: "balanceOf", args: [getAddress(account)] }),
    publicClient.readContract({ ...token, functionName: "getVotes", args: [getAddress(account)] }),
    publicClient.readContract({ ...token, functionName: "delegates", args: [getAddress(account)] }),
  ]);

  return {
    staked: formatEther(staked),
    activeVotes: formatEther(votes),
    delegatedTo,
  };
}

export { formatEther };
