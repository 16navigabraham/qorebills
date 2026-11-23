// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {OwnerSigned} from "./OwnerSigned.sol";
import {AccountConfig, ActionKind, OwnerAction} from "./BillTypes.sol";

/// @title BillAgentAccount
/// @notice A smart account that holds an owner's bill money and lets one AI agent key
/// pay bills from it, only inside limits the owner sets on chain:
///   - target limit: only allowlisted billers can be paid;
///   - value limits: per token, a cap per payment and a cap per UTC day;
///   - transaction limit: a maximum number of payments per UTC day;
///   - duration limit: the agent key stops working at its expiry time;
///   - payments above the auto-pay limit need the owner's post-quantum (ML-DSA-87)
///     signature, checked on chain against the key the owner registered with QoreChain.
/// The owner changes settings either with a transaction or with a signed message that
/// anyone (normally the agent) can submit, so the owner never needs gas or an EVM window.
/// Native QOR is token address(0). Every bill reference can be paid once.
contract BillAgentAccount is OwnerSigned, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using Strings for uint256;
    using Strings for address;

    struct TokenLimits {
        uint128 autoPayLimit;
        uint128 maxPerPayment;
        uint128 dailyCap;
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
    /// @notice Next nonce for the owner's signed messages (payment approvals and settings).
    /// Each signed message can be used once, in order.
    uint256 public nonce;

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
    event OwnerSignedAction(ActionKind indexed kind, uint256 nonce);
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
    error ZeroAddress();
    error RefAlreadyPaid(bytes32 ref);
    error AboveMaxPerPayment(uint256 amount, uint256 max);
    error NeedsOwnerApproval(uint256 amount, uint256 autoPayLimit);
    error DailyCapExceeded(uint256 wouldSpend, uint256 cap);
    error DailyPaymentCountExceeded(uint256 max);
    error InvalidLimits();
    error NativeTransferFailed();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address owner_, string memory cosmosChainId_, AccountConfig memory config) {
        if (owner_ == address(0)) revert ZeroAddress();
        owner = owner_;
        cosmosChainId = cosmosChainId_;
        _setAgent(config.agent, config.agentExpiry);
        _setMaxPaymentsPerDay(config.maxPaymentsPerDay);
        for (uint256 i; i < config.tokens.length; i++) {
            _setLimits(
                config.tokens[i].token,
                config.tokens[i].autoPayLimit,
                config.tokens[i].maxPerPayment,
                config.tokens[i].dailyCap,
                true
            );
        }
        for (uint256 i; i < config.billers.length; i++) {
            _setBiller(config.billers[i].biller, true, config.billers[i].name);
        }
    }

    receive() external payable {}

    // ---------------------------------------------------------------- owner

    /// @notice Change a setting with a transaction from the owner.
    function execute(OwnerAction calldata action) external onlyOwner nonReentrant {
        _apply(action);
    }

    /// @notice Change a setting with the owner's ML-DSA-87 signature over
    /// actionMessage(action, deadline, nonce). Anyone can submit it.
    function executeSigned(OwnerAction calldata action, uint64 deadline, bytes calldata pqSignature)
        external
        nonReentrant
    {
        uint256 n = nonce;
        _verifyOwner(owner, cosmosChainId, actionMessage(action, deadline, n), deadline, pqSignature);
        nonce = n + 1;
        emit OwnerSignedAction(action.kind, n);
        _apply(action);
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
    function payWithApproval(
        address biller,
        address token,
        uint256 amount,
        bytes32 ref,
        uint64 deadline,
        bytes calldata pqSignature
    ) external nonReentrant {
        _checkPayment(biller, token, amount, ref);
        uint256 n = nonce;
        _verifyOwner(owner, cosmosChainId, approvalMessage(biller, token, amount, ref, deadline, n), deadline, pqSignature);
        nonce = n + 1;
        _settle(biller, token, amount, ref, true);
    }

    // ---------------------------------------------------------------- signed text

    /// @notice The text the owner signs to approve one payment. The wallet shows it as is.
    function approvalMessage(address biller, address token, uint256 amount, bytes32 ref, uint64 deadline, uint256 n)
        public
        view
        returns (bytes memory)
    {
        return abi.encodePacked(
            "QoreBills payment approval\nbiller: ",
            _billers[biller].name,
            " ",
            biller.toHexString(),
            "\namount: ",
            _amountText(token, amount),
            "\ntoken: ",
            token.toHexString(),
            "\nref: ",
            uint256(ref).toHexString(32),
            _footer(deadline, n)
        );
    }

    /// @notice The text the owner signs to change a setting.
    function actionMessage(OwnerAction calldata action, uint64 deadline, uint256 n)
        public
        view
        returns (bytes memory)
    {
        return abi.encodePacked("QoreBills settings change\n", _actionText(action), _footer(deadline, n));
    }

    function _actionText(OwnerAction calldata x) internal view returns (string memory) {
        ActionKind k = x.kind;
        if (k == ActionKind.SetBiller) return string.concat("allow biller: ", x.name, " ", x.target.toHexString());
        if (k == ActionKind.RemoveBiller) {
            return string.concat("remove biller: ", _billers[x.target].name, " ", x.target.toHexString());
        }
        if (k == ActionKind.SetLimits) {
            return string.concat("set limits for ", x.token.toHexString(), _limitsText(x.token, x.a, x.b, x.c));
        }
        if (k == ActionKind.DisableToken) return string.concat("stop payments in ", x.token.toHexString());
        if (k == ActionKind.SetAgent) {
            if (x.target == address(0)) return "revoke the agent";
            return string.concat("agent: ", x.target.toHexString(), "\nagent expires: ", uint256(x.a).toString());
        }
        if (k == ActionKind.SetMaxPaymentsPerDay) return string.concat("payments per day: ", uint256(x.a).toString());
        if (k == ActionKind.Pause) return "pause all payments";
        if (k == ActionKind.Unpause) return "resume payments";
        return string.concat("withdraw: ", _amountText(x.token, x.a), "\nto: ", x.target.toHexString());
    }

    function _footer(uint64 deadline, uint256 n) internal view returns (string memory) {
        return string.concat(
            "\naccount: ",
            address(this).toHexString(),
            "\nevm chain: ",
            block.chainid.toString(),
            "\nvalid until: ",
            uint256(deadline).toString(),
            "\nnonce: ",
            n.toString()
        );
    }

    // ---------------------------------------------------------------- views

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

    function _apply(OwnerAction calldata x) internal {
        ActionKind k = x.kind;
        if (k == ActionKind.SetBiller) {
            _setBiller(x.target, true, x.name);
        } else if (k == ActionKind.RemoveBiller) {
            _setBiller(x.target, false, _billers[x.target].name);
        } else if (k == ActionKind.SetLimits) {
            _setLimits(x.token, x.a, x.b, x.c, true);
        } else if (k == ActionKind.DisableToken) {
            _setLimits(x.token, 0, 0, 0, false);
        } else if (k == ActionKind.SetAgent) {
            _setAgent(x.target, uint64(x.a));
        } else if (k == ActionKind.SetMaxPaymentsPerDay) {
            _setMaxPaymentsPerDay(uint32(x.a));
        } else if (k == ActionKind.Pause || k == ActionKind.Unpause) {
            paused = k == ActionKind.Pause;
            emit PausedSet(paused);
        } else {
            if (x.target == address(0)) revert ZeroAddress();
            _transfer(x.token, x.target, x.a);
            emit Withdrawn(x.token, x.target, x.a);
        }
    }

    function _setAgent(address agent_, uint64 expiry) internal {
        agent = agent_;
        agentExpiry = agent_ == address(0) ? 0 : expiry;
        emit AgentSet(agent_, agentExpiry);
    }

    function _setBiller(address biller_, bool allowed, string memory name) internal {
        if (biller_ == address(0)) revert ZeroAddress();
        _checkName(name);
        _billers[biller_] = Biller(allowed, name);
        if (!_listed[biller_]) {
            _listed[biller_] = true;
            _billerList.push(biller_);
        }
        emit BillerSet(biller_, allowed, name);
    }

    function _setLimits(address token, uint128 autoPay, uint128 maxPer, uint128 daily, bool enabled) internal {
        if (enabled && (autoPay > maxPer || maxPer > daily || daily == 0)) revert InvalidLimits();
        limits[token] = TokenLimits(autoPay, maxPer, daily, enabled);
        emit LimitsSet(token, autoPay, maxPer, daily, enabled);
    }

    function _setMaxPaymentsPerDay(uint32 max) internal {
        maxPaymentsPerDay = max;
        emit MaxPaymentsPerDaySet(max);
    }

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
