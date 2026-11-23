# Signed messages

Everything the owner authorises in QoreBills is a **plain-text message signed with the owner's ML-DSA-87 key** in the QoreX wallet, using QoreSign *message signing v1* (`signArbitrary`). This page documents the exact bytes, so anyone can check what a signature means.

## How a message is signed and verified

1. The contract renders the text from the call's own arguments: `BillAgentFactory.setupMessage`, `BillAgentAccount.approvalMessage` or `BillAgentAccount.actionMessage`.
2. The agent fetches that text with an `eth_call` and shows it on the signing page.
3. QoreX shows the text to the owner and signs:

   ```text
   ML-DSA-87.Sign(ownerKey, UTF-8("qorechain-msg-v1|" + "qorechain-diana" + "|") || text)
   ```

4. The agent submits the call with the signature (`pq.signature` from the wallet's answer, 4,627 bytes).
5. The contract **re-renders the text itself** from the submitted arguments and the current nonce, and then:
   - reads the owner's registered key from **PQC Key Status** (`0x…0A02`), requiring `registered`, algorithm `1` (ML-DSA-87), `possessionProven` and a non-empty key;
   - calls **PQC Verify** (`0x…0A01`) with that key, the signature and `"qorechain-msg-v1|" + cosmosChainId + "|" + text`;
   - checks the deadline and that the text is at most 4,096 bytes (the QoreX limit).

Because the contract renders the text itself, a signature can't be paired with different arguments: any change to the biller, amount, token, reference, limits, target, deadline or nonce changes the text, and the signature no longer verifies.

## What binds each signature

| Field | Protects against |
|---|---|
| `qorechain-msg-v1\|qorechain-diana\|` (added by the wallet) | Reusing the signature as a transaction, a key registration or a sign-in, or on another QoreChain network |
| `account:` (approvals and settings) or `factory:` (setup) | Using the signature on another user's account or another factory |
| `evm chain:` | Using it on another EVM chain |
| `valid until:` (unix seconds) | Using an old signature later |
| `nonce:` (approvals and settings; one counter per account) | Replaying a signature; each nonce works once, in order |
| `setup:` (a random 16-byte id; each id works once) | Creating a second account from the same setup signature |

## Formats

Addresses are lower-case `0x` hex. Amounts are written in the token's own units with its symbol (from the token's `decimals()` and `symbol()`; native QOR is 18 decimals). The examples below come from the contracts on a local test chain (EVM chain id `31337`, test token `tUSD`); on the testnet the chain id is `9800` and fUSD shows as `fUSD`.

### Account setup (`BillAgentFactory.setupMessage`)

```text
QoreBills: create my bill account
owner: 0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266
agent: 0x70997970c51812dc3a010c7d01b50e0d17dc79c8
agent expires: 1798761600
payments per day: 5

token: 0x9fe46736679d2d9a65f0992f2272de9f3c7fa6e0
auto-pay up to: 20 tUSD
max per payment: 100 tUSD
daily cap: 150 tUSD

biller: IBEDC electricity 0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc

setup: 0x8f3c2a1b4d5e6f708192a3b4c5d6e7f8
evm chain: 31337
factory: 0xcf7ed3acca5a467e9e704c703e8d87f634fb0fc9
valid until: 1795473000
```

At most 4 tokens and 12 billers. Biller names are 1 to 40 printable ASCII characters (no line breaks), checked both when the text is rendered and when the account is created.

### Payment approval (`BillAgentAccount.approvalMessage`)

```text
QoreBills payment approval
biller: IBEDC electricity 0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc
amount: 60 tUSD
token: 0x9fe46736679d2d9a65f0992f2272de9f3c7fa6e0
ref: 0x2fdc33558a411263a2d67b647527a37a0b2567852b89aeb68da776f98ed5feaa
account: 0xdc64a140aa3e981100a9beca4e685f962f0cf6c9
evm chain: 31337
valid until: 1795473000
nonce: 3
```

`ref` is `keccak256` of the bill's reference text (`NOV-RENT` here). The bot shows the readable reference next to the link.

### Settings change (`BillAgentAccount.actionMessage`)

```text
QoreBills settings change
set limits for 0x9fe46736679d2d9a65f0992f2272de9f3c7fa6e0
auto-pay up to: 20 tUSD
max per payment: 100 tUSD
daily cap: 150 tUSD
account: 0xdc64a140aa3e981100a9beca4e685f962f0cf6c9
evm chain: 31337
valid until: 1795473000
nonce: 4
```

The second line depends on the action:

| Action | Line(s) |
|---|---|
| `SetBiller` | `allow biller: <name> <address>` |
| `RemoveBiller` | `remove biller: <current name> <address>` |
| `SetLimits` | `set limits for <token>`, then the three limit lines |
| `DisableToken` | `stop payments in <token>` |
| `SetAgent` | `agent: <address>` and `agent expires: <unix>`, or `revoke the agent` |
| `SetMaxPaymentsPerDay` | `payments per day: <n>` |
| `Pause` / `Unpause` | `pause all payments` / `resume payments` |
| `Withdraw` | `withdraw: <amount>` and `to: <address>` |

## Checking a signature yourself

Any QoreSign-compatible verifier can check these signatures off chain, for example `verifyMessageWithChain` from `@qorechain/qoresign`, with `chainId: "qorechain-diana"`, the owner's `qor1…` address and the exact text above as `data`. On chain, the same check is a single `pqcVerify` call, as in `OwnerSigned._verifyOwner`.
