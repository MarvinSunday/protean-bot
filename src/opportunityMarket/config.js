import { createPublicClient, createWalletClient, http } from "viem";
import { sepolia } from "viem/chains";
import { SepoliaConfig } from "@zama-fhe/relayer-sdk/node";

/**
 * Opportunity Markets targets Ethereum Sepolia, not Monad - Zama's FHE
 * coprocessor infrastructure is only genuinely deployed there (and on
 * Ethereum mainnet) as of this writing, confirmed directly from Zama's
 * own docs, not assumed. This whole folder is deliberately self-
 * contained and never imports from the main src/config.js, since that
 * file is Monad-specific throughout.
 */

const SEPOLIA_RPC_URL = process.env.OPPORTUNITY_MARKET_RPC_URL || sepolia.rpcUrls.default.http[0];

export const opportunityMarketChain = sepolia;

export const opportunityPublicClient = createPublicClient({
  chain: opportunityMarketChain,
  transport: http(SEPOLIA_RPC_URL),
});

/**
 * Sepolia counterpart to contracts.js's walletClientFor - same pattern,
 * different chain. Opportunity Market's every write action needs a
 * client built against opportunityMarketChain (Sepolia) specifically,
 * not monadTestnet, since it's a genuinely separate network from
 * everything else this bot does. This was called throughout index.js's
 * Opportunity Market commands but never actually defined here - the
 * cause of a hard crash on startup (a named import that doesn't exist
 * is a SyntaxError in ESM, not a runtime error, so it took the whole
 * process down immediately rather than failing only when a command
 * that needed it was actually used).
 */
export function opportunityWalletClientFor(account) {
  return createWalletClient({ account, chain: opportunityMarketChain, transport: http(SEPOLIA_RPC_URL) });
}

/**
 * DELIBERATELY sourced from the installed @zama-fhe/relayer-sdk package
 * itself (SepoliaConfig), not hand-copied from documentation - a real,
 * concrete lesson learned while building this: values transcribed from
 * Zama's own docs page (dated Dec 2025) turned out to already differ
 * from this package's actual current constant (v0.4.4, confirmed by
 * inspecting it directly) - different ACL/KMS/input-verifier addresses,
 * a different gateway chain id, even a different relayer URL. Importing
 * the package's own export instead means this always matches whatever
 * that package version considers current, and simply stays correct
 * across `npm update` rather than needing to be manually re-verified
 * and edited by hand again later.
 */
export const ZAMA_FHE_CONFIG = {
  ...SepoliaConfig,
  network: SEPOLIA_RPC_URL,
};

export function isOpportunityMarketConfigured() {
  return Boolean(SEPOLIA_RPC_URL);
}

/**
 * Sepolia-side equivalent of the main config.js's writeWithGasBuffer -
 * can't reuse that one directly, since it's bound to Monad's
 * publicClient, not this file's own opportunityPublicClient. Applied
 * here mainly for consistency with the rest of the bot; Sepolia (a
 * standard Ethereum testnet) doesn't share Monad's charge-for-the-
 * full-gas_limit behavior, so the risk this addresses on the Monad
 * side is largely theoretical here - a real, per-call estimate plus a
 * modest buffer is still a reasonable default regardless of chain.
 */
export async function writeWithGasBuffer(client, contractParams) {
  const estimate = await opportunityPublicClient.estimateContractGas({ ...contractParams, account: client.account });
  const gas = (estimate * 150n) / 100n;
  return client.writeContract({ ...contractParams, gas });
}