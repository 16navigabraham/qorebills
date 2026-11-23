import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  defineChain,
  getAddress,
  http,
  keccak256,
  parseEventLogs,
  toBytes,
  toHex,
  zeroAddress,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { billAgentAccountAbi as abi, billAgentFactoryAbi as factoryAbi, erc20Abi } from "./abi.js";

/** A refusal from a contract, with its custom error name and arguments. */
export class ContractRefusal extends Error {
  constructor(errorName, args) {
    super(errorName);
    this.errorName = errorName;
    this.args = args || [];
  }
}

/** Bill references are stored on chain as keccak256 of their text. */
export const refHash = (ref) => keccak256(toBytes(ref));
const text = (bytes) => new TextDecoder().decode(toBytes(bytes));

function refusalFrom(error) {
  if (error instanceof BaseError) {
    const revert = error.walk((e) => e instanceof ContractFunctionRevertedError);
    if (revert?.data?.errorName) return new ContractRefusal(revert.data.errorName, revert.data.args);
  }
  return null;
}

export function createChain({ rpcUrl, evmChainId, privateKey, tokens, factoryAddress, accountAddress = null, lock = (fn) => fn() }) {
  const chain = defineChain({
    id: evmChainId,
    name: "QoreChain",
    nativeCurrency: { name: "QOR", symbol: "QOR", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  const transport = http(rpcUrl, { timeout: 30_000, retryCount: 2 });
  const publicClient = createPublicClient({ chain, transport });
  const agent = privateKeyToAccount(privateKey);
  const wallet = createWalletClient({ chain, transport, account: agent });
  const factory = { address: getAddress(factoryAddress), abi: factoryAbi };
  let account = accountAddress ? getAddress(accountAddress) : null;

  const contract = () => {
    if (!account) throw new Error("No account set up yet.");
    return { address: account, abi };
  };
  const read = (functionName, args = []) => publicClient.readContract({ ...contract(), functionName, args });

  // Gas limits per call. The public QoreChain RPC caps eth_call and eth_estimateGas at
  // about 5M gas, below what createAccount needs, so the agent never relies on estimates.
  const GAS = { pay: 400_000n, payWithApproval: 1_000_000n, executeSigned: 1_000_000n, createAccount: 7_500_000n };

  async function sendNow(target, functionName, args) {
    const gas = GAS[functionName];
    let request;
    try {
      ({ request } = await publicClient.simulateContract({ ...target, functionName, args, account: agent, gas }));
    } catch (error) {
      const refusal = refusalFrom(error);
      if (refusal) throw refusal;
      // Simulation ran out of the RPC's gas cap: send with the fixed limit; a real refusal still reverts on chain.
      if (!/out of gas|gas required exceeds|gas uint64 overflow/i.test(String(error?.details || error?.message))) throw error;
      request = { ...target, functionName, args, account: agent, chain };
    }
    const hash = await wallet.writeContract({ ...request, gas });
    const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
    if (receipt.status !== "success") throw new Error(`Transaction ${hash} reverted.`);
    return { hash, receipt };
  }

  // Transactions from one key go one at a time: its EVM nonce is also its Cosmos sequence.
  const send = (target, functionName, args) => lock(() => sendNow(target, functionName, args));

  return {
    agentAddress: agent.address,
    publicClient,
    get accountAddress() {
      return account;
    },
    useAccount(address) {
      account = address ? getAddress(address) : null;
    },

    async billers() {
      const list = await read("billerList");
      const infos = await Promise.all(list.map((address) => read("billerInfo", [address])));
      return list.map((address, i) => ({ address, allowed: infos[i][0], name: infos[i][1] }));
    },

    async tokenState(token) {
      const [limits, remainingToday, balance] = await Promise.all([
        read("limits", [token.address]),
        read("remainingToday", [token.address]),
        token.address === zeroAddress
          ? publicClient.getBalance({ address: account })
          : publicClient.readContract({ address: token.address, abi: erc20Abi, functionName: "balanceOf", args: [account] }),
      ]);
      const [autoPayLimit, maxPerPayment, dailyCap, enabled] = limits;
      return { ...token, autoPayLimit, maxPerPayment, dailyCap, enabled, remainingToday, balance };
    },

    async snapshot() {
      const [agentKey, agentExpiry, paused, maxPaymentsPerDay, nonce, today, owner] = await Promise.all([
        read("agent"),
        read("agentExpiry"),
        read("paused"),
        read("maxPaymentsPerDay"),
        read("nonce"),
        read("today"),
        read("owner"),
      ]);
      const [paymentsToday, tokenStates, billers] = await Promise.all([
        read("paymentsOnDay", [today]),
        Promise.all(tokens.map((t) => this.tokenState(t))),
        this.billers(),
      ]);
      return { owner, agent: agentKey, agentExpiry, paused, maxPaymentsPerDay, paymentsToday, nonce, tokens: tokenStates, billers };
    },

    refPaid: (ref) => read("refPaid", [refHash(ref)]),
    nonce: () => read("nonce"),
    owner: () => read("owner"),

    /** The exact text the owner's wallet signs to approve a payment. */
    async approvalMessage({ biller, token, amount, ref, deadline, nonce }) {
      return text(await read("approvalMessage", [biller, token, amount, refHash(ref), BigInt(deadline), nonce]));
    },

    /** The exact text the owner's wallet signs to change a setting. */
    async actionMessage({ action, deadline, nonce }) {
      return text(await read("actionMessage", [action, BigInt(deadline), nonce]));
    },

    pay: ({ biller, token, amount, ref }) => send(contract(), "pay", [biller, token, amount, refHash(ref)]),

    payWithApproval: ({ biller, token, amount, ref, deadline, signature }) =>
      send(contract(), "payWithApproval", [biller, token, amount, refHash(ref), BigInt(deadline), toHex(signature)]),

    executeSigned: ({ action, deadline, signature }) =>
      send(contract(), "executeSigned", [action, BigInt(deadline), toHex(signature)]),

    /** The exact text the owner's wallet signs to create an account. */
    async setupMessage({ owner, config, setupId, deadline }) {
      return text(
        await publicClient.readContract({ ...factory, functionName: "setupMessage", args: [owner, config, setupId, BigInt(deadline)] }),
      );
    },

    async createAccount({ owner, config, setupId, deadline, signature }) {
      const { hash, receipt } = await send(factory, "createAccount", [owner, config, setupId, BigInt(deadline), toHex(signature)]);
      const [created] = parseEventLogs({ abi: factoryAbi, eventName: "AccountCreated", logs: receipt.logs });
      return { hash, account: created.args.account };
    },

    accountOf: (owner) => publicClient.readContract({ ...factory, functionName: "accountOf", args: [owner] }),

    async recentPayments({ blocks = 20_000n } = {}) {
      const latest = await publicClient.getBlockNumber();
      const fromBlock = latest > blocks ? latest - blocks : 0n;
      const logs = await publicClient.getContractEvents({ ...contract(), eventName: "BillPaid", fromBlock, toBlock: latest });
      return logs.map((log) => ({ ...log.args, hash: log.transactionHash, blockNumber: log.blockNumber }));
    },
  };
}
