# QoreBills

An AI bill-paying agent on QoreChain whose spending and access limits are enforced **on chain**, not by the AI.

Built for [Build Before Q-Day](https://build.qorechain.io), Post-Quantum AI Agents track. #BuildBeforeQDay

## The idea

An AI agent that pays bills for you is only safe if it *can't* overspend, pay the wrong party, or keep acting after you've stopped trusting it. QoreBills puts those rules in a smart account on the QoreChain testnet:

- **Per-payment limit:** the most a single payment can be.
- **Daily cap:** the most the agent can spend in a day.
- **Allowed billers only:** the agent can pay registered billers (electricity, airtime, TV) and nothing else.
- **Expiry:** the agent's permission ends at a set time; after that every payment is rejected.
- **Owner approval above a threshold:** larger payments need an approval message signed by the owner with a post-quantum (ML-DSA-87) key.

You chat with the agent ("pay my electricity, 20 fUSD"), it decides what to do, and the chain decides whether it's allowed.

## Plan

| Day | Work |
|---|---|
| 1 | Repo, plan, contract design |
| 2–3 | `BillAgentAccount` contract (limits, allowlist, expiry) and tests; test biller contracts |
| 4–5 | Agent service: intent parsing, payments through the account, owner approvals |
| 6 | Telegram bot interface |
| 7 | Testnet deployment, addresses below |
| 8–9 | README, demo video, submission |

## Status

Built and tested: the contracts (35 tests, `contracts/`) and the agent (17 tests, `agent/`, including an end-to-end run on a local Hardhat node). Next: the agent key's QoreChain set-up and the testnet deploy.

### How it works

1. **Setup.** The owner opens the bot, taps "Set up in QoreX", chooses billers and limits, and signs the whole setup once with their ML-DSA-87 key. The agent submits it to `BillAgentFactory`, which checks the signature on chain and creates the owner's `BillAgentAccount`. The owner pays no gas and needs no EVM window.
2. **Paying.** "pay 15 fUSD to IBEDC electricity" goes through at once when it is within the auto-pay limit. Above it, the bot sends an approval link; the owner signs in QoreX and the contract verifies the signature before paying.
3. **Settings.** Pause, resume, add or remove billers, change limits, renew or revoke the agent, withdraw: each one is a message the owner signs in QoreX and the contract verifies.

| Limit | How the contract enforces it |
| --- | --- |
| Target | Only billers the owner allowlisted can be paid |
| Value | Per token: an auto-pay limit, a hard cap per payment and a cap per UTC day |
| Transactions | A maximum number of payments per UTC day |
| Duration | The agent key stops working at its expiry; the owner can pause or revoke it at any time |
| Approval | Above the auto-pay limit, the owner's ML-DSA-87 signature, checked with QoreChain's PQC Verify precompile (`0x…0A01`) against the key registered for the owner (PQC Key Status, `0x…0A02`, proof of possession required) |

Every signed message is plain text the wallet shows in full (QoreSign message signing v1: `qorechain-msg-v1|qorechain-diana|` + text), with amounts in the token's own units, a deadline and a nonce, so a signature can be used once, for exactly what it says. Each bill reference is paid once.

Checked on the testnet: an ML-DSA-87 signature in that format verifies with QoreChain's `pqcVerify` precompile, and a changed message does not.

### The agent (`agent/`)

A Node.js service with a Telegram bot, [@QoreBills_bot](https://t.me/QoreBills_bot), and the QoreX signing pages. It only answers its owner's Telegram account. With a Gemini key it also understands free-form requests; the model only proposes a command, which the agent checks against the allowlist and limits before the contract checks them again.

```bash
cd contracts && npm install && npm test
cd agent && npm install && npm test   # unit tests + an end-to-end run on a local Hardhat node
cp .env.example .env                  # fill in, then: npm start
```

## Testnet addresses

QoreChain testnet, chain id `qorechain-diana`, EVM chain id `9800`.

| Contract | EVM address | Native address |
| --- | --- | --- |
| `BillAgentFactory` | `0xF0385815a19009FBC01ba24773469c5e4e4e9b2D` | `qor17qu9s9dpjqylhsqm5frhx35ute8yaxedecfxqh` |
| `BillAgentDeployer` | `0x06C4E1194deb3c3BbE91022fc4507b6BF5023114` | `qor1qmzwzx2dav7rh053qghug5rmd06syvg5hhmme2` |

Deployed 23 November 2026 in transaction `0x05bd2652e47accc97f24ea6d13939ba1fc7d95a33fd1933a703fd0f44b2ab016` (5,919,188 gas). The deployer registered its ML-DSA-87 key with proof of possession and deployed inside a short EVM window, which it closed afterwards. Owners' accounts are created by the factory and listed in its `AccountCreated` events.

Note for other builders: the public testnet RPC caps `eth_call` and `eth_estimateGas` at about 5M gas, while a transaction may use up to 30M. The factory deploy (about 5.9M) and `createAccount` (about 5M) therefore set their gas limit instead of estimating it.

## Credits

Built with QoreChain's open-source kits; each one used is credited here as it is added.

## Licence

MIT
