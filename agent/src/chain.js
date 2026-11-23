import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  defineChain,
  getAddress,
  http,
  keccak256,
  toBytes,
  toHex,
  zeroAddress,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { billAgentAccountAbi as abi, erc20Abi } from "./abi.js";

/** A refusal from the contract, with its custom error name and arguments. */
export class ContractRefusal extends Error {
  constructor(errorName, args) {
    super(errorName);
    this.errorName = errorName;
    this.args = args || [];
  }
}

/** Bill references are stored on chain as keccak256 of their text. */
export const refHash = (ref) => keccak256(toBytes(ref));

function refusalFrom(error) {
  if (error instanceof BaseError) {
    const revert = error.walk((e) => e instanceof ContractFunctionRevertedError);
    if (revert?.data?.errorName) return new ContractRefusal(revert.data.errorName, revert.data.args);
  }
  return null;
}

export function createChain({ rpcUrl, evmChainId, accountAddress, privateKey, tokens }) {
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
  const contract = { address: getAddress(accountAddress), abi };
  const read = (functionName, args = []) => publicClient.readContract({ ...contract, functionName, args });

  async function send(functionName, args) {
    let request;
    try {
      ({ request } = await publicClient.simulateContract({ ...contract, functionName, args, account: agent }));
    } catch (error) {
      throw refusalFrom(error) || error;
    }
    const hash = await wallet.writeContract(request);
    const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
    if (receipt.status !== "success") throw new Error(`Transaction ${hash} reverted.`);
    return { hash, blockNumber: receipt.blockNumber };
  }

  return {
    agentAddress: agent.address,
    accountAddress: contract.address,
    publicClient,

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
          ? publicClient.getBalance({ address: contract.address })
          : publicClient.readContract({ address: token.address, abi: erc20Abi, functionName: "balanceOf", args: [contract.address] }),
      ]);
      const [autoPayLimit, maxPerPayment, dailyCap, enabled] = limits;
      return { ...token, autoPayLimit, maxPerPayment, dailyCap, enabled, remainingToday, balance };
    },

    async snapshot() {
      const [agentKey, agentExpiry, paused, maxPaymentsPerDay, approvalNonce, today, owner] = await Promise.all([
        read("agent"),
        read("agentExpiry"),
        read("paused"),
        read("maxPaymentsPerDay"),
        read("approvalNonce"),
        read("today"),
        read("owner"),
      ]);
      const [paymentsToday, tokenStates, billers] = await Promise.all([
        read("paymentsOnDay", [today]),
        Promise.all(tokens.map((t) => this.tokenState(t))),
        this.billers(),
      ]);
      return { owner, agent: agentKey, agentExpiry, paused, maxPaymentsPerDay, paymentsToday, approvalNonce, tokens: tokenStates, billers };
    },

    refPaid: (ref) => read("refPaid", [refHash(ref)]),
    approvalNonce: () => read("approvalNonce"),
    owner: () => read("owner"),

    /** The exact text the owner's wallet signs, as a string. */
    async approvalMessage({ biller, token, amount, ref, deadline, nonce }) {
      const bytes = await read("approvalMessage", [biller, token, amount, refHash(ref), BigInt(deadline), nonce]);
      return new TextDecoder().decode(toBytes(bytes));
    },

    pay: ({ biller, token, amount, ref }) => send("pay", [biller, token, amount, refHash(ref)]),

    payWithApproval: ({ biller, token, amount, ref, deadline, signature }) =>
      send("payWithApproval", [biller, token, amount, refHash(ref), BigInt(deadline), toHex(signature)]),

    async recentPayments({ blocks = 20_000n } = {}) {
      const latest = await publicClient.getBlockNumber();
      const fromBlock = latest > blocks ? latest - blocks : 0n;
      const logs = await publicClient.getContractEvents({ ...contract, eventName: "BillPaid", fromBlock, toBlock: latest });
      return logs.map((log) => ({ ...log.args, hash: log.transactionHash, blockNumber: log.blockNumber }));
    },
  };
}
