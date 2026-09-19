import { findWalletRecord, createWalletRecord, getWalletAccount, isWalletStoreConfigured } from "./walletStore.js";
import { deriveUserWallet, isWalletDerivationConfigured } from "./wallet.js";
import { publicClient } from "./config.js";

/**
 * Resolves a Telegram user's signing account - the KMS-backed wallet if
 * one already exists, or a freshly created one for genuinely new users.
 *
 * Deliberately does NOT silently migrate a user who already has funds
 * under the old master-seed-derived system (wallet.js) - if their old
 * wallet has a nonzero native balance, this throws a clear, actionable
 * error directing them to /migratewallet first, rather than quietly
 * creating a second, unrelated wallet and orphaning the old one's
 * funds. A genuinely new user (old wallet balance is zero, the common
 * case) gets a new KMS wallet created transparently, no extra step.
 */
export async function getOrCreateUserAccount(telegramUserId) {
  if (!isWalletStoreConfigured()) {
    throw new Error("The KMS/Supabase wallet system is not configured on this bot instance.");
  }

  const existing = await findWalletRecord("telegram", telegramUserId);
  if (existing) {
    return getWalletAccount("telegram", telegramUserId);
  }

  if (isWalletDerivationConfigured()) {
    const oldAccount = deriveUserWallet(telegramUserId);
    const balance = await publicClient.getBalance({ address: oldAccount.address });
    if (balance > 0n) {
      throw new Error(
        `Your old wallet (${oldAccount.address}) has a balance - run /migratewallet first to move your funds ` +
          `to the new wallet system before continuing.`
      );
    }
  }

  await createWalletRecord("telegram", telegramUserId);
  return getWalletAccount("telegram", telegramUserId);
}

/**
 * Lightweight - just the address, no decryption and no wallet creation.
 * Prefers a KMS record's stored address (reading it needs no decrypt
 * call at all, unlike getOrCreateUserAccount); falls back to the old
 * derived address if no KMS record exists yet. Safe to call for a user
 * who's never interacted with the bot before - never creates anything,
 * unlike getOrCreateUserAccount.
 */
export async function getUserAddress(telegramUserId) {
  const existing = await findWalletRecord("telegram", telegramUserId);
  if (existing) return existing.address;
  if (isWalletDerivationConfigured()) return deriveUserWallet(telegramUserId).address;
  throw new Error("No wallet system configured on this bot instance.");
}
