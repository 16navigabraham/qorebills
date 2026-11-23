// Keeps the agent's own QoreChain account usable: asks the owner for gas when it runs
// low, registers the agent's ML-DSA-87 key once, and keeps a scoped EVM window open
// whose allowed targets are only the QoreBills factory and the owner's account.

const MIN_GAS_UQOR = 2_000_000n; // 2 QOR
const WINDOW = { blocks: 17_280, maxTxs: 1_000, maxValueUqor: 20_000_000n }; // the longest window the chain allows
const RENEW_BELOW = { blocks: 1_500n, txs: 20n, valueUqor: 2_000_000n };

export function createKeeper({ qore, chain, factoryAddress, notify, log = console, intervalMs = 10 * 60_000 }) {
  let lastFundingAsk = 0;
  let timer = null;
  let running = null;

  const targets = () => [factoryAddress, chain.accountAddress].filter(Boolean).map((a) => a.toLowerCase());

  async function tick() {
    const balance = await qore.balanceUqor();
    if (balance < MIN_GAS_UQOR) {
      if (Date.now() - lastFundingAsk > 6 * 3600_000) {
        lastFundingAsk = Date.now();
        await notify(
          `I need test QOR for gas. Send about 20 QOR from QoreX to my address:\n${qore.address}\n(EVM form ${qore.evmAddress}). I have ${Number(balance) / 1e6} QOR.`,
        ).catch(() => {});
      }
      if (balance === 0n) return { ready: false, reason: "unfunded" };
    }

    const reg = await qore.ensureRegistered();
    if (!reg.already) log.info?.(`[keeper] registered the agent's ML-DSA-87 key: ${reg.txHash}`);

    const w = await qore.window();
    const want = targets();
    const have = (w.allowedTargets || []).map((a) => a.toLowerCase());
    const scopeChanged = want.length !== have.length || want.some((a) => !have.includes(a));
    const low =
      !w.live ||
      BigInt(w.remainingBlocks) < RENEW_BELOW.blocks ||
      BigInt(w.remainingTxs) < RENEW_BELOW.txs ||
      BigInt(w.remainingValue) < RENEW_BELOW.valueUqor;
    if (scopeChanged || low) {
      const { txHash } = await qore.openWindow({ ...WINDOW, allowedTargets: want });
      log.info?.(`[keeper] opened a scoped EVM window for ${want.join(", ")}: ${txHash}`);
    }
    return { ready: true };
  }

  async function run() {
    if (running) return running;
    running = tick()
      .catch((error) => {
        log.error?.("[keeper] failed:", error.message);
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
