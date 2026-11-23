// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice QoreChain post-quantum precompiles (active on the qorechain-diana testnet).
/// pqcVerify lives at 0x...0A01 and pqcKeyStatus at 0x...0A02.
/// See https://docs.qorechain.io/developer-guide/evm-precompiles
interface IQorePQC {
    /// @notice Verify an ML-DSA-87 signature.
    function pqcVerify(bytes calldata pubkey, bytes calldata signature, bytes calldata message)
        external
        view
        returns (bool valid);

    /// @notice The ML-DSA-87 key registered on chain for an account.
    /// @return registered True if a PQC key is registered
    /// @return algorithmId 1 = ML-DSA-87
    /// @return pubkey The registered public key (empty if none)
    /// @return possessionProven True only if the key was registered with a proof of possession
    function pqcKeyStatus(address account)
        external
        view
        returns (bool registered, uint8 algorithmId, bytes memory pubkey, bool possessionProven);
}
