// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {IQorePQC} from "./interfaces/IQorePQC.sol";

/// @notice Owner authentication by post-quantum signature, shared by the account and the factory.
/// The owner signs plain text in their QoreChain wallet (QoreSign message signing v1): the wallet
/// signs "qorechain-msg-v1|<cosmos chain id>|" + text with the account's ML-DSA-87 key. The
/// contract rebuilds the same text from the call's arguments, so the owner approves exactly what
/// runs, and checks the signature with QoreChain's PQC precompiles against the key registered
/// on chain for the owner's address.
abstract contract OwnerSigned {
    using Strings for uint256;
    using Strings for address;

    IQorePQC internal constant PQC_VERIFY = IQorePQC(0x0000000000000000000000000000000000000a01);
    IQorePQC internal constant PQC_KEY_STATUS = IQorePQC(0x0000000000000000000000000000000000000a02);
    uint8 internal constant ML_DSA_87 = 1;
    /// @dev QoreX signs messages of at most 4096 bytes.
    uint256 internal constant MAX_MESSAGE = 4096;

    error SignatureExpired();
    error OwnerPqcKeyMissing();
    error InvalidOwnerSignature();
    error MessageTooLong();
    error InvalidName();

    /// @dev Revert unless `sig` is the owner's ML-DSA-87 signature over `text`.
    function _verifyOwner(address owner_, string memory chainId, bytes memory text, uint64 deadline, bytes calldata sig)
        internal
        view
    {
        if (block.timestamp > deadline) revert SignatureExpired();
        if (text.length > MAX_MESSAGE) revert MessageTooLong();
        (bool registered, uint8 algorithmId, bytes memory pubkey, bool possessionProven) =
            PQC_KEY_STATUS.pqcKeyStatus(owner_);
        if (!registered || algorithmId != ML_DSA_87 || !possessionProven || pubkey.length == 0) {
            revert OwnerPqcKeyMissing();
        }
        bytes memory signed = abi.encodePacked("qorechain-msg-v1|", chainId, "|", text);
        if (!PQC_VERIFY.pqcVerify(pubkey, sig, signed)) revert InvalidOwnerSignature();
    }

    /// @dev Names appear inside signed text, so they may not contain line breaks or control
    /// characters that could make one line look like another.
    function _checkName(string memory name) internal pure {
        bytes memory b = bytes(name);
        if (b.length == 0 || b.length > 40) revert InvalidName();
        for (uint256 i; i < b.length; i++) {
            if (uint8(b[i]) < 0x20 || uint8(b[i]) > 0x7e) revert InvalidName();
        }
    }

    /// @dev "60 fUSD", "0.5 QOR": the amount in the token's own decimals, with its symbol.
    function _amountText(address token, uint256 amount) internal view returns (string memory) {
        uint8 decimals = 18;
        string memory symbol = "QOR";
        if (token != address(0)) {
            symbol = "units";
            try IERC20Metadata(token).decimals() returns (uint8 d) {
                decimals = d;
                try IERC20Metadata(token).symbol() returns (string memory s) {
                    if (bytes(s).length > 0 && bytes(s).length <= 12) symbol = s;
                } catch {}
            } catch {
                decimals = 0;
            }
        }
        return string.concat(_decimal(amount, decimals), " ", symbol);
    }

    function _decimal(uint256 amount, uint8 decimals) internal pure returns (string memory) {
        if (decimals == 0) return amount.toString();
        uint256 unit = 10 ** decimals;
        uint256 frac = amount % unit;
        string memory whole = (amount / unit).toString();
        if (frac == 0) return whole;
        uint256 digits = decimals;
        while (frac % 10 == 0) {
            frac /= 10;
            digits--;
        }
        bytes memory f = bytes(frac.toString());
        bytes memory padded = new bytes(digits);
        uint256 pad = digits - f.length;
        for (uint256 i; i < digits; i++) {
            padded[i] = i < pad ? bytes1("0") : f[i - pad];
        }
        return string.concat(whole, ".", string(padded));
    }

    function _limitsText(address token, uint256 autoPay, uint256 maxPer, uint256 daily)
        internal
        view
        returns (string memory)
    {
        return string.concat(
            "\nauto-pay up to: ",
            _amountText(token, autoPay),
            "\nmax per payment: ",
            _amountText(token, maxPer),
            "\ndaily cap: ",
            _amountText(token, daily)
        );
    }
}
