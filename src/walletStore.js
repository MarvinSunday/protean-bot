import { createClient } from "@supabase/supabase-js";
import { createEncryptedWallet, decryptWallet, isKmsWalletConfigured } from "./kmsWallet.js";

/**
 * Persistence layer for KMS-backed wallets, using Supabase (managed
 * Postgres) as durable storage - see kmsWallet.js's own header comment
 * for why durability matters here specifically: unlike the old
 * master-seed derivation, a lost record here means a permanently lost
 * wallet, not a recomputable one.
 *
 * SCOPE NOTE, IMPORTANT: this module only ever manages NEW, KMS-backed
 * wallets. It has no knowledge of wallet.js's master-seed derivation and
 * makes no attempt to check whether a given platform user already has an
 * old-style derived wallet before creating a new one here. That check is
 * a deliberate, visible decision that belongs at the call site (in
 * index.js/wallet.js), not something to bury silently in this module -
 * calling getOrCreateWallet for a user who already has funds sitting in
 * an old derived wallet would silently orphan them, not migrate them.
 * Wiring this in safely is the next, separate step.
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

let supabase = null;
function getSupabaseClient() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must both be set on this bot instance");
  }
  if (!supabase) {
    supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  }
  return supabase;
}

export function isWalletStoreConfigured() {
  return Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) && isKmsWalletConfigured();
}

/**
 * Looks up an existing KMS-backed wallet record for this platform user,
 * or null if none exists yet. Does not decrypt anything - callers that
 * just need to know "does this user already have a new-style wallet"
 * (e.g., to decide whether to fall back to the old system) can use this
 * without paying for a KMS Decrypt call.
 */
export async function findWalletRecord(platform, platformUserId) {
  const { data, error } = await getSupabaseClient()
    .from("wallets")
    .select("*")
    .eq("platform", platform)
    .eq("platform_user_id", String(platformUserId))
    .maybeSingle();

  if (error) throw new Error(`Supabase lookup failed: ${error.message}`);
  return data; // null if no row found
}

/**
 * Creates a brand-new KMS-backed wallet for this platform user and
 * persists it. Throws if a record already exists for this user - callers
 * are expected to check findWalletRecord first, so an unexpected
 * duplicate here is a bug worth surfacing loudly, not silently
 * overwriting an existing wallet.
 */
export async function createWalletRecord(platform, platformUserId) {
  const existing = await findWalletRecord(platform, platformUserId);
  if (existing) {
    throw new Error(`A wallet record already exists for ${platform}:${platformUserId}`);
  }

  const wallet = await createEncryptedWallet();

  const { data, error } = await getSupabaseClient()
    .from("wallets")
    .insert({
      platform,
      platform_user_id: String(platformUserId),
      address: wallet.address,
      encrypted_private_key: wallet.encryptedPrivateKey,
      encrypted_data_key: wallet.encryptedDataKey,
      iv: wallet.iv,
      auth_tag: wallet.authTag,
    })
    .select()
    .single();

  if (error) throw new Error(`Supabase insert failed: ${error.message}`);
  return data;
}

/**
 * Returns a ready-to-use viem Account for this platform user's KMS-backed
 * wallet, decrypting it fresh for this one call. Throws if no record
 * exists - this deliberately does NOT auto-create one, for the same
 * reason noted in the module-level scope comment above.
 */
export async function getWalletAccount(platform, platformUserId) {
  const record = await findWalletRecord(platform, platformUserId);
  if (!record) {
    throw new Error(`No wallet record found for ${platform}:${platformUserId}`);
  }

  return decryptWallet({
    encryptedPrivateKey: record.encrypted_private_key,
    encryptedDataKey: record.encrypted_data_key,
    iv: record.iv,
    authTag: record.auth_tag,
  });
}
