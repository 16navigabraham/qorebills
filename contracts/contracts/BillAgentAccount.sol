// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {IQorePQC} from "./interfaces/IQorePQC.sol";

/// @title BillAgentAccount
/// @notice A smart account that holds an owner's bill money and lets one AI agent key
/// pay bills from it, only inside limits the owner sets on chain:
///   - target limit: only allowlisted billers can be paid;
///   - value limits: per token, a cap per payment and a cap per UTC day;
///   - transaction limit: a maximum number of payments per UTC day;
///   - duration limit: the agent key stops working at its expiry time;
///   - payments above the auto-pay limit need the owner's post-quantum (ML-DSA-87)
///     signature, checked on chain against the key the owner registered with QoreChain.
/// Native QOR is token address(0). Every bill reference can be paid once.
contract BillAgentAccount is ReentrancyGuard {
    using SafeERC20 for IERC20;
    using Strings for uint256;
    using Strings for address;

    IQorePQC internal constant PQC_VERIFY = IQorePQC(0x0000000000000000000000000000000000000a01);
    IQorePQC internal constant PQC_KEY_STATUS = IQorePQC(0x0000000000000000000000000000000000000a02);
    uint8 internal constant ML_DSA_87 = 1;

    struct TokenLimits {
        uint128 autoPayLimit; // the agent pays up to this alone; above it needs approval
        uint128 maxPerPayment; // hard cap for one payment, even with approval
        uint128 dailyCap; // hard cap per UTC day, approved payments included
        bool enabled;
    }

    struct Biller {
        bool allowed;
        string name;
    }

    address public immutable owner;
    /// @notice The Cosmos chain id the owner's wallet signs for, e.g. "qorechain-diana".
    string public cosmosChainId;

    address public agent;
    uint64 public agentExpiry;
    uint32 public maxPaymentsPerDay;
    bool public paused;
    /// @notice Next owner-approval nonce. Each approval can be used once, in order.
    uint256 public approvalNonce;

    mapping(address token => TokenLimits) public limits;
    mapping(address biller => Biller) internal _billers;
    address[] internal _billerList; // every biller ever set, allowed or not
    mapping(address biller => bool) internal _listed;
    mapping(address token => mapping(uint256 day => uint256)) public spentOnDay;
    mapping(uint256 day => uint256) public paymentsOnDay;
    mapping(bytes32 ref => bool) public refPaid;

    event AgentSet(address indexed agent, uint64 expiry);
    event BillerSet(address indexed biller, bool allowed, string name);
    event LimitsSet(address indexed token, uint128 autoPayLimit, uint128 maxPerPayment, uint128 dailyCap, bool enabled);
    event MaxPaymentsPerDaySet(uint32 maxPaymentsPerDay);
    event PausedSet(bool paused);
    event BillPaid(
        address indexed biller, address indexed token, uint256 amount, bytes32 indexed ref, bool ownerApproved
    );
    event Withdrawn(address indexed token, address indexed to, uint256 amount);

    error NotOwner();
    error NotAgent();
    error AgentExpired();
    error AccountPaused();
    error BillerNotAllowed(address biller);
    error TokenNotEnabled(address token);
    error ZeroAmount();
    error RefAlreadyPaid(bytes32 ref);
    error AboveMaxPerPayment(uint256 amount, uint256 max);
    error NeedsOwnerApproval(uint256 amount, uint256 autoPayLimit);
    error DailyCapExceeded(uint256 wouldSpend, uint256 cap);
    error DailyPaymentCountExceeded(uint256 max);
    error ApprovalExpired();
    error OwnerPqcKeyMissing();
    error InvalidOwnerSignature();
    error InvalidLimits();
    error NativeTransferFailed();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address owner_, string memory cosmosChainId_) {
        owner = owner_;
        cosmosChainId = cosmosChainId_;
    }

    receive() external payable {}

    // ---------------------------------------------------------------- owner

    /// @notice Set (or replace) the agent key and when it stops working. expiry 0 revokes it.
    function setAgent(address agent_, uint64 expiry) external onlyOwner {
        agent = agent_;
        agentExpiry = expiry;
        emit AgentSet(agent_, expiry);
    }

    function setBiller(address biller, bool allowed, string calldata name) external onlyOwner {
        _billers[biller] = Biller(allowed, name);
        if (!_listed[biller]) {
            _listed[biller] = true;
            _billerList.push(biller);
        }
        emit BillerSet(biller, allowed, name);
    }

    function setLimits(address token, uint128 autoPayLimit, uint128 maxPerPayment, uint128 dailyCap, bool enabled)
        external
        onlyOwner
    {
        if (autoPayLimit > maxPerPayment || maxPerPayment > dailyCap) revert InvalidLimits();
        limits[token] = TokenLimits(autoPayLimit, maxPerPayment, dailyCap, enabled);
        emit LimitsSet(token, autoPayLimit, maxPerPayment, dailyCap, enabled);
    }

    function setMaxPaymentsPerDay(uint32 max) external onlyOwner {
        maxPaymentsPerDay = max;
        emit MaxPaymentsPerDaySet(max);
    }

    function setPaused(bool paused_) external onlyOwner {
        paused = paused_;
        emit PausedSet(paused_);
    }

    /// @notice The owner can always take the money back, whatever the agent's limits.
    function withdraw(address token, address to, uint256 amount) external onlyOwner nonReentrant {
        _transfer(token, to, amount);
        emit Withdrawn(token, to, amount);
    }

    // ---------------------------------------------------------------- agent

    /// @notice Pay a bill up to the token's auto-pay limit, with no approval.
    function pay(address biller, address token, uint256 amount, bytes32 ref) external nonReentrant {
        TokenLimits memory l = _checkPayment(biller, token, amount, ref);
        if (amount > l.autoPayLimit) revert NeedsOwnerApproval(amount, l.autoPayLimit);
        _settle(biller, token, amount, ref, false);
    }

    /// @notice Pay a bill above the auto-pay limit with the owner's ML-DSA-87 signature over
    /// approvalMessage(...), made with the owner's QoreChain wallet (message signing v1).
    /// The signature is checked on chain against the owner's registered PQC key.
    function payWithApproval(
        address biller,
        address token,
        uint256 amount,
        bytes32 ref,
        uint64 deadline,
        bytes calldata pqSignature
    ) external nonReentrant {
        _checkPayment(biller, token, amount, ref);
        if (block.timestamp > deadline) revert ApprovalExpired();

        (bool registered, uint8 algorithmId, bytes memory pubkey, bool possessionProven) =
            PQC_KEY_STATUS.pqcKeyStatus(owner);
        if (!registered || algorithmId != ML_DSA_87 || !possessionProven || pubkey.length == 0) {
            revert OwnerPqcKeyMissing();
        }

        uint256 nonce = approvalNonce;
        bytes memory signed = abi.encodePacked(
            "qorechain-msg-v1|", cosmosChainId, "|", approvalMessage(biller, token, amount, ref, deadline, nonce)
        );
        if (!PQC_VERIFY.pqcVerify(pubkey, pqSignature, signed)) revert InvalidOwnerSignature();
        approvalNonce = nonce + 1;

        _settle(biller, token, amount, ref, true);
    }

    // ---------------------------------------------------------------- views

    /// @notice The text the owner signs to approve one payment. The wallet shows it as is.
    function approvalMessage(
        address biller,
        address token,
        uint256 amount,
        bytes32 ref,
        uint64 deadline,
        uint256 nonce
    ) public view returns (bytes memory) {
        bytes memory head = abi.encodePacked(
            "QoreBills payment approval\naccount: ",
            address(this).toHexString(),
            "\nevm chain: ",
            block.chainid.toString(),
            "\nbiller: ",
            biller.toHexString(),
            " (",
            _billers[biller].name,
            ")"
        );
        return abi.encodePacked(head, _approvalTail(token, amount, ref, deadline, nonce));
    }

    function _approvalTail(address token, uint256 amount, bytes32 ref, uint64 deadline, uint256 nonce)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodePacked(
            "\ntoken: ",
            token.toHexString(),
            "\namount: ",
            amount.toString(),
            "\nref: ",
            uint256(ref).toHexString(32),
            "\nvalid until: ",
            uint256(deadline).toString(),
            "\nnonce: ",
            nonce.toString()
        );
    }

    function billerInfo(address biller_) external view returns (bool allowed, string memory name) {
        Biller storage b = _billers[biller_];
        return (b.allowed, b.name);
    }

    /// @notice Every biller the owner has set, including removed ones (check billerInfo).
    function billerList() external view returns (address[] memory) {
        return _billerList;
    }

    function today() public view returns (uint256) {
        return block.timestamp / 1 days;
    }

    /// @notice What the agent can still spend today in this token.
    function remainingToday(address token) external view returns (uint256) {
        uint256 cap = limits[token].dailyCap;
        uint256 spent = spentOnDay[token][today()];
        return spent >= cap ? 0 : cap - spent;
    }

    function agentActive() public view returns (bool) {
        return agent != address(0) && block.timestamp < agentExpiry && !paused;
    }

    // ---------------------------------------------------------------- internal

    function _checkPayment(address biller_, address token, uint256 amount, bytes32 ref)
        internal
        view
        returns (TokenLimits memory l)
    {
        if (msg.sender != agent || agent == address(0)) revert NotAgent();
        if (paused) revert AccountPaused();
        if (block.timestamp >= agentExpiry) revert AgentExpired();
        if (!_billers[biller_].allowed) revert BillerNotAllowed(biller_);
        l = limits[token];
        if (!l.enabled) revert TokenNotEnabled(token);
        if (amount == 0) revert ZeroAmount();
        if (refPaid[ref]) revert RefAlreadyPaid(ref);
        if (amount > l.maxPerPayment) revert AboveMaxPerPayment(amount, l.maxPerPayment);
        uint256 day = today();
        uint256 wouldSpend = spentOnDay[token][day] + amount;
        if (wouldSpend > l.dailyCap) revert DailyCapExceeded(wouldSpend, l.dailyCap);
        if (paymentsOnDay[day] >= maxPaymentsPerDay) revert DailyPaymentCountExceeded(maxPaymentsPerDay);
    }

    function _settle(address biller_, address token, uint256 amount, bytes32 ref, bool approved) internal {
        uint256 day = today();
        spentOnDay[token][day] += amount;
        paymentsOnDay[day] += 1;
        refPaid[ref] = true;
        _transfer(token, biller_, amount);
        emit BillPaid(biller_, token, amount, ref, approved);
    }

    function _transfer(address token, address to, uint256 amount) internal {
        if (token == address(0)) {
            (bool ok,) = to.call{value: amount}("");
            if (!ok) revert NativeTransferFailed();
        } else {
            IERC20(token).safeTransfer(to, amount);
        }
    }
}
