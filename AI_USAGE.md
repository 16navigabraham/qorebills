# AI usage

QoreBills uses AI in two places: to **build** it, and **inside** the product. This page describes both, including what was left to people.

## AI in the product

QoreBills is an AI agent, but the AI is deliberately **not trusted**:

- **Understanding requests.** Typed commands (`pay 15 fUSD to IBEDC`) go through a deterministic parser. When a Gemini API key is configured, free-form messages ("pay the light bill, 15 dollars") go to Gemini with a strict JSON schema ([`agent/src/llm.js`](agent/src/llm.js)). The prompt lists the user's allowed billers and tokens and tells the model never to invent an amount or a biller.
- **The model only proposes.** Its output becomes the same command object as typed input and goes through the same checks: the biller must be on the account's allowlist, the amount is parsed in the token's decimals (extra decimals are refused), and the limits are checked before anything is sent.
- **The chain decides.** The `BillAgentAccount` contract enforces the allowlist, the per-payment and daily caps, the daily payment count and the agent's expiry, whatever the agent asks. Anything above the auto-pay limit needs the owner's ML-DSA-87 signature over text the owner reads on the signing page before approving in QoreX.

So a prompt injection or a wrong reading can at worst produce a refused request, or a request the owner sees and declines.

## AI in building QoreBills

QoreBills was built **AI-native**: Adebanjo Abraham led the project as product owner and architect, and worked with **Claude Code** (Anthropic's coding agent) as the engineering pair, in a cloud development environment connected to this repository and the QoreChain testnet.

### The workflow

1. **Decide:** the author set the goal (win the Post-Quantum AI Agents track with something people would really use), chose the idea, and made the product and architecture calls at each step.
2. **Research:** the AI read QoreChain's documentation (EVM precompiles, EVM authorisation windows, SDK accounts and PQC, authenticators, QoreSign message signing, the QoreX FAQ) and mapped the track's requirements to concrete chain features.
3. **Propose and build:** the AI proposed designs and implemented the ones the author approved, in small commits, with tests written alongside the code.
4. **Verify:** every change was checked by tests, and every chain-specific claim against the live testnet (see below).
5. **Review and steer:** the author reviewed the results, tested on device, and redirected when something didn't fit the product.

### Who did what

| Area | Author | AI pair |
|---|---|---|
| Idea and product | Chose QoreBills and the track; decided it must be multi-user so anyone (and the judges) can try it; decided on a hosted agent bounded by on-chain limits rather than asking users to run their own | Proposed options and their trade-offs |
| Architecture | Approved the design: smart account with on-chain limits, ML-DSA-87 approvals checked by the PQC precompiles, owner-signed setup and settings, one agent key per user with a scoped EVM window | Drafted the designs and the security model |
| Code and tests | Reviewed and directed | Wrote the Solidity contracts, the Node.js agent, the QoreX signing pages, the deploy scripts, Docker and CI/CD; 35 contract tests and 34 agent tests |
| Testnet | Registered the QoreX account and post-quantum key, funded the deployer from the faucet | Verified `pqcVerify` with ML-DSA-87 signatures on the testnet, deployed the factory, diagnosed the public RPC's ~5M gas cap on `eth_call` and `eth_estimateGas` |
| Operations | Created the Telegram bot, set the repository secrets, set up server access, merged the HTTPS change, ran the deploy | Wrote the deploy pipeline and server scripts |
| Communication | Recorded the demo on a real phone, and the submission | Edited the recordings into the demo video (cuts, captions, layout), the README, `docs/` and this file |

**Secrets never passed through the AI:** the bot token, the deploy key and the wallet recovery phrase were entered by the author directly into GitHub, the server or QoreX. The agent's own master key is created on the server and never leaves it.

### How the work was checked

- Code changes ran the full test suites before they were pushed, and CI runs them again on GitHub. The tests caught a real bug before release: an amount with more decimals than the token has was being rounded and paid instead of refused.
- On-chain facts in the README (addresses, gas, transaction hashes, address conversions) were read back from the testnet rather than written from memory. One wrong pair of `qor1` addresses was caught by converting them back to their EVM form and was fixed before it was relied on.
- The UI pages were rendered at phone width in a headless browser and checked by eye.

## Tools

| Tool | Role |
|---|---|
| Claude Code (Anthropic) | AI engineering pair: research, design drafts, code, tests, deployment |
| Gemini API (optional, at runtime) | Turning free-form chat messages into a structured command |
| Piper text-to-speech (open source, "Lessac" voice) | The demo video's narration is AI-generated from a script written for it; the screen recordings are real |
| FFmpeg | Assembling the demo video from the author's screen recordings |
| QoreChain docs (`docs.qorechain.io`, `llms.txt`) | Primary source for every chain-specific detail |
