const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { PQC_VERIFY, CHAIN, NATIVE, usd, ref, Kind, action, installPqcMock, signAs } = require("./helpers");

async function deploy() {
  const [owner, agent, power, water, stranger] = await ethers.getSigners();
  const { keyStatus, keys } = await installPqcMock([owner]);
  const ownerPubkey = keys.get(owner.address);

  const token = await (await ethers.getContractFactory("MockERC20")).deploy();
  const tokenAddress = await token.getAddress();
  const expiry = (await time.latest()) + 7 * 24 * 3600;
  const config = {
    agent: agent.address,
    agentExpiry: expiry,
    maxPaymentsPerDay: 5,
    // Auto-pay up to 20, never more than 100 in one payment, 150 a day.
    tokens: [
      { token: tokenAddress, autoPayLimit: usd(20), maxPerPayment: usd(100), dailyCap: usd(150) },
      { token: NATIVE, autoPayLimit: ethers.parseEther("1"), maxPerPayment: ethers.parseEther("2"), dailyCap: ethers.parseEther("3") },
    ],
    billers: [
      { biller: power.address, name: "IBEDC electricity" },
      { biller: water.address, name: "Water board" },
    ],
  };
  const account = await (await ethers.getContractFactory("BillAgentAccount")).deploy(owner.address, CHAIN, config);
  const accountAddress = await account.getAddress();
  await token.mint(accountAddress, usd(1000));
  await owner.sendTransaction({ to: accountAddress, value: ethers.parseEther("10") });

  async function approve(billerAddr, tokenAddr, amount, r, deadline) {
    const text = await account.approvalMessage(billerAddr, tokenAddr, amount, r, deadline, await account.nonce());
    return { text, sig: signAs(ownerPubkey, text) };
  }
  async function signAction(act, deadline) {
    const text = await account.actionMessage(act, deadline, await account.nonce());
    return { text, sig: signAs(ownerPubkey, text) };
  }

  return { owner, agent, power, water, stranger, token, tokenAddress, account, keyStatus, ownerPubkey, expiry, approve, signAction };
}

