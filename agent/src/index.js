import { bech32ToHex, deriveUnifiedAccount, evmToQor } from "@qorechain/sdk";
import { createBot } from "./bot.js";
import { createChain } from "./chain.js";
import { createGasDispenser } from "./gas.js";
import { loadConfig } from "./config.js";
import { createKeeper } from "./keeper.js";
import { createLlmParser } from "./llm.js";
import { createQoreAccount, loadOrCreateMnemonic } from "./qorechain.js";
import { createStateStore } from "./state.js";
import { createTelegram } from "./telegram.js";
import { createWebServer } from "./web.js";

const config = loadConfig();
const log = { info: console.log, warn: console.warn, error: console.error };

// The agent's master key is created here on first start and never leaves this machine.
// Index 0 is the main key (creates accounts, funds user keys); index n is user n's agent key.
const { mnemonic, created } = loadOrCreateMnemonic(config.agentKeyFile);
const keyFor = async (index) => {
  const qore = await createQoreAccount({ mnemonic, index, rest: config.restUrl, rpc: config.rpcUrl, chainId: config.cosmosChainId });
  const chain = createChain({
    rpcUrl: config.evmRpcUrl,
    evmChainId: config.evmChainId,
    privateKey: qore.privateKey,
    tokens: config.tokens,
    factoryAddress: config.factoryAddress,
    lock: qore.lock,
  });
  return { qore, chain };
};
const main = await keyFor(0);

// Demo billers for the setup page: addresses derived from the master key far above the user
// indexes, so test payments land in addresses this agent controls instead of being lost.
const DEMO_BILLERS = ["Electricity", "Water", "Internet data", "TV subscription", "Hostel rent", "School fees"];
const demoBillers = [];
for (const [i, name] of DEMO_BILLERS.entries()) {
  const { evm } = await deriveUnifiedAccount(mnemonic, 1_000_000 + i);
  demoBillers.push({ name: `${name} (demo)`, address: evm });
}
log.info(`[qorebills] main key ${main.qore.address} (${main.qore.evmAddress})${created ? ", new master key created" : ""}`);

// The gas dispenser: a key linked to the main key under a native QoreChain spending rule.
// Index 999999 is far above the user key indexes (1, 2, …) and below the demo billers (1000000+).
const dispenserAccount = await createQoreAccount({ mnemonic, index: 999_999, rest: config.restUrl, rpc: config.rpcUrl, chainId: config.cosmosChainId });
const gasDispenser = createGasDispenser({ owner: main.qore, dispenser: dispenserAccount, rest: config.restUrl, chainId: config.cosmosChainId, log });
log.info(`[qorebills] gas dispenser ${gasDispenser.address} (${gasDispenser.evmAddress})`);

const telegram = createTelegram({ token: config.telegramToken, log });
const bot = createBot({
  main,
  userKey: keyFor,
  createKeeper,
  store: createStateStore(config.stateFile),
  factoryAddress: config.factoryAddress,
  maxUsers: config.maxUsers,
  gasDispenser,
  log,
  // Telegram private chats use the user's id as the chat id.
  notifyUser: (userId, text) => telegram.send(userId, { text }),
  notifyAdmin: (text) => (config.adminTelegramId ? telegram.send(config.adminTelegramId, { text }) : Promise.resolve()),
  agentOptions: {
    tokens: config.tokens,
    demoBillers,
    cosmosChainId: config.cosmosChainId,
    publicUrl: config.publicUrl,
    // A unified account's qor1 and 0x addresses are the same 20 bytes.
    addresses: {
      toEvm: (value) => (value.startsWith("qor1") ? bech32ToHex(value) : value),
      toBech32: (hex) => evmToQor(hex),
    },
    requestMinutes: config.approvalMinutes,
    parseWithLlm: config.geminiApiKey ? createLlmParser({ apiKey: config.geminiApiKey, model: config.geminiModel }) : null,
    log,
  },
});

const server = createWebServer({ agent: bot, log });
server.listen(config.port, () => log.info(`[qorebills] signing pages on :${config.port}`));
await bot.start();

const controller = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    controller.abort();
    bot.stop();
    server.close();
    setTimeout(() => process.exit(0), 1_000).unref();
  });
}
await telegram.poll({ onMessage: (userId, text) => bot.handle(userId, text), signal: controller.signal });
