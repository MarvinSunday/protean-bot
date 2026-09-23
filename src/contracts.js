import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createWalletClient, http, formatEther, parseEther, getAddress, isAddress } from "viem";
import { publicClient, walletClient, operatorAccount, FACTORY_ADDRESS, monadTestnet } from "./config.js";
import { recordGasTopup, isWalletStoreConfigured } from "./walletStore.js";

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

/*//////////////////////////////////////////////////////////////
            PER-USER WALLET ACTIONS (derived wallets)
//////////////////////////////////////////////////////////////*/

function walletClientFor(account) {
  return createWalletClient({ account, chain: monadTestnet, transport: http() });
}

const MIN_GAS_BALANCE = parseEther("0.005");
const FIRST_GAS_TOPUP_AMOUNT = parseEther("0.1");
const REPEAT_GAS_TOPUP_AMOUNT = parseEther("0.05");

/**
 * Tops up `account` with MON from the operator wallet if its balance is
 * below a threshold. Derived wallets start with zero MON and can't pay
 * gas for their own first transaction without this - the operator
 * wallet effectively sponsors a small amount of gas per user.
 *
 * Tiered for this testnet: a user's very first top-up is larger
 * (0.1 MON) than every one after it (0.05 MON), on the assumption that
 * the first top-up needs to cover getting properly set up, while later
 * ones are just keeping an already-active user going. Falls back to
 * the first-time amount, every time, for a wallet whose top-up history
 * can't be tracked - Supabase not configured, or the address has no
 * record there at all (a legacy derived wallet, see wallet.js) - rather
 * than fail the whole transaction over a wallet-store lookup on what is
 * otherwise a real transaction the user is trying to complete.
 *
 * Silently does nothing if the account already has enough, or if no
 * operator wallet is configured (caller's own transaction will then just
 * fail with an insufficient-funds error, which is an honest failure mode).
 */
export async function ensureGasFunded(account) {
  if (!walletClient || !operatorAccount) return;

  const balance = await publicClient.getBalance({ address: account.address });
  if (balance >= MIN_GAS_BALANCE) return;

  let topupAmount = FIRST_GAS_TOPUP_AMOUNT;
  if (isWalletStoreConfigured()) {
    try {
      const topupNumber = await recordGasTopup(account.address);
      if (topupNumber !== null && topupNumber > 1) {
        topupAmount = REPEAT_GAS_TOPUP_AMOUNT;
      }
    } catch (err) {
      // Wallet-store lookup failing shouldn't block a user's real
      // transaction - fall back to the first-time amount and continue.
      console.error("[ensureGasFunded] Couldn't record top-up history, using first-time amount:", err.message);
    }
  }

  const hash = await walletClient.sendTransaction({
    to: account.address,
    value: topupAmount,
  });
  await publicClient.waitForTransactionReceipt({ hash });
}

/**
 * Approves and stakes `amountWhole` of the underlying token into the
 * staking wrapper, signed by `account` (the user's own derived wallet).
 * Two on-chain transactions: approve, then stake.
 */
export async function stakeTokens(account, stakingTokenAddress, amountWhole) {
  const client = walletClientFor(account);
  const amount = parseEther(String(amountWhole));

  const underlyingAddress = await publicClient.readContract({
    address: getAddress(stakingTokenAddress),
    abi: abis.StakedGovernanceToken,
    functionName: "underlying",
  });

  const approveHash = await client.writeContract({
    address: underlyingAddress,
    abi: abis.GovernanceToken,
    functionName: "approve",
    args: [getAddress(stakingTokenAddress), amount],
  });
  await publicClient.waitForTransactionReceipt({ hash: approveHash });

  const stakeHash = await client.writeContract({
    address: getAddress(stakingTokenAddress),
    abi: abis.StakedGovernanceToken,
    functionName: "stake",
    args: [amount],
  });
  await publicClient.waitForTransactionReceipt({ hash: stakeHash });

  return { approveHash, stakeHash };
}

/**
 * Creates a single-action proposal, signed by `account`.
 */
