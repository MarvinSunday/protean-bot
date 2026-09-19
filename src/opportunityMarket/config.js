import { createPublicClient, http } from "viem";
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
