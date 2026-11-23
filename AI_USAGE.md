# AI usage

QoreBills uses AI in two places: to **build** it, and **inside** the product. This page describes both, including what was left to people.

## AI in the product

QoreBills is an AI agent, but the AI is deliberately **not trusted**:

- **Understanding requests.** Typed commands (`pay 15 fUSD to IBEDC`) go through a deterministic parser. When a Gemini API key is configured, free-form messages ("pay the light bill, 15 dollars") go to Gemini with a strict JSON schema ([`agent/src/llm.js`](agent/src/llm.js)). The prompt lists the user's allowed billers and tokens and tells the model never to invent an amount or a biller.
- **The model only proposes.** Its output becomes the same command object as typed input and goes through the same checks: the biller must be on the account's allowlist, the amount is parsed in the token's decimals (extra decimals are refused), and the limits are checked before anything is sent.
- **The chain decides.** The `BillAgentAccount` contract enforces the allowlist, the per-payment and daily caps, the daily payment count and the agent's expiry, whatever the agent asks. Anything above the auto-pay limit needs the owner's ML-DSA-87 signature over text the owner reads in QoreX.

So a prompt injection or a wrong reading can at worst produce a refused request, or a request the owner sees and declines.

## AI in building QoreBills

QoreBills was built by Adebanjo Abraham with **Claude Code** (Anthropic's coding agent), working in a cloud session under the author's direction. The author works on a phone with limited mobile data, so the AI did most of the hands-on engineering in the cloud while the author steered, decided and tested on device.

### What the AI did

- **Research:** read QoreChain's documentation (EVM precompiles, EVM authorisation windows, SDK accounts and PQC, authenticators, QoreSign message signing, QoreX FAQ) and mapped the track's requirements to concrete chain features.
- **Design proposals:** the smart account with on-chain limits, owner approvals as ML-DSA-87 signed messages verified with the PQC precompiles, owner-signed settings and setup (so owners need no gas or EVM window), one agent key per user with a scoped EVM window, and the hosted-agent security model.
- **Code:** the Solidity contracts, the Node.js agent, the QoreX signing pages, the deploy scripts, Docker, and the CI/CD workflows.
- **Tests:** 35 contract tests and 27 agent tests, including end-to-end runs with one and two users. These caught a real bug before release: an amount with more decimals than the token has was being rounded and paid instead of refused.
- **Testnet work:** checked on the live testnet that ML-DSA-87 signatures in the `qorechain-msg-v1` format verify with `pqcVerify`; registered the deployer's key with a proof of possession, opened a deploy window and deployed the factory; diagnosed and documented the public RPC's ~5M gas cap on `eth_call` and `eth_estimateGas`, which first blocked the deploy.
- **Documentation:** this repository's README and `docs/`.

### What people did

- **The author** chose the hackathon and the track, picked QoreBills from the ideas discussed, and made the product decisions:
  - make the bot multi-user so judges and anyone else can try it, instead of single-owner;
  - host the agent with on-chain limits rather than ask every user to run their own;
  - keep secrets in GitHub secrets and on the server.
- **The author** registered the QoreX account and post-quantum key, funded the deployer from the faucet, created the Telegram bot, set the repository secrets, merged the infrastructure change for HTTPS, and handles the server access, the tests on a real phone with QoreX, and the demo video.
- **Secrets never passed through the AI:** the bot token, deploy key and wallet recovery phrase were entered by the author directly into GitHub, the server or QoreX. The agent's own master key is created on the server and never leaves it.

### How the work was checked

- Code changes ran the full test suites before they were pushed, and CI runs them again on GitHub.
- On-chain facts in the README (addresses, gas, transaction hashes, address conversions) were read back from the testnet rather than written from memory. One wrong pair of `qor1` addresses was caught by converting them back to their EVM form and was fixed before it was relied on.
- The UI pages were rendered at phone width in a headless browser and checked by eye.

## Tools

| Tool | Role |
|---|---|
| Claude Code (Anthropic) | Coding agent used to research, design, write, test and deploy |
| Gemini API (optional, at runtime) | Turning free-form chat messages into a structured command |
| QoreChain docs (`docs.qorechain.io`, `llms.txt`) | Primary source for every chain-specific detail |
