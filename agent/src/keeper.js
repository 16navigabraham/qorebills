// Keeps one of the agent's QoreChain accounts usable: makes sure it has gas, registers
// its ML-DSA-87 key once, and keeps a scoped EVM window open whose allowed targets are
// only the contracts that key needs (the factory for the main key, the user's own
// account for a user's agent key). On QoreChain an account's EVM transactions are only
// admitted inside such a window, so a stolen agent key can call nothing else.

const WINDOW = { blocks: 17_280, maxTxs: 1_000, maxValueUqor: 20_000_000n }; // the longest window the chain allows
const RENEW_BELOW = { blocks: 1_500n, txs: 20n, valueUqor: 2_000_000n };

/**
 * @param qore       the account (from qorechain.js)
 * @param targets    () => contract addresses the window may call; no window while empty
 * @param minGasUqor below this balance, onLowGas is called
 * @param onLowGas   async (balanceUqor) => void: top the key up or tell someone
 */
export function createKeeper({ qore, targets, minGasUqor = 2_000_000n, onLowGas = async () => {}, window = WINDOW, log = console, intervalMs = 10 * 60_000 }) {
  let timer = null;
  let running = null;

  async function tick() {
    let balance = await qore.balanceUqor();
    if (balance < minGasUqor) {
      await onLowGas(balance);
      balance = await qore.balanceUqor();
      if (balance === 0n) return { ready: false, reason: "unfunded" };
    }
    const want = targets().filter(Boolean).map((a) => a.toLowerCase());
    if (!want.length) return { ready: false, reason: "no targets" };

    return qore.lock(async () => {
      const reg = await qore.ensureRegistered();
      if (!reg.already) log.info?.(`[keeper] ${qore.address} registered its ML-DSA-87 key: ${reg.txHash}`);

      const w = await qore.window();
      const have = (w.allowedTargets || []).map((a) => a.toLowerCase());
      const scopeChanged = want.length !== have.length || want.some((a) => !have.includes(a));
      const low =
        !w.live ||
        BigInt(w.remainingBlocks) < RENEW_BELOW.blocks ||
        BigInt(w.remainingTxs) < RENEW_BELOW.txs ||
        BigInt(w.remainingValue) < RENEW_BELOW.valueUqor;
      if (scopeChanged || low) {
        const { txHash } = await qore.openWindow({ ...window, allowedTargets: want });
        log.info?.(`[keeper] ${qore.address} opened an EVM window scoped to ${want.join(", ")}: ${txHash}`);
      }
      return { ready: true };
    });
  }

  async function run() {
    if (running) return running;
    running = tick()
      .catch((error) => {
        log.error?.(`[keeper] ${qore.address} failed:`, error.message);
        return { ready: false, reason: error.message };
      })
      .finally(() => {
        running = null;
      });
    return running;
  }

  return {
    run,
    start() {
      run();
      timer = setInterval(run, intervalMs);
      timer.unref?.();
    },
    stop() {
      clearInterval(timer);
    },
  };
}
