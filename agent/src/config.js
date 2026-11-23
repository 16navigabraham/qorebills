import { getAddress, zeroAddress } from "viem";

// Tokens the agent knows by name. fUSD is the QoreChain Fest test dollar (testnet).
export const DEFAULT_TOKENS = [
  { symbol: "QOR", address: zeroAddress, decimals: 18 },
  { symbol: "fUSD", address: "0x97143B771D34ddb9130b807b135Ae675A5a963CA", decimals: 6 },
];

function required(env, name) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}. See .env.example.`);
  return value;
}

export function loadConfig(env = process.env) {
  const tokens = env.TOKENS ? JSON.parse(env.TOKENS) : DEFAULT_TOKENS;
  const ownerTelegramId = required(env, "OWNER_TELEGRAM_ID");
  if (!/^\d+$/.test(ownerTelegramId)) throw new Error("OWNER_TELEGRAM_ID must be your numeric Telegram user id.");
  return {
    evmRpcUrl: env.QORE_EVM_RPC || "https://evm-testnet.qore.host",
    restUrl: env.QORE_REST || "https://api-testnet.qore.host",
    evmChainId: Number(env.EVM_CHAIN_ID || 9800),
    cosmosChainId: env.COSMOS_CHAIN_ID || "qorechain-diana",
    factoryAddress: getAddress(required(env, "FACTORY_ADDRESS")),
    // Optional: normally the account is created through the setup page and remembered in STATE_FILE.
    accountAddress: env.ACCOUNT_ADDRESS ? getAddress(env.ACCOUNT_ADDRESS) : null,
    stateFile: env.STATE_FILE || "data/state.json",
    rpcUrl: env.QORE_RPC || "https://rpc-testnet.qore.host",
    // The agent's own key: created on first start and kept in this file (mode 600).
    agentKeyFile: env.AGENT_KEY_FILE || "data/agent.mnemonic",
    telegramToken: required(env, "TELEGRAM_BOT_TOKEN"),
    ownerTelegramId,
    publicUrl: required(env, "PUBLIC_URL").replace(/\/+$/, ""),
    port: Number(env.PORT || 8787),
    geminiApiKey: env.GEMINI_API_KEY?.trim() || null,
    geminiModel: env.GEMINI_MODEL || "gemini-2.5-flash",
    approvalMinutes: Number(env.APPROVAL_MINUTES || 30),
    tokens: tokens.map((t) => ({ ...t, address: getAddress(t.address) })),
  };
}
