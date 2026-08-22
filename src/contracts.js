import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { formatEther, parseEther, getAddress } from "viem";
import { publicClient, walletClient, operatorAccount, FACTORY_ADDRESS } from "./config.js";

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
  WelcomeDistributor: loadAbi("WelcomeDistributor"),
  DAOFactory: loadAbi("DAOFactory"),
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

export async function getDistributorInfo(distributorAddress) {
  const dist = { address: getAddress(distributorAddress), abi: abis.WelcomeDistributor };

  const [amountPerClaim, remainingCapacity, balance] = await Promise.all([
    publicClient.readContract({ ...dist, functionName: "amountPerClaim" }),
    publicClient.readContract({ ...dist, functionName: "remainingCapacity" }),
    publicClient.readContract({ ...dist, functionName: "balance" }),
  ]);

  return {
    amountPerClaim: formatEther(amountPerClaim),
    remainingCapacity: formatEther(remainingCapacity),
    balance: formatEther(balance),
  };
}

export async function hasAlreadyClaimed(distributorAddress, memberAddress) {
  return publicClient.readContract({
    address: getAddress(distributorAddress),
    abi: abis.WelcomeDistributor,
    functionName: "hasClaimed",
    args: [getAddress(memberAddress)],
  });
}

/**
 * Distributes the welcome grant to `memberAddress` via the operator wallet.
 * Throws if OPERATOR_PRIVATE_KEY isn't configured - callers should check
 * `operatorAccount` is non-null before calling, or catch and surface a
 * clear message.
 */
export async function distributeWelcomeGrant(distributorAddress, memberAddress) {
  if (!walletClient || !operatorAccount) {
    throw new Error("OPERATOR_PRIVATE_KEY is not configured on this bot instance");
  }

  const hash = await walletClient.writeContract({
    address: getAddress(distributorAddress),
    abi: abis.WelcomeDistributor,
    functionName: "distribute",
    args: [getAddress(memberAddress)],
  });

  await publicClient.waitForTransactionReceipt({ hash });
  return hash;
}

// Same defaults as script/CreateDAO.s.sol, kept in sync deliberately - see
// that script if you want to understand what each field means.
const DEFAULT_GOVERNANCE_CONFIG = {
  quorumBps: 1_000,
  approvalThresholdBps: 6_000,
  votingDelay: 1,
  votingPeriod: 50_400,
  timelockDelay: 60n * 60n * 24n, // 1 day, seconds
  executionPeriod: 60n * 60n * 24n * 7n, // 7 days, seconds
  proposalThreshold: 0n,
};

/**
 * Creates a DAO via the factory using the bot's operator wallet.
 *
 * NOTE: the operator wallet becomes both `creator` and the recipient of
 * the entire initial token supply - this is the bot-operator shortcut
 * (Option B from earlier discussion), not the "correct" flow where a
 * user's own linked wallet creates the DAO. Fine for now; the plan is to
 * move DAO creation to protean-connect once that's built out further, at
 * which point the initial supply would go to the actual creator's wallet.
 */
export async function createDaoOnChain(name, symbol, initialSupplyWhole, maxSupplyWhole) {
  if (!walletClient || !operatorAccount) {
    throw new Error("OPERATOR_PRIVATE_KEY is not configured on this bot instance");
  }
  if (!FACTORY_ADDRESS) {
    throw new Error("FACTORY_ADDRESS is not configured on this bot instance");
  }

  const hash = await walletClient.writeContract({
    address: getAddress(FACTORY_ADDRESS),
    abi: abis.DAOFactory,
    functionName: "createDAO",
    args: [
      name,
      symbol,
      parseEther(String(initialSupplyWhole)),
      parseEther(String(maxSupplyWhole)),
      DEFAULT_GOVERNANCE_CONFIG,
    ],
  });

  await publicClient.waitForTransactionReceipt({ hash });

  const daoCount = await publicClient.readContract({
    address: getAddress(FACTORY_ADDRESS),
    abi: abis.DAOFactory,
    functionName: "daoCount",
  });

  const [, , governanceToken, underlyingToken, governance, treasury] = await publicClient.readContract({
    address: getAddress(FACTORY_ADDRESS),
    abi: abis.DAOFactory,
    functionName: "daos",
    args: [daoCount],
  });

  return { hash, governance, governanceToken, underlyingToken, treasury };
}

export { formatEther };
