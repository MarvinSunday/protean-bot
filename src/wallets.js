import "dotenv/config";

const CONNECT_SITE_URL = process.env.CONNECT_SITE_URL;

if (!CONNECT_SITE_URL) {
  console.warn(
    "CONNECT_SITE_URL is not set - /connect and /wallet will not work until it is."
  );
}

/** Returns { walletAddress, privyUserId, linkedAt } or null if not linked. */
export async function getLinkedWallet(telegramUserId) {
  if (!CONNECT_SITE_URL) return null;

  const res = await fetch(`${CONNECT_SITE_URL}/api/wallet/${telegramUserId}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`connect site responded ${res.status}`);

  return res.json();
}

export function connectLink() {
  return CONNECT_SITE_URL ?? null;
}
