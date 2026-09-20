import "dotenv/config";
import { createPublicClient, createWalletClient, http, defineChain } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export const monadTestnet = defineChain({
  id: 10143,
  name: "Monad Testnet",
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: {
    default: { http: [process.env.RPC_URL || "https://testnet-rpc.monad.xyz"] },
  },
  blockExplorers: {
    default: { name: "Monad Explorer", url: "https://testnet.monadexplorer.com" },
  },
  testnet: true,
});

export const publicClient = createPublicClient({
  chain: monadTestnet,
  transport: http(),
});

// Operator wallet - only needed for write actions (currently: distributing
// welcome tokens via WelcomeDistributor). Optional: the bot still works
// fully in read-only mode without this set, /claim and auto-distribution
// on join just won't be available.
const OPERATOR_PRIVATE_KEY = process.env.OPERATOR_PRIVATE_KEY;

let operatorAccount = null;
if (OPERATOR_PRIVATE_KEY) {
  try {
    operatorAccount = privateKeyToAccount(OPERATOR_PRIVATE_KEY);
  } catch (err) {
    console.error(
      "OPERATOR_PRIVATE_KEY is set but invalid (must be a 0x-prefixed 32-byte hex string):",
      err.message
    );
  }
}
export { operatorAccount };

export const walletClient = operatorAccount
  ? createWalletClient({
      account: operatorAccount,
      chain: monadTestnet,
      transport: http(),
    })
  : null;

if (!operatorAccount) {
  console.warn(
    "OPERATOR_PRIVATE_KEY not set - /claim and auto-distribution on join will not work until it is."
  );
}

export const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

// Needed for /createdao and for gas-funding derived user wallets. Bot works
// fine without it - those features just won't be available.
export const FACTORY_ADDRESS = process.env.FACTORY_ADDRESS;
if (!FACTORY_ADDRESS) {
  console.warn("FACTORY_ADDRESS not set - /createdao will not work until it is.");
}

/**
 * One factory address per model, keyed the same way SUPPORTED_MODELS
 * names them. /createdao looks up the right one for whichever model the
 * caller asked for; a model with no address set here simply can't be
 * created through the bot yet (an existing DAO of that model can still
 * be linked with /register - this only gates *creating new ones*).
 */
export const FACTORY_ADDRESSES = {
  tokenWeighted: FACTORY_ADDRESS,
  quadratic: process.env.QUADRATIC_FACTORY_ADDRESS,
  liquid: process.env.LIQUID_FACTORY_ADDRESS,
  optimistic: process.env.OPTIMISTIC_FACTORY_ADDRESS,
  delegate: process.env.DELEGATE_FACTORY_ADDRESS,
  board: process.env.BOARD_FACTORY_ADDRESS,
  sortition: process.env.SORTITION_FACTORY_ADDRESS,
  conviction: process.env.CONVICTION_FACTORY_ADDRESS,
  sowellian: process.env.SOWELLIAN_FACTORY_ADDRESS,
  decisionMarkets: process.env.DECISION_MARKETS_FACTORY_ADDRESS,
};

if (!BOT_TOKEN) {
  console.error("Missing TELEGRAM_BOT_TOKEN - copy .env.example to .env and fill it in.");
  process.exit(1);
}
