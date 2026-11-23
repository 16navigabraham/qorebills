// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {BillAgentAccount} from "./BillAgentAccount.sol";
import {AccountConfig} from "./BillTypes.sol";
import {OwnerSigned} from "./OwnerSigned.sol";

/// @notice Holds the account's creation code, so the factory itself stays under the
/// 24 KB contract size limit. Only the factory that created it can use it.
contract BillAgentDeployer {
    address public immutable factory = msg.sender;

    error OnlyFactory();

    function deploy(address owner, string calldata cosmosChainId, AccountConfig calldata config)
        external
        returns (address)
    {
        if (msg.sender != factory) revert OnlyFactory();
        return address(new BillAgentAccount(owner, cosmosChainId, config));
    }
}

/// @title BillAgentFactory
/// @notice Creates a BillAgentAccount from its owner's post-quantum signed setup. The owner
/// signs the setup text in their QoreChain wallet; anyone (normally the agent) submits it, so
/// the owner needs no gas and no EVM window to get started.
contract BillAgentFactory is OwnerSigned {
    using Strings for uint256;
    using Strings for address;

    uint256 public constant MAX_TOKENS = 4;
    uint256 public constant MAX_BILLERS = 12;

    /// @notice The Cosmos chain id owners sign for, e.g. "qorechain-diana".
    string public cosmosChainId;
    BillAgentDeployer public immutable deployer;
    /// @notice The latest account created for each owner.
    mapping(address owner => address account) public accountOf;
    mapping(address account => bool) public isAccount;
    mapping(bytes16 setupId => bool) public setupUsed;

    event AccountCreated(address indexed owner, address indexed account, address indexed agent, bytes16 setupId);

    error SetupAlreadyUsed();
    error TooManyEntries();

    constructor(string memory cosmosChainId_) {
        cosmosChainId = cosmosChainId_;
        deployer = new BillAgentDeployer();
    }

    /// @notice Create the owner's account with the settings they signed.
    function createAccount(
        address owner,
        AccountConfig calldata config,
        bytes16 setupId,
        uint64 deadline,
        bytes calldata pqSignature
    ) external returns (address account) {
        if (setupUsed[setupId]) revert SetupAlreadyUsed();
        _verifyOwner(owner, cosmosChainId, setupMessage(owner, config, setupId, deadline), deadline, pqSignature);
        setupUsed[setupId] = true;
        account = deployer.deploy(owner, cosmosChainId, config);
        accountOf[owner] = account;
        isAccount[account] = true;
        emit AccountCreated(owner, account, config.agent, setupId);
    }

    /// @notice The text the owner signs to create an account. The wallet shows it as is.
    function setupMessage(address owner, AccountConfig calldata config, bytes16 setupId, uint64 deadline)
        public
        view
        returns (bytes memory text)
    {
        if (config.tokens.length > MAX_TOKENS || config.billers.length > MAX_BILLERS) revert TooManyEntries();
        text = abi.encodePacked(
            "QoreBills: create my bill account\nowner: ",
            owner.toHexString(),
            "\nagent: ",
            config.agent.toHexString(),
            "\nagent expires: ",
            uint256(config.agentExpiry).toString(),
            "\npayments per day: ",
            uint256(config.maxPaymentsPerDay).toString()
        );
        for (uint256 i; i < config.tokens.length; i++) {
            text = abi.encodePacked(
                text,
                "\n\ntoken: ",
                config.tokens[i].token.toHexString(),
                _limitsText(
                    config.tokens[i].token,
                    config.tokens[i].autoPayLimit,
                    config.tokens[i].maxPerPayment,
                    config.tokens[i].dailyCap
                )
            );
        }
        text = abi.encodePacked(text, "\n");
        for (uint256 i; i < config.billers.length; i++) {
            _checkName(config.billers[i].name);
            text = abi.encodePacked(
                text, "\nbiller: ", config.billers[i].name, " ", config.billers[i].biller.toHexString()
            );
        }
        text = abi.encodePacked(
            text,
            "\n\nsetup: ",
            uint256(uint128(setupId)).toHexString(16),
            "\nevm chain: ",
            block.chainid.toString(),
            "\nfactory: ",
            address(this).toHexString(),
            "\nvalid until: ",
            uint256(deadline).toString()
        );
    }
}