export async function proposeOnChain(account, governanceAddress, target, value, data, metadataURI) {
  const client = walletClientFor(account);

  const actions = [{ target: getAddress(target), value: parseEther(String(value || "0")), data: data || "0x" }];

  const hash = await client.writeContract({
    address: getAddress(governanceAddress),
    abi: abis.Governance,
    functionName: "propose",
    args: [actions, metadataURI],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });

  // Proposal count right after this tx reflects the new proposal's ID,
  // since IDs are sequential and this account just created the latest one.
  const proposalId = await publicClient.readContract({
    address: getAddress(governanceAddress),
    abi: abis.Governance,
    functionName: "proposalCount",
  });

  return { hash, receipt, proposalId };
}

/**
 * Casts a vote, signed by `account`. `support` is 0=Against, 1=For, 2=Abstain.
 */
export async function castVoteOnChain(account, governanceAddress, proposalId, support) {
  const client = walletClientFor(account);

  const hash = await client.writeContract({
    address: getAddress(governanceAddress),
    abi: abis.Governance,
    functionName: "castVote",
    args: [BigInt(proposalId), support],
  });
  await publicClient.waitForTransactionReceipt({ hash });

  return { hash };
}

function stakedToken(address) {
  return { address: getAddress(address), abi: abis.StakedGovernanceToken };
}

function underlyingToken(address) {
  return { address: getAddress(address), abi: abis.GovernanceToken };
}

/** The DAO's registered creator address - /tip's authorization check reads this. */
export async function getDaoCreator(governanceAddress) {
  return publicClient.readContract({ ...governance(governanceAddress), functionName: "creator" });
}

/**
 * Resolves the DAO's own underlying (raw, transferable) governance
 * token address - the StakedGovernanceToken wrapper holds voting power,
 * but tipping and everyday balances are about the underlying token
 * itself, which is what people can actually hold, transfer, and spend.
 */
export async function getUnderlyingTokenAddress(governanceAddress) {
  const stakedTokenAddress = await publicClient.readContract({ ...governance(governanceAddress), functionName: "governanceToken" });
  return publicClient.readContract({ ...stakedToken(stakedTokenAddress), functionName: "underlying" });
}

/**
 * Resolves a token reference to a real address - either the reference
 * already IS a valid address (used as-is), or it's treated as a ticker
 * and matched (case-insensitively) against the DAO's own underlying
 * token's real, on-chain symbol(). There's no separate ticker registry:
 * "the DAO's own token" is the only ticker this currently resolves,
 * since it's the only token this bot has any other relationship with.
 * Throws with a clear, specific message on no match, rather than
 * silently falling back to something unexpected.
 */
export async function resolveTokenReference(governanceAddress, reference) {
  if (isAddress(reference)) return getAddress(reference);

  const underlyingAddress = await getUnderlyingTokenAddress(governanceAddress);
  const symbol = await publicClient.readContract({ ...underlyingToken(underlyingAddress), functionName: "symbol" });

  if (symbol.toLowerCase() === reference.toLowerCase()) return underlyingAddress;

  throw new Error(`"${reference}" isn't a valid address and doesn't match this DAO's token symbol (${symbol})`);
}

/**
 * Sends `amountWhole` of `tokenAddress` (the DAO's underlying token, or
 * any other ERC20 sharing this ABI's transfer signature) from `client`
 * to `recipientAddress`. No authorization check here - by design,
 * matching this file's existing pattern (see castVoteOnChain,
 * stakeTokens): callers decide who's allowed to call this and with
 * which client; this function only executes what it's asked.
 */
export async function tipTokens(client, tokenAddress, recipientAddress, amountWhole) {
  const token = underlyingToken(tokenAddress);
  const amount = parseEther(String(amountWhole));

  const hash = await client.writeContract({
    ...token,
    functionName: "transfer",
    args: [getAddress(recipientAddress), amount],
  });
  await publicClient.waitForTransactionReceipt({ hash });

  return { hash };
}

/** Raw ERC20 balanceOf on any token sharing GovernanceToken's ABI, formatted as a whole-token string. */
export async function getTokenBalance(tokenAddress, holderAddress) {
  const balance = await publicClient.readContract({
    ...underlyingToken(tokenAddress),
    functionName: "balanceOf",
    args: [getAddress(holderAddress)],
  });
  return formatEther(balance);
}

/** Reads a token's real on-chain symbol - for display labels, not resolution (see resolveTokenReference for that). */
export async function getTokenSymbol(tokenAddress) {
  return publicClient.readContract({ ...underlyingToken(tokenAddress), functionName: "symbol" });
}

export { formatEther };