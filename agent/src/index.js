import { bech32ToHex, evmToQor } from "@qorechain/sdk";
import { createAgent } from "./agent.js";
import { createChain } from "./chain.js";
import { loadConfig } from "./config.js";
import { createKeeper } from "./keeper.js";
import { createLlmParser } from "./llm.js";
import { createQoreAccount, loadOrCreateMnemonic } from "./qorechain.js";
import { createStateStore } from "./state.js";
import { createTelegram } from "./telegram.js";
import { createWebServer } from "./web.js";

const config = loadConfig();
const log = { info: console.log, warn: console.warn, error: console.error };

// The agent's own key is created here on first start and never leaves this machine.
const { mnemonic, created } = loadOrCreateMnemonic(config.agentKeyFile);
const qore = await createQoreAccount({ mnemonic, rest: config.restUrl, rpc: config.rpcUrl, chainId: config.cosmosChainId });
log.info(`[qorebills] agent ${qore.address} (${qore.evmAddress})${created ? ", new key created" : ""}`);

const chain = createChain({
  rpcUrl: config.evmRpcUrl,
  evmChainId: config.evmChainId,
  privateKey: qore.privateKey,
  tokens: config.tokens,
  factoryAddress: config.factoryAddress,
  accountAddress: config.accountAddress,
});
const telegram = createTelegram({ token: config.telegramToken, log });
// Telegram private chats use the user's id as the chat id.
const notify = (text) => telegram.send(config.ownerTelegramId, { text });
const keeper = createKeeper({ qore, chain, factoryAddress: config.factoryAddress, notify, log });

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
  notify,
  onAccountReady: () => keeper.run(),
  log,
});

const server = createWebServer({ agent, log });
server.listen(config.port, () => log.info(`[qorebills] signing pages on :${config.port}`));
keeper.start();

const controller = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    controller.abort();
    keeper.stop();
    server.close();
    setTimeout(() => process.exit(0), 1_000).unref();
  });
}
await telegram.poll({ ownerId: config.ownerTelegramId, onMessage: (text) => agent.handle(text), signal: controller.signal });
