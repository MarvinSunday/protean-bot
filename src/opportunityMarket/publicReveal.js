import { marketContract, finalizeWinningTotal, requestWithdrawal, requestRewardWithdrawal } from "./market.js";
import { getFhevmInstance } from "./encryptedBet.js";
import { opportunityPublicClient } from "./config.js";

/**
 * Real implementation of the public-decrypt flow that
 * completeWinningTotalReveal()/completeWithdrawal() need. Genuinely
 * different from decrypt.js's userDecrypt flow, despite superficial
 * similarity (both eventually produce cleartext from a handle):
 *
 * - userDecrypt (decrypt.js) is for a user reading their OWN value
 *   off-chain, authorized by an EIP-712 signature tied to their
 *   identity. Never fed back into a contract call.
 *
 * - publicDecrypt (here) is for a value the contract itself needs to
 *   act on - confirmed directly from OpportunityMarket.sol's source,
 *   both completion functions verify the cleartext via
 *   FHE.checkSignatures() and then abi.decode() it to actually move
 *   tokens. That requires an on-chain-verifiable, KMS-signed proof, not
 *   a user's own authorization - publicDecrypt needs no keypair, no
 *   signature, nothing tied to a specific user at all, since the
 *   contract already decided (by emitting the reveal-request event in
 *   the first place) that this specific handle is meant to become
 *   public.
 *
 * Both functions here do the full round trip in one call - simulate to
 * get the handle, decrypt it publicly, submit the completion - rather
 * than making the caller orchestrate multiple steps by hand.
 */

/** Full flow: finalizes the winning total, publicly reveals it, and submits the completion in one call. */
export async function revealAndCompleteWinningTotal(client, marketAddress) {
  const { handle } = await finalizeWinningTotal(client, marketAddress);

  const instance = await getFhevmInstance();
  const { abiEncodedClearValues, decryptionProof } = await instance.publicDecrypt([handle]);

  const gov = marketContract(marketAddress);
  const hash = await client.writeContract({
    ...gov,
    functionName: "completeWinningTotalReveal",
    args: [abiEncodedClearValues, decryptionProof],
  });
  await opportunityPublicClient.waitForTransactionReceipt({ hash });
  return { hash, handle };
}

/**
 * Full flow for either a stake or reward withdrawal - `kind` picks
 * which. Requests the withdrawal, publicly reveals the resulting
 * handle, and submits the completion.
 */
export async function revealAndCompleteWithdrawal(client, marketAddress, kind) {
  const requestFn = kind === "reward" ? requestRewardWithdrawal : requestWithdrawal;
  const { handle } = await requestFn(client, marketAddress);

  const instance = await getFhevmInstance();
  const { abiEncodedClearValues, decryptionProof } = await instance.publicDecrypt([handle]);

  const gov = marketContract(marketAddress);
  const hash = await client.writeContract({
    ...gov,
    functionName: "completeWithdrawal",
    args: [handle, abiEncodedClearValues, decryptionProof],
  });
  await opportunityPublicClient.waitForTransactionReceipt({ hash });
  return { hash, handle };
}