describe("BillAgentAccount", function () {
  describe("setup", function () {
    it("starts with the configured agent, limits and billers", async function () {
      const { account, owner, agent, power, tokenAddress, expiry } = await loadFixture(deploy);
      expect(await account.owner()).to.equal(owner.address);
      expect(await account.agent()).to.equal(agent.address);
      expect(await account.agentExpiry()).to.equal(expiry);
      expect(await account.maxPaymentsPerDay()).to.equal(5);
      expect(await account.limits(tokenAddress)).to.deep.equal([usd(20), usd(100), usd(150), true]);
      expect(await account.billerInfo(power.address)).to.deep.equal([true, "IBEDC electricity"]);
      expect(await account.agentActive()).to.equal(true);
    });

    it("refuses inconsistent limits and bad biller names", async function () {
      const [owner, agent, biller] = await ethers.getSigners();
      const Account = await ethers.getContractFactory("BillAgentAccount");
      const base = { agent: agent.address, agentExpiry: 1n << 40n, maxPaymentsPerDay: 1, tokens: [], billers: [] };
      const badLimits = { ...base, tokens: [{ token: NATIVE, autoPayLimit: 5, maxPerPayment: 4, dailyCap: 10 }] };
      await expect(Account.deploy(owner.address, CHAIN, badLimits)).to.be.revertedWithCustomError(Account, "InvalidLimits");
      for (const name of ["", "a\nb", "x".repeat(41)]) {
        const cfg = { ...base, billers: [{ biller: biller.address, name }] };
        await expect(Account.deploy(owner.address, CHAIN, cfg)).to.be.revertedWithCustomError(Account, "InvalidName");
      }
    });
  });

  describe("auto-pay", function () {
    it("pays an allowlisted biller within the limits", async function () {
      const { account, agent, power, token, tokenAddress } = await loadFixture(deploy);
      await expect(account.connect(agent).pay(power.address, tokenAddress, usd(15), ref("bill-1")))
        .to.emit(account, "BillPaid")
        .withArgs(power.address, tokenAddress, usd(15), ref("bill-1"), false);
      expect(await token.balanceOf(power.address)).to.equal(usd(15));
      expect(await account.remainingToday(tokenAddress)).to.equal(usd(135));
    });

    it("pays in native QOR", async function () {
      const { account, agent, water } = await loadFixture(deploy);
      const amount = ethers.parseEther("0.5");
      await expect(account.connect(agent).pay(water.address, NATIVE, amount, ref("water-nov"))).to.changeEtherBalances(
        [account, water],
        [-amount, amount]
      );
    });

    it("refuses anyone but the agent", async function () {
      const { account, owner, stranger, power, tokenAddress } = await loadFixture(deploy);
      for (const who of [stranger, owner]) {
        await expect(account.connect(who).pay(power.address, tokenAddress, usd(1), ref("x"))).to.be.revertedWithCustomError(account, "NotAgent");
      }
    });

    it("refuses a biller that is not on the allowlist (target limit)", async function () {
      const { account, agent, stranger, tokenAddress } = await loadFixture(deploy);
      await expect(account.connect(agent).pay(stranger.address, tokenAddress, usd(1), ref("x")))
        .to.be.revertedWithCustomError(account, "BillerNotAllowed")
        .withArgs(stranger.address);
    });

    it("refuses a token the owner has not enabled", async function () {
      const { account, agent, power } = await loadFixture(deploy);
      const other = await (await ethers.getContractFactory("MockERC20")).deploy();
      await expect(account.connect(agent).pay(power.address, await other.getAddress(), usd(1), ref("x"))).to.be.revertedWithCustomError(account, "TokenNotEnabled");
    });

    it("refuses a zero payment", async function () {
      const { account, agent, power, tokenAddress } = await loadFixture(deploy);
      await expect(account.connect(agent).pay(power.address, tokenAddress, 0, ref("x"))).to.be.revertedWithCustomError(account, "ZeroAmount");
    });

    it("needs the owner's approval above the auto-pay limit", async function () {
      const { account, agent, power, tokenAddress } = await loadFixture(deploy);
      await expect(account.connect(agent).pay(power.address, tokenAddress, usd(21), ref("x")))
        .to.be.revertedWithCustomError(account, "NeedsOwnerApproval")
        .withArgs(usd(21), usd(20));
    });

    it("pays each bill reference only once", async function () {
      const { account, agent, power, water, tokenAddress } = await loadFixture(deploy);
      await account.connect(agent).pay(power.address, tokenAddress, usd(5), ref("bill-1"));
      await expect(account.connect(agent).pay(water.address, tokenAddress, usd(5), ref("bill-1")))
        .to.be.revertedWithCustomError(account, "RefAlreadyPaid")
        .withArgs(ref("bill-1"));
    });

    it("enforces the daily cap and resets it the next UTC day (value limit)", async function () {
      const { account, owner, agent, power, tokenAddress } = await loadFixture(deploy);
      await account.connect(owner).execute(action(Kind.SetLimits, { token: tokenAddress, a: usd(60), b: usd(100), c: usd(150) }));
      await account.connect(agent).pay(power.address, tokenAddress, usd(60), ref("a"));
      await account.connect(agent).pay(power.address, tokenAddress, usd(60), ref("b"));
      await expect(account.connect(agent).pay(power.address, tokenAddress, usd(40), ref("c")))
        .to.be.revertedWithCustomError(account, "DailyCapExceeded")
        .withArgs(usd(160), usd(150));
      await account.connect(agent).pay(power.address, tokenAddress, usd(30), ref("c"));
      expect(await account.remainingToday(tokenAddress)).to.equal(0);

      await time.increase(24 * 3600);
      await account.connect(agent).pay(power.address, tokenAddress, usd(60), ref("d"));
      expect(await account.remainingToday(tokenAddress)).to.equal(usd(90));
    });

    it("enforces the number of payments per day (transaction limit)", async function () {
      const { account, agent, power, tokenAddress } = await loadFixture(deploy);
      for (let i = 0; i < 5; i++) await account.connect(agent).pay(power.address, tokenAddress, usd(1), ref(`p${i}`));
      await expect(account.connect(agent).pay(power.address, tokenAddress, usd(1), ref("p5")))
        .to.be.revertedWithCustomError(account, "DailyPaymentCountExceeded")
        .withArgs(5);
    });

    it("stops working when the agent key expires (duration limit)", async function () {
      const { account, agent, power, tokenAddress, expiry } = await loadFixture(deploy);
      await time.increaseTo(expiry);
      expect(await account.agentActive()).to.equal(false);
      await expect(account.connect(agent).pay(power.address, tokenAddress, usd(1), ref("x"))).to.be.revertedWithCustomError(account, "AgentExpired");
    });
  });

  describe("owner approval of a payment (ML-DSA-87)", function () {
    it("pays above the auto-pay limit with the owner's post-quantum signature", async function () {
      const { account, agent, power, token, tokenAddress, approve } = await loadFixture(deploy);
      const deadline = (await time.latest()) + 3600;
      const { text, sig } = await approve(power.address, tokenAddress, usd(80.5), ref("rent"), deadline);
      const shown = ethers.toUtf8String(text);
      expect(shown).to.match(/^QoreBills payment approval\nbiller: IBEDC electricity 0x/);
      expect(shown).to.contain("\namount: 80.5 tUSD\n");
      expect(shown).to.contain(`\naccount: ${(await account.getAddress()).toLowerCase()}\nevm chain: 31337\nvalid until: ${deadline}\nnonce: 0`);

      await expect(account.connect(agent).payWithApproval(power.address, tokenAddress, usd(80.5), ref("rent"), deadline, sig))
        .to.emit(account, "BillPaid")
        .withArgs(power.address, tokenAddress, usd(80.5), ref("rent"), true);
      expect(await token.balanceOf(power.address)).to.equal(usd(80.5));
      expect(await account.nonce()).to.equal(1);
    });

    it("formats native QOR amounts", async function () {
      const { account, water } = await loadFixture(deploy);
      const text = ethers.toUtf8String(await account.approvalMessage(water.address, NATIVE, ethers.parseEther("1.25"), ref("x"), 1, 0));
      expect(text).to.contain("\namount: 1.25 QOR\n");
      const tiny = ethers.toUtf8String(await account.approvalMessage(water.address, NATIVE, 5n, ref("x"), 1, 0));
      expect(tiny).to.contain("\namount: 0.000000000000000005 QOR\n");
    });

    it("refuses a signature for different payment details", async function () {
      const { account, agent, power, water, tokenAddress, approve } = await loadFixture(deploy);
      const deadline = (await time.latest()) + 3600;
      const { sig } = await approve(power.address, tokenAddress, usd(80), ref("rent"), deadline);
      for (const args of [
        [water.address, tokenAddress, usd(80), ref("rent"), deadline],
        [power.address, tokenAddress, usd(90), ref("rent"), deadline],
        [power.address, tokenAddress, usd(80), ref("other"), deadline],
        [power.address, tokenAddress, usd(80), ref("rent"), deadline + 1],
      ]) {
        await expect(account.connect(agent).payWithApproval(...args, sig)).to.be.revertedWithCustomError(account, "InvalidOwnerSignature");
      }
    });

    it("cannot replay an approval", async function () {
      const { account, agent, power, tokenAddress, approve } = await loadFixture(deploy);
      const deadline = (await time.latest()) + 3600;
      const { sig } = await approve(power.address, tokenAddress, usd(30), ref("r1"), deadline);
      await account.connect(agent).payWithApproval(power.address, tokenAddress, usd(30), ref("r1"), deadline, sig);
      await expect(account.connect(agent).payWithApproval(power.address, tokenAddress, usd(30), ref("r1"), deadline, sig)).to.be.revertedWithCustomError(account, "RefAlreadyPaid");
      await expect(account.connect(agent).payWithApproval(power.address, tokenAddress, usd(30), ref("r2"), deadline, sig)).to.be.revertedWithCustomError(account, "InvalidOwnerSignature");
    });

    it("refuses an expired approval", async function () {
      const { account, agent, power, tokenAddress, approve } = await loadFixture(deploy);
      const deadline = (await time.latest()) + 60;
      const { sig } = await approve(power.address, tokenAddress, usd(30), ref("r1"), deadline);
      await time.increase(120);
      await expect(account.connect(agent).payWithApproval(power.address, tokenAddress, usd(30), ref("r1"), deadline, sig)).to.be.revertedWithCustomError(account, "SignatureExpired");
    });

    it("refuses when the owner's key has no proof of possession", async function () {
      const { account, owner, agent, power, tokenAddress, keyStatus, ownerPubkey, approve } = await loadFixture(deploy);
      await keyStatus.setKey(owner.address, true, 1, ownerPubkey, false);
      const deadline = (await time.latest()) + 3600;
      const { sig } = await approve(power.address, tokenAddress, usd(30), ref("r1"), deadline);
      await expect(account.connect(agent).payWithApproval(power.address, tokenAddress, usd(30), ref("r1"), deadline, sig)).to.be.revertedWithCustomError(account, "OwnerPqcKeyMissing");
    });

    it("refuses a signature made with another key", async function () {
      const { account, agent, power, tokenAddress } = await loadFixture(deploy);
      const deadline = (await time.latest()) + 3600;
      const text = await account.approvalMessage(power.address, tokenAddress, usd(30), ref("r1"), deadline, 0);
      const sig = signAs(ethers.hexlify(ethers.randomBytes(2592)), text);
      await expect(account.connect(agent).payWithApproval(power.address, tokenAddress, usd(30), ref("r1"), deadline, sig)).to.be.revertedWithCustomError(account, "InvalidOwnerSignature");
    });

    it("still keeps approved payments under the hard caps", async function () {
      const { account, agent, power, tokenAddress, approve } = await loadFixture(deploy);
      const deadline = (await time.latest()) + 3600;
      let { sig } = await approve(power.address, tokenAddress, usd(101), ref("big"), deadline);
      await expect(account.connect(agent).payWithApproval(power.address, tokenAddress, usd(101), ref("big"), deadline, sig)).to.be.revertedWithCustomError(account, "AboveMaxPerPayment");
      ({ sig } = await approve(power.address, tokenAddress, usd(100), ref("a"), deadline));
      await account.connect(agent).payWithApproval(power.address, tokenAddress, usd(100), ref("a"), deadline, sig);
      ({ sig } = await approve(power.address, tokenAddress, usd(60), ref("b"), deadline));
      await expect(account.connect(agent).payWithApproval(power.address, tokenAddress, usd(60), ref("b"), deadline, sig)).to.be.revertedWithCustomError(account, "DailyCapExceeded");
    });

    it("fails closed when the PQC precompile is not active", async function () {
      const { account, agent, power, tokenAddress, approve } = await loadFixture(deploy);
      const deadline = (await time.latest()) + 3600;
      const { sig } = await approve(power.address, tokenAddress, usd(30), ref("r1"), deadline);
      // An inactive precompile address answers with empty data; the typed call must revert.
      await network.provider.send("hardhat_setCode", [PQC_VERIFY, "0x"]);
      await expect(account.connect(agent).payWithApproval(power.address, tokenAddress, usd(30), ref("r1"), deadline, sig)).to.be.reverted;
    });
  });

  describe("owner settings by signed message", function () {
    it("lets anyone submit a settings change the owner signed", async function () {
      const { account, agent, stranger, signAction } = await loadFixture(deploy);
      const deadline = (await time.latest()) + 600;
      const act = action(Kind.Pause);
      const { text, sig } = await signAction(act, deadline);
      expect(ethers.toUtf8String(text)).to.match(/^QoreBills settings change\npause all payments\naccount: 0x/);
      await expect(account.connect(stranger).executeSigned(act, deadline, sig))
        .to.emit(account, "OwnerSignedAction")
        .withArgs(Kind.Pause, 0);
      expect(await account.paused()).to.equal(true);
      expect(await account.agentActive()).to.equal(false);
      await expect(account.connect(agent).executeSigned(act, deadline, sig)).to.be.revertedWithCustomError(account, "InvalidOwnerSignature");
    });

    it("applies each kind of change and shows it in plain text", async function () {
      const { account, agent, stranger, power, token, tokenAddress, signAction } = await loadFixture(deploy);
      const deadline = (await time.latest()) + 600;
      const run = async (act, expected) => {
        const { text, sig } = await signAction(act, deadline);
        expect(ethers.toUtf8String(text)).to.contain(expected);
        await account.connect(agent).executeSigned(act, deadline, sig);
      };
      await run(action(Kind.SetBiller, { target: stranger.address, name: "Campus hostel" }), `allow biller: Campus hostel ${stranger.address.toLowerCase()}`);
      expect(await account.billerInfo(stranger.address)).to.deep.equal([true, "Campus hostel"]);
      await run(action(Kind.RemoveBiller, { target: power.address }), "remove biller: IBEDC electricity");
      expect(await account.billerInfo(power.address)).to.deep.equal([false, "IBEDC electricity"]);
      await run(action(Kind.SetLimits, { token: tokenAddress, a: usd(5), b: usd(50), c: usd(70) }), "\nauto-pay up to: 5 tUSD\nmax per payment: 50 tUSD\ndaily cap: 70 tUSD");
      expect(await account.limits(tokenAddress)).to.deep.equal([usd(5), usd(50), usd(70), true]);
      await run(action(Kind.SetMaxPaymentsPerDay, { a: 2n }), "payments per day: 2");
      expect(await account.maxPaymentsPerDay()).to.equal(2);
      await run(action(Kind.SetAgent, { target: stranger.address, a: 2n ** 40n }), `agent: ${stranger.address.toLowerCase()}\nagent expires: ${2n ** 40n}`);
      expect(await account.agent()).to.equal(stranger.address);
      await run(action(Kind.Withdraw, { token: tokenAddress, a: usd(12.5), target: stranger.address }), `withdraw: 12.5 tUSD\nto: ${stranger.address.toLowerCase()}`);
      expect(await token.balanceOf(stranger.address)).to.equal(usd(12.5));
      await run(action(Kind.DisableToken, { token: tokenAddress }), "stop payments in");
      expect((await account.limits(tokenAddress))[3]).to.equal(false);
      await run(action(Kind.SetAgent, {}), "revoke the agent");
      expect(await account.agent()).to.equal(ethers.ZeroAddress);
      expect(await account.agentExpiry()).to.equal(0);
      expect(await account.nonce()).to.equal(8);
    });

    it("cannot be replayed, expire, or be signed by someone else", async function () {
      const { account, agent, stranger, signAction } = await loadFixture(deploy);
      const deadline = (await time.latest()) + 600;
      const act = action(Kind.Withdraw, { token: NATIVE, a: ethers.parseEther("1"), target: stranger.address });
      const { sig } = await signAction(act, deadline);
      await account.connect(agent).executeSigned(act, deadline, sig);
      await expect(account.connect(agent).executeSigned(act, deadline, sig)).to.be.revertedWithCustomError(account, "InvalidOwnerSignature");

      const late = await signAction(action(Kind.Unpause), (await time.latest()) + 10);
      await time.increase(60);
      await expect(account.executeSigned(action(Kind.Unpause), (await time.latest()) - 50, late.sig)).to.be.revertedWithCustomError(account, "SignatureExpired");

      const forged = signAs(ethers.hexlify(ethers.randomBytes(2592)), await account.actionMessage(act, deadline, await account.nonce()));
      await expect(account.connect(agent).executeSigned(act, deadline, forged)).to.be.revertedWithCustomError(account, "InvalidOwnerSignature");
    });

    it("a signed change cannot be altered on the way", async function () {
      const { account, agent, stranger, power, signAction } = await loadFixture(deploy);
      const deadline = (await time.latest()) + 600;
      const { sig } = await signAction(action(Kind.SetBiller, { target: power.address, name: "IBEDC" }), deadline);
      await expect(account.connect(agent).executeSigned(action(Kind.SetBiller, { target: stranger.address, name: "IBEDC" }), deadline, sig)).to.be.revertedWithCustomError(account, "InvalidOwnerSignature");
    });
  });

  describe("owner settings by transaction", function () {
    it("only the owner can execute directly", async function () {
      const { account, agent, stranger } = await loadFixture(deploy);
      for (const who of [agent, stranger]) {
        await expect(account.connect(who).execute(action(Kind.Pause))).to.be.revertedWithCustomError(account, "NotOwner");
      }
    });

    it("pauses, revokes and withdraws", async function () {
      const { account, owner, agent, power, token, tokenAddress } = await loadFixture(deploy);
      await account.execute(action(Kind.Pause));
      await expect(account.connect(agent).pay(power.address, tokenAddress, usd(1), ref("x"))).to.be.revertedWithCustomError(account, "AccountPaused");
      await account.execute(action(Kind.Unpause));
      await account.execute(action(Kind.SetAgent, {}));
      await expect(account.connect(agent).pay(power.address, tokenAddress, usd(1), ref("x"))).to.be.revertedWithCustomError(account, "NotAgent");
      await account.execute(action(Kind.Withdraw, { token: tokenAddress, a: usd(1000), target: owner.address }));
      expect(await token.balanceOf(owner.address)).to.equal(usd(1000));
      await expect(account.execute(action(Kind.Withdraw, { token: NATIVE, a: ethers.parseEther("10"), target: owner.address }))).to.changeEtherBalance(owner, ethers.parseEther("10"));
    });

    it("refuses limits that contradict each other", async function () {
      const { account, tokenAddress } = await loadFixture(deploy);
      await expect(account.execute(action(Kind.SetLimits, { token: tokenAddress, a: 50n, b: 40n, c: 100n }))).to.be.revertedWithCustomError(account, "InvalidLimits");
      await expect(account.execute(action(Kind.SetLimits, { token: tokenAddress, a: 10n, b: 40n, c: 30n }))).to.be.revertedWithCustomError(account, "InvalidLimits");
    });

    it("lists every biller once, with its current status", async function () {
      const { account, power, water } = await loadFixture(deploy);
      await account.execute(action(Kind.RemoveBiller, { target: power.address }));
      expect(await account.billerList()).to.deep.equal([power.address, water.address]);
      expect(await account.billerInfo(power.address)).to.deep.equal([false, "IBEDC electricity"]);
      expect(await account.billerInfo(water.address)).to.deep.equal([true, "Water board"]);
    });
  });
});
