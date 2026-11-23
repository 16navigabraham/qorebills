import { bech32ToHex, deriveUnifiedAccount, evmToQor } from "@qorechain/sdk";
import { createAgent } from "./agent.js";
import { createChain } from "./chain.js";
import { loadConfig } from "./config.js";
import { createLlmParser } from "./llm.js";
import { createStateStore } from "./state.js";
import { createTelegram } from "./telegram.js";
import { createWebServer } from "./web.js";

const config = loadConfig();
// The agent's key: a unified QoreChain account (one eth_secp256k1 key for both lanes).
const privateKey = config.agentPrivateKey || (await deriveUnifiedAccount(config.agentMnemonic)).privateKey;

const chain = createChain({
  rpcUrl: config.evmRpcUrl,
  evmChainId: config.evmChainId,
  privateKey,
  tokens: config.tokens,
  factoryAddress: config.factoryAddress,
  accountAddress: config.accountAddress,
});
const telegram = createTelegram({ token: config.telegramToken });
const agent = createAgent({
  chain,
  tokens: config.tokens,
  cosmosChainId: config.cosmosChainId,
  publicUrl: config.publicUrl,
  // A unified account's qor1 and 0x addresses are the same 20 bytes.
  addresses: {
    toEvm: (value) => (value.startsWith("qor1") ? bech32ToHex(value) : value),
    toBech32: (hex) => evmToQor(hex),
  },
  state: createStateStore(config.stateFile),
  requestMinutes: config.approvalMinutes,
  parseWithLlm: config.geminiApiKey ? createLlmParser({ apiKey: config.geminiApiKey, model: config.geminiModel }) : null,
  // Telegram private chats use the user's id as the chat id.
  notify: (text) => telegram.send(config.ownerTelegramId, { text }),
});

const server = createWebServer({ agent });
server.listen(config.port, () => console.log(`[qorebills] signing pages on :${config.port}, agent ${chain.agentAddress}`));

const controller = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    controller.abort();
    server.close();
    setTimeout(() => process.exit(0), 1_000).unref();
  });
}
await telegram.poll({ ownerId: config.ownerTelegramId, onMessage: (text) => agent.handle(text), signal: controller.signal });
