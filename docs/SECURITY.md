# Security model

QoreBills is built on one assumption: **the AI agent and the server it runs on are not trusted.** Safety comes from the smart account's rules and from the owner's post-quantum signature, both checked on QoreChain.

## Assets and actors

| Asset | Where it lives |
|---|---|
| The user's bill money (QOR, fUSD) | The user's `BillAgentAccount` |
| The owner's ML-DSA-87 key | The user's QoreX wallet; QoreBills never sees it |
| The agent's master key | `data/agent.mnemonic` on the server (file mode 600, Docker volume readable only by the app user) |
| Telegram bot token, optional Gemini key | Repository secrets, written to the server's `.env` at deploy time |

| Actor | Trusted for |
|---|---|
| Account owner (QoreX) | Everything about their own account |
| QoreChain (consensus, PQC precompiles, x/pqc) | Correct execution and signature verification |
| QoreBills server, agent code, Gemini | **Nothing beyond the on-chain limits** |

## What each key can do

| Key | Can | Cannot |
|---|---|---|
| Owner (ML-DSA-87, in QoreX) | Create the account; approve payments above the auto-pay limit; change billers, limits, agent, expiry; pause; withdraw | Pay past the per-payment and daily caps even with an approval (by design: the caps hold even if the owner is tricked into signing) |
| User *n*'s agent key (server) | `pay` up to the auto-pay limit, to allowlisted billers, within the daily cap and count, before expiry; submit owner-signed messages | Withdraw, change any setting, pay anyone else, or call any contract other than its user's account (scoped EVM window) |
| Main key (server) | Submit owner-signed setups to the factory; send gas to user keys | Touch any user's account (it is not their agent; its EVM window allows only the factory) |
| Anyone | Submit an owner-signed message (approvals and settings can be relayed by anyone) | Forge or alter one |

## Threats and mitigations

| Threat | Mitigation |
|---|---|
| **Server compromise** (attacker gets the master key) | Each user's exposure is bounded by their own limits: allowlisted billers only, auto-pay limit per bill, daily cap, payments per day, until expiry. No withdrawal, no new billers, no higher limits without the owner's ML-DSA-87 signature. The owner can `pause` or `revoke` with one signature, or straight from QoreX with a transaction (`execute`). |
| **Prompt injection or a wrong LLM reading** | The LLM only proposes a command; amounts and billers are checked against the account and enforced by the contract. Anything above the auto-pay limit shows the owner the exact text before it can happen. |
| **Paying a bill twice** | Each bill reference can be paid once (`refPaid`). |
| **Replaying a signature** | Per-account nonce, deadline, account and chain binding, and the `qorechain-msg-v1` wallet domain ([signed messages](SIGNED_MESSAGES.md)). |
| **Altering a signed request in transit** | The contract re-renders the signed text from the submitted arguments, so a change makes the signature invalid. |
| **Fake key registration** | The contract requires `possessionProven` from PQC Key Status: a key registered without a proof of possession is refused (`OwnerPqcKeyMissing`). |
| **Quantum attacker forging approvals** | Approvals are ML-DSA-87 (FIPS 204, security category 5), verified on chain. The agent keys' own QoreChain transactions are hybrid-signed (secp256k1 + ML-DSA-87). |
| **PQC precompile inactive** | An inactive precompile address returns success with empty data; the typed interface call then reverts, so approvals and signed settings fail closed. |
| **Look-alike lines in signed text** | Biller names are restricted to printable ASCII without control characters, checked on chain. |
| **Amount rounding** | The agent refuses amounts with more decimals than the token has, instead of rounding them. |
| **A request link leaking** | Links carry a random 128-bit id, but they are not authority: the action still needs the owner's signature over text naming the owner's own account. The page also warns when QoreX is open on a different account. |
| **Spam on the hosted demo** | One account per Telegram user (at most 3 setups), a cap on total accounts (50 by default), at most 12 messages per user per minute, signature-request bodies capped at 64 KB. |
| **Reentrancy through a biller** | `nonReentrant` on every state-changing entry point; state is updated before the transfer. |
| **Draining gas through user keys** | User keys get 1 QOR at a time and only below 0.3 QOR; each window caps the value it lets out (20 QOR, fees included). |

## Known limitations

- The hosted agent holds the agent keys. Their power is bounded on chain, but a compromised server could still make bounded payments to allowlisted billers until the owner pauses.
- The owner's QoreX wallet is the root of trust. If it is compromised, so is the account (as with any wallet).
- `maxPerPayment` and `dailyCap` are per token; an owner who enables several tokens accepts a cap in each.
- The contracts have not been audited. They are testnet software built for a hackathon.

## Reporting

Please open an issue on the repository, or contact the author privately for anything sensitive.
