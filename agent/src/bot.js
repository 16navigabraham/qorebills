// Serves every Telegram user: each one gets their own smart account (owned by their own
// QoreX wallet) and their own agent key, derived from the agent's master key. Each user
// key is funded by the main key, registers its own ML-DSA-87 key and keeps an EVM window
// scoped to that user's account only, so one user's agent can never touch another's money.
import { createAgent } from "./agent.js";

const USER_GAS_TOPUP_UQOR = 1_000_000n; // 1 QOR
const USER_GAS_MIN_UQOR = 300_000n; // top up below 0.3 QOR
const MAIN_GAS_MIN_UQOR = 3_000_000n; // tell the admin below 3 QOR

/**
 * @param main        the main key: { qore, chain } (sends createAccount, funds user keys)
 * @param userKey     async (index) => { qore, chain } for the n-th user's agent key
 * @param createKeeper as in keeper.js
 * @param store       { get(), set(patch) } JSON state: { users: { [telegramId]: { index, account, owner, setups } }, nextIndex }
 */
export function createBot({
  main,
  userKey,
  createKeeper,
  store,
  factoryAddress,
  agentOptions,
  notifyUser,
  notifyAdmin = async () => {},
  gasDispenser = null, // gas.js: top-ups bounded by QoreChain's native spending rules
  maxUsers = 50,
  maxSetupsPerUser = 3,
  scheduleEveryMs = 30_000, // how often to look for recurring bills that are due
  log = console,
}) {
  const requests = new Map();
  const sessions = new Map(); // telegramId -> { agent, keeper, qore }
  let lastAdminAsk = 0;
  let dispenserTimer = null;
  let scheduleTimer = null;
  let scheduling = false;

  /** Pay every user's recurring bills that are due, and tell each user what happened. */
  async function runSchedules() {
    if (scheduling) return; // a slow round must not overlap the next one
    scheduling = true;
    try {
      for (const [id, u] of Object.entries(users())) {
        if (!u.account || !(u.schedules || []).some((s) => s.active && s.nextRun <= Date.now())) continue;
        try {
          const { agent } = await session(id);
          for (const message of await agent.runDueSchedules()) await notifyUser(id, message).catch(() => {});
        } catch (error) {
          log.error?.(`[bot] recurring bills for user ${id} failed:`, error.message);
        }
      }
    } finally {
      scheduling = false;
    }
  }

  const users = () => store.get().users || {};
  const userState = (id) => ({
    get: () => ({ ...(users()[id] || {}) }),
    set: (patch) => store.set({ users: { ...users(), [id]: { ...(users()[id] || {}), ...patch } } }),
  });

  const mainKeeper = createKeeper({
    qore: main.qore,
    targets: () => [factoryAddress],
    minGasUqor: MAIN_GAS_MIN_UQOR,
    log,
    onLowGas: async (balance) => {
      if (Date.now() - lastAdminAsk < 6 * 3600_000) return;
      lastAdminAsk = Date.now();
      log.warn?.(`[bot] main key low on gas: ${Number(balance) / 1e6} QOR at ${main.qore.address}`);
      await notifyAdmin(
        `QoreBills needs test QOR for gas. Send about 20 QOR to the agent's main address:\n${main.qore.address}\n(EVM form ${main.qore.evmAddress}). It holds ${Number(balance) / 1e6} QOR.`,
      ).catch(() => {});
    },
  });

  /**
   * Fund a user's agent key from the main key's treasury. With a gas dispenser, the transfer
   * goes through a linked key that QoreChain's native spending rule bounds (1 QOR per
   * transfer, 10 QOR per day), so automatic top-ups can never drain the treasury quickly.
   */
  async function topUp(qore) {
    const mainBalance = await main.qore.balanceUqor();
    if (mainBalance < USER_GAS_TOPUP_UQOR + 200_000n) {
      await mainKeeper.run();
      throw new Error("The agent is out of gas right now. The operator has been told.");
    }
    if (gasDispenser) {
      try {
        const { txHash } = await gasDispenser.fund(qore.address, USER_GAS_TOPUP_UQOR);
        log.info?.(`[bot] funded ${qore.address} with 1 QOR through the gas dispenser: ${txHash}`);
      } catch (error) {
        if (/spending limit|daily limit|refused/i.test(error.message)) {
          await notifyAdmin(`The gas dispenser hit its on-chain spending rule: ${error.message}`).catch(() => {});
          throw new Error("Today's gas budget, set on chain, is used up. Try again tomorrow (UTC).");
        }
        throw error;
      }
      return;
    }
    const { txHash } = await main.qore.lock(() => main.qore.sendQor(qore.address, USER_GAS_TOPUP_UQOR));
    log.info?.(`[bot] funded ${qore.address} with 1 QOR: ${txHash}`);
  }

  // One session per user, created once even when two messages arrive together.
  function session(id) {
    const key = String(id);
    if (!sessions.has(key)) {
      const pending = createSession(key);
      sessions.set(key, pending);
      pending.catch(() => sessions.delete(key));
    }
    return sessions.get(key);
  }

  async function createSession(key) {
    const state = userState(key);
    if (state.get().index === undefined) {
      // A key index costs nothing until the key is funded, which happens only after a setup.
      const next = store.get().nextIndex ?? 1;
      store.set({ nextIndex: next + 1 });
      state.set({ index: next });
    }
    const { qore, chain } = await userKey(state.get().index);
    if (state.get().account) chain.useAccount(state.get().account);
    const keeper = createKeeper({
      qore,
      targets: () => [chain.accountAddress],
      minGasUqor: USER_GAS_MIN_UQOR,
      onLowGas: () => topUp(qore),
      log,
    });
    const agent = createAgent({
      ...agentOptions,
      chain,
      factoryChain: main.chain,
      requests,
      userId: key,
      state,
      notify: (text) => notifyUser(key, text),
      canStartSetup: async () => {
        const current = state.get();
        if ((current.setups || 0) >= maxSetupsPerUser) return `You have already created ${maxSetupsPerUser} accounts. Keep using the one you have.`;
        const withAccounts = Object.values(users()).filter((u) => u.account).length;
        if (!current.account && withAccounts >= maxUsers) return "This testnet demo is full right now. Try again later.";
        return null;
      },
      onAccountReady: async (account) => {
        state.set({ setups: (state.get().setups || 0) + 1 });
        // Fund the user's agent key, register its ML-DSA-87 key and scope its window to this account.
        const result = await keeper.run();
        keeper.start();
        log.info?.(`[bot] user ${key}: account ${account}, agent key ${qore.address}, ready ${result.ready}`);
        if (!result.ready) return `I am still getting my own key ready on QoreChain (${result.reason}). I retry every few minutes; payments work once it is done.`;
        return null;
      },
    });
    if (state.get().account) keeper.start();
    return { agent, keeper, qore, chain, state };
  }

  return {
    mainKeeper,
    async start() {
      mainKeeper.start();
      if (gasDispenser) {
        // Link (and every few hours re-check) the dispenser under its native spending rule.
        const ready = () => gasDispenser.ensureReady().catch((error) => log.error?.("[gas] not ready:", error.message));
        mainKeeper.run().then(ready);
        dispenserTimer = setInterval(ready, 6 * 3600_000);
        dispenserTimer.unref?.();
      }
      // Resume every user that already has an account.
      for (const id of Object.keys(users())) if (users()[id].account) await session(id);
      scheduleTimer = setInterval(runSchedules, scheduleEveryMs);
      scheduleTimer.unref?.();
    },
    runSchedules,
    stop() {
      mainKeeper.stop();
      clearInterval(dispenserTimer);
      clearInterval(scheduleTimer);
      for (const pending of sessions.values()) pending.then((s) => s.keeper.stop(), () => {});
    },
    async handle(userId, text) {
      return (await session(userId)).agent.handle(text);
    },
    async getRequest(id) {
      const r = requests.get(id);
      return r ? (await session(r.userId)).agent.getRequest(id) : null;
    },
    async draftSetup(id, body) {
      const r = requests.get(id);
      if (!r) return { ok: false, status: 404, error: "Unknown request." };
      return (await session(r.userId)).agent.draftSetup(id, body);
    },
    async submitSignature(id, signature) {
      const r = requests.get(id);
      if (!r) return { ok: false, status: 404, error: "Unknown request." };
      return (await session(r.userId)).agent.submitSignature(id, signature);
    },
  };
}
