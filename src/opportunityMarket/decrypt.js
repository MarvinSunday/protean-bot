import { marketContract } from "./market.js";
import { getFhevmInstance } from "./encryptedBet.js";
import { opportunityPublicClient } from "./config.js";

/**
 * Real implementation of userDecrypt for balanceOf/getBet - reading a
 * user's own encrypted values back as cleartext. Genuinely different
 * shape of operation from everything else in this system: not a
 * transaction, an off-chain EIP-712 SIGNATURE, authorizing a fresh,
 * ephemeral keypair (NOT the user's actual wallet key) to decrypt on
 * their behalf for a bounded time window, relayed through Zama's
 * service.
 *
 * SESSION CACHING, deliberate design choice: that time window
 * (durationDays below) means this authorization is a session, not a
 * one-shot - regenerating a fresh ephemeral keypair and demanding a new
 * wallet signature every single time someone checks their balance would
 * be a needlessly repetitive experience. Sessions are cached per
 * (userAddress, marketAddress) pair, in memory only, for the life of
 * this process - never persisted to disk or the database, same caution
 * as any other sensitive session material in this bot.
 */

const DECRYPT_SESSION_DURATION_DAYS = 7;

// Map<`${userAddress}:${marketAddress}`, session>
const decryptSessions = new Map();

async function getOrCreateDecryptSession(client, marketAddress) {
  const userAddress = client.account.address;
  const cacheKey = `${userAddress}:${marketAddress}`;
  const nowSeconds = Math.floor(Date.now() / 1000);

  const existing = decryptSessions.get(cacheKey);
  if (existing && existing.expiresAt > nowSeconds) {
    return existing;
  }

  const instance = await getFhevmInstance();
  const keypair = instance.generateKeypair();
  const startTimestamp = nowSeconds;

  // KmsUserDecryptEIP712Type - {domain, types, primaryType, message} -
  // this shape lines up directly with viem's signTypedData parameters,
  // confirmed from the real SDK's own type definitions.
  const eip712 = instance.createEIP712(
    keypair.publicKey,
    [marketAddress],
    startTimestamp,
    DECRYPT_SESSION_DURATION_DAYS
  );

  const signature = await client.signTypedData({
    domain: eip712.domain,
    types: eip712.types,
    primaryType: eip712.primaryType,
    message: eip712.message,
  });

  const session = {
    publicKey: keypair.publicKey,
    privateKey: keypair.privateKey,
    signature,
    startTimestamp,
    durationDays: DECRYPT_SESSION_DURATION_DAYS,
    expiresAt: startTimestamp + DECRYPT_SESSION_DURATION_DAYS * 86400,
  };
  decryptSessions.set(cacheKey, session);
  return session;
}

/**
 * Decrypts the caller's own confidential balance. `client` must be a
 * wallet client for the account whose balance is being read - userDecrypt
 * is bound to that specific address, same as encryptBetInput().
 */
export async function getBalance(client, marketAddress) {
  const userAddress = client.account.address;
  const gov = marketContract(marketAddress);
  const handle = await opportunityPublicClient.readContract({
    ...gov,
    functionName: "balanceOf",
    args: [userAddress],
  });

  const instance = await getFhevmInstance();
  const session = await getOrCreateDecryptSession(client, marketAddress);

  const results = await instance.userDecrypt(
    [{ handle, contractAddress: marketAddress }],
    session.privateKey,
    session.publicKey,
    session.signature,
    [marketAddress],
    userAddress,
    session.startTimestamp,
    session.durationDays
  );

  return results[handle];
}

/**
 * Decrypts one of the caller's own bets - both the target opportunity
 * id and the amount, in a single userDecrypt call covering both
 * handles together.
 */
export async function getBet(client, marketAddress, betIndex) {
  const userAddress = client.account.address;
  const gov = marketContract(marketAddress);

  // getBet returns two separate named outputs (target, amount), not one
  // struct - accessed positionally here rather than by name, since
  // viem's readContract returns multi-output results as an array-like
  // tuple, not guaranteed to expose named properties.
  const betResult = await opportunityPublicClient.readContract({
    ...gov,
    functionName: "getBet",
    args: [userAddress, BigInt(betIndex)],
  });
  const [targetHandle, amountHandle] = betResult;

  const instance = await getFhevmInstance();
  const session = await getOrCreateDecryptSession(client, marketAddress);

  const results = await instance.userDecrypt(
    [
      { handle: targetHandle, contractAddress: marketAddress },
      { handle: amountHandle, contractAddress: marketAddress },
    ],
    session.privateKey,
    session.publicKey,
    session.signature,
    [marketAddress],
    userAddress,
    session.startTimestamp,
    session.durationDays
  );

  return {
    target: results[targetHandle],
    amount: results[amountHandle],
  };
}
