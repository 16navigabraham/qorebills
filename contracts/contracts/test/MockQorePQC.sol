// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev Test stand-in for the QoreChain PQC precompiles. Its code is placed at
/// 0x...0A01 and 0x...0A02 in tests. A "signature" is valid when it equals
/// keccak256(pubkey, message), which lets tests sign without ML-DSA.
contract MockQorePQC {
    struct Key {
        bool registered;
        uint8 algorithmId;
        bytes pubkey;
        bool possessionProven;
    }

    mapping(address => Key) internal keys;

    function setKey(address account, bool registered, uint8 algorithmId, bytes calldata pubkey, bool possessionProven)
        external
    {
        keys[account] = Key(registered, algorithmId, pubkey, possessionProven);
    }

    function pqcVerify(bytes calldata pubkey, bytes calldata signature, bytes calldata message)
        external
        pure
        returns (bool)
    {
        return keccak256(signature) == keccak256(abi.encodePacked(keccak256(abi.encodePacked(pubkey, message))));
    }

    function pqcKeyStatus(address account) external view returns (bool, uint8, bytes memory, bool) {
        Key storage k = keys[account];
        return (k.registered, k.algorithmId, k.pubkey, k.possessionProven);
    }
}
