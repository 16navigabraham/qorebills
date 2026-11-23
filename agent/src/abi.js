import { parseAbi } from "viem";

const types = [
  "struct TokenConfig { address token; uint128 autoPayLimit; uint128 maxPerPayment; uint128 dailyCap; }",
  "struct BillerConfig { address biller; string name; }",
  "struct AccountConfig { address agent; uint64 agentExpiry; uint32 maxPaymentsPerDay; TokenConfig[] tokens; BillerConfig[] billers; }",
  "struct OwnerAction { uint8 kind; address target; address token; uint128 a; uint128 b; uint128 c; string name; }",
];

const ownerErrors = [
  "error SignatureExpired()",
  "error OwnerPqcKeyMissing()",
  "error InvalidOwnerSignature()",
  "error MessageTooLong()",
  "error InvalidName()",
];

// The parts of BillAgentAccount (../contracts) the agent uses.
export const billAgentAccountAbi = parseAbi([
  ...types,
  ...ownerErrors,
  "function owner() view returns (address)",
  "function agent() view returns (address)",
  "function agentExpiry() view returns (uint64)",
  "function paused() view returns (bool)",
  "function maxPaymentsPerDay() view returns (uint32)",
  "function nonce() view returns (uint256)",
  "function cosmosChainId() view returns (string)",
  "function limits(address token) view returns (uint128 autoPayLimit, uint128 maxPerPayment, uint128 dailyCap, bool enabled)",
  "function remainingToday(address token) view returns (uint256)",
  "function today() view returns (uint256)",
  "function paymentsOnDay(uint256 day) view returns (uint256)",
  "function refPaid(bytes32 ref) view returns (bool)",
  "function billerList() view returns (address[])",
  "function billerInfo(address biller) view returns (bool allowed, string name)",
  "function approvalMessage(address biller, address token, uint256 amount, bytes32 ref, uint64 deadline, uint256 n) view returns (bytes)",
  "function actionMessage(OwnerAction action, uint64 deadline, uint256 n) view returns (bytes)",
  "function pay(address biller, address token, uint256 amount, bytes32 ref)",
  "function payWithApproval(address biller, address token, uint256 amount, bytes32 ref, uint64 deadline, bytes pqSignature)",
  "function executeSigned(OwnerAction action, uint64 deadline, bytes pqSignature)",
  "event BillPaid(address indexed biller, address indexed token, uint256 amount, bytes32 indexed ref, bool ownerApproved)",
  "error NotOwner()",
  "error NotAgent()",
  "error AgentExpired()",
  "error AccountPaused()",
  "error BillerNotAllowed(address biller)",
  "error TokenNotEnabled(address token)",
  "error ZeroAmount()",
  "error ZeroAddress()",
  "error RefAlreadyPaid(bytes32 ref)",
  "error AboveMaxPerPayment(uint256 amount, uint256 max)",
  "error NeedsOwnerApproval(uint256 amount, uint256 autoPayLimit)",
  "error DailyCapExceeded(uint256 wouldSpend, uint256 cap)",
  "error DailyPaymentCountExceeded(uint256 max)",
  "error InvalidLimits()",
  "error NativeTransferFailed()",
]);

export const billAgentFactoryAbi = parseAbi([
  ...types,
  ...ownerErrors,
  "function accountOf(address owner) view returns (address)",
  "function isAccount(address account) view returns (bool)",
  "function setupMessage(address owner, AccountConfig config, bytes16 setupId, uint64 deadline) view returns (bytes)",
  "function createAccount(address owner, AccountConfig config, bytes16 setupId, uint64 deadline, bytes pqSignature) returns (address)",
  "event AccountCreated(address indexed owner, address indexed account, address indexed agent, bytes16 setupId)",
  "error SetupAlreadyUsed()",
  "error TooManyEntries()",
  "error InvalidLimits()",
]);

export const erc20Abi = parseAbi(["function balanceOf(address) view returns (uint256)"]);

/** OwnerAction kinds, as in contracts/BillTypes.sol. */
export const Kind = {
  SetBiller: 0,
  RemoveBiller: 1,
  SetLimits: 2,
  DisableToken: 3,
  SetAgent: 4,
  SetMaxPaymentsPerDay: 5,
  Pause: 6,
  Unpause: 7,
  Withdraw: 8,
};
