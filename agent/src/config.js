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
  if (!env.AGENT_MNEMONIC && !env.AGENT_PRIVATE_KEY) throw new Error("Set AGENT_MNEMONIC (or AGENT_PRIVATE_KEY for local tests).");
  return {
    evmRpcUrl: env.QORE_EVM_RPC || "https://evm-testnet.qore.host",
    restUrl: env.QORE_REST || "https://api-testnet.qore.host",
    evmChainId: Number(env.EVM_CHAIN_ID || 9800),
    cosmosChainId: env.COSMOS_CHAIN_ID || "qorechain-diana",
    accountAddress: getAddress(required(env, "ACCOUNT_ADDRESS")),
    agentMnemonic: env.AGENT_MNEMONIC?.trim(),
    agentPrivateKey: env.AGENT_PRIVATE_KEY?.trim(),
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
