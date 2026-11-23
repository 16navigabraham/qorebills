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

Day 1: planning. Contracts and agent code follow.

## Testnet addresses

To be added after deployment (QoreChain testnet, chain id `qorechain-diana`, EVM chain id `9800`).

## Credits

Built with QoreChain's open-source kits; each one used is credited here as it is added.

## Licence

MIT
