const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

const PQC_VERIFY = "0x0000000000000000000000000000000000000a01";
const PQC_KEY_STATUS = "0x0000000000000000000000000000000000000a02";
const CHAIN = "qorechain-diana";
const NATIVE = ethers.ZeroAddress;
const usd = (n) => ethers.parseUnits(String(n), 6);
const ref = (s) => ethers.id(s);

// The mock precompile accepts a "signature" equal to keccak256(pubkey ‖ message).
const fakeSign = (pubkey, message) => ethers.keccak256(ethers.concat([pubkey, message]));

async function deploy() {
  const [owner, agent, power, water, stranger] = await ethers.getSigners();

  // Put the mock precompile's code at both PQC addresses, as the testnet node serves them.
  const mock = await (await ethers.getContractFactory("MockQorePQC")).deploy();
  const code = await ethers.provider.getCode(await mock.getAddress());
  await network.provider.send("hardhat_setCode", [PQC_VERIFY, code]);
  await network.provider.send("hardhat_setCode", [PQC_KEY_STATUS, code]);
  const keyStatus = await ethers.getContractAt("MockQorePQC", PQC_KEY_STATUS);
  const ownerPubkey = ethers.hexlify(ethers.randomBytes(2592));
  await keyStatus.setKey(owner.address, true, 1, ownerPubkey, true);

  const token = await (await ethers.getContractFactory("MockERC20")).deploy();
  const account = await (await ethers.getContractFactory("BillAgentAccount")).deploy(owner.address, CHAIN);
  const accountAddress = await account.getAddress();
  await token.mint(accountAddress, usd(1000));
  await owner.sendTransaction({ to: accountAddress, value: ethers.parseEther("10") });

  const tokenAddress = await token.getAddress();
  const expiry = (await time.latest()) + 7 * 24 * 3600;
  await account.setAgent(agent.address, expiry);
  await account.setBiller(power.address, true, "IBEDC electricity");
  await account.setBiller(water.address, true, "Water board");
  // Auto-pay up to 20, never more than 100 in one payment, 150 a day.
  await account.setLimits(tokenAddress, usd(20), usd(100), usd(150), true);
  await account.setLimits(NATIVE, ethers.parseEther("1"), ethers.parseEther("2"), ethers.parseEther("3"), true);
  await account.setMaxPaymentsPerDay(5);

  async function approve(billerAddr, tokenAddr, amount, r, deadline) {
    const nonce = await account.approvalNonce();
    const data = await account.approvalMessage(billerAddr, tokenAddr, amount, r, deadline, nonce);
    const signed = ethers.concat([ethers.toUtf8Bytes(`qorechain-msg-v1|${CHAIN}|`), data]);
    return { data, sig: fakeSign(ownerPubkey, signed) };
  }

  return { owner, agent, power, water, stranger, token, tokenAddress, account, keyStatus, ownerPubkey, expiry, approve };
}

describe("BillAgentAccount", function () {
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
        await expect(account.connect(who).pay(power.address, tokenAddress, usd(1), ref("x"))).to.be.revertedWithCustomError(
          account,
          "NotAgent"
        );
      }
    });

    it("refuses a biller that is not on the allowlist (target limit)", async function () {
      const { account, agent, stranger, tokenAddress } = await loadFixture(deploy);
      await expect(account.connect(agent).pay(stranger.address, tokenAddress, usd(1), ref("x")))
        .to.be.revertedWithCustomError(account, "BillerNotAllowed")
        .withArgs(stranger.address);
    });

    it("refuses a biller the owner removed", async function () {
      const { account, agent, power, tokenAddress } = await loadFixture(deploy);
      await account.setBiller(power.address, false, "");
      await expect(account.connect(agent).pay(power.address, tokenAddress, usd(1), ref("x"))).to.be.revertedWithCustomError(
        account,
        "BillerNotAllowed"
      );
    });

    it("refuses a token the owner has not enabled", async function () {
      const { account, agent, power } = await loadFixture(deploy);
      const other = await (await ethers.getContractFactory("MockERC20")).deploy();
      await expect(account.connect(agent).pay(power.address, await other.getAddress(), usd(1), ref("x")))
        .to.be.revertedWithCustomError(account, "TokenNotEnabled");
    });

    it("refuses a zero payment", async function () {
      const { account, agent, power, tokenAddress } = await loadFixture(deploy);
      await expect(account.connect(agent).pay(power.address, tokenAddress, 0, ref("x"))).to.be.revertedWithCustomError(
        account,
        "ZeroAmount"
      );
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
      await account.connect(owner).setLimits(tokenAddress, usd(60), usd(100), usd(150), true);
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
      await expect(account.connect(agent).pay(power.address, tokenAddress, usd(1), ref("x"))).to.be.revertedWithCustomError(
        account,
        "AgentExpired"
      );
    });

    it("stops working when the owner pauses or revokes the agent", async function () {
      const { account, owner, agent, power, tokenAddress } = await loadFixture(deploy);
      await account.connect(owner).setPaused(true);
      await expect(account.connect(agent).pay(power.address, tokenAddress, usd(1), ref("x"))).to.be.revertedWithCustomError(
        account,
        "AccountPaused"
      );
      await account.connect(owner).setPaused(false);
      await account.connect(owner).setAgent(ethers.ZeroAddress, 0);
      await expect(account.connect(agent).pay(power.address, tokenAddress, usd(1), ref("x"))).to.be.revertedWithCustomError(
        account,
        "NotAgent"
      );
    });
  });

  describe("owner approval (ML-DSA-87)", function () {
    it("pays above the auto-pay limit with the owner's post-quantum signature", async function () {
      const { account, agent, power, token, tokenAddress, approve } = await loadFixture(deploy);
      const deadline = (await time.latest()) + 3600;
      const { data, sig } = await approve(power.address, tokenAddress, usd(80), ref("rent"), deadline);
      expect(ethers.toUtf8String(data)).to.contain("biller: " + power.address.toLowerCase() + " (IBEDC electricity)");
      expect(ethers.toUtf8String(data)).to.contain("amount: 80000000");

      await expect(account.connect(agent).payWithApproval(power.address, tokenAddress, usd(80), ref("rent"), deadline, sig))
        .to.emit(account, "BillPaid")
        .withArgs(power.address, tokenAddress, usd(80), ref("rent"), true);
      expect(await token.balanceOf(power.address)).to.equal(usd(80));
      expect(await account.approvalNonce()).to.equal(1);
    });

    it("refuses a signature for different payment details", async function () {
      const { account, agent, power, water, tokenAddress, approve } = await loadFixture(deploy);
      const deadline = (await time.latest()) + 3600;
      const { sig } = await approve(power.address, tokenAddress, usd(80), ref("rent"), deadline);
      const tries = [
        [water.address, tokenAddress, usd(80), ref("rent"), deadline], // other biller
        [power.address, tokenAddress, usd(90), ref("rent"), deadline], // other amount
        [power.address, tokenAddress, usd(80), ref("other"), deadline], // other bill
        [power.address, tokenAddress, usd(80), ref("rent"), deadline + 1], // longer validity
      ];
      for (const args of tries) {
        await expect(account.connect(agent).payWithApproval(...args, sig)).to.be.revertedWithCustomError(
          account,
          "InvalidOwnerSignature"
        );
      }
    });

    it("cannot replay an approval", async function () {
      const { account, agent, power, tokenAddress, approve } = await loadFixture(deploy);
      const deadline = (await time.latest()) + 3600;
      const { sig } = await approve(power.address, tokenAddress, usd(30), ref("r1"), deadline);
      await account.connect(agent).payWithApproval(power.address, tokenAddress, usd(30), ref("r1"), deadline, sig);
      // Same ref is refused; a new ref with the old signature fails because the nonce moved on.
      await expect(
        account.connect(agent).payWithApproval(power.address, tokenAddress, usd(30), ref("r1"), deadline, sig)
      ).to.be.revertedWithCustomError(account, "RefAlreadyPaid");
      await expect(
        account.connect(agent).payWithApproval(power.address, tokenAddress, usd(30), ref("r2"), deadline, sig)
      ).to.be.revertedWithCustomError(account, "InvalidOwnerSignature");
    });

    it("refuses an expired approval", async function () {
      const { account, agent, power, tokenAddress, approve } = await loadFixture(deploy);
      const deadline = (await time.latest()) + 60;
      const { sig } = await approve(power.address, tokenAddress, usd(30), ref("r1"), deadline);
      await time.increase(120);
      await expect(
        account.connect(agent).payWithApproval(power.address, tokenAddress, usd(30), ref("r1"), deadline, sig)
      ).to.be.revertedWithCustomError(account, "ApprovalExpired");
    });

    it("refuses when the owner's key has no proof of possession", async function () {
      const { account, owner, agent, power, tokenAddress, keyStatus, ownerPubkey, approve } = await loadFixture(deploy);
      await keyStatus.setKey(owner.address, true, 1, ownerPubkey, false);
      const deadline = (await time.latest()) + 3600;
      const { sig } = await approve(power.address, tokenAddress, usd(30), ref("r1"), deadline);
      await expect(
        account.connect(agent).payWithApproval(power.address, tokenAddress, usd(30), ref("r1"), deadline, sig)
      ).to.be.revertedWithCustomError(account, "OwnerPqcKeyMissing");
    });

    it("refuses a signature made with another key", async function () {
      const { account, agent, power, tokenAddress } = await loadFixture(deploy);
      const deadline = (await time.latest()) + 3600;
      const nonce = await account.approvalNonce();
      const data = await account.approvalMessage(power.address, tokenAddress, usd(30), ref("r1"), deadline, nonce);
      const signed = ethers.concat([ethers.toUtf8Bytes(`qorechain-msg-v1|${CHAIN}|`), data]);
      const sig = fakeSign(ethers.hexlify(ethers.randomBytes(2592)), signed);
      await expect(
        account.connect(agent).payWithApproval(power.address, tokenAddress, usd(30), ref("r1"), deadline, sig)
      ).to.be.revertedWithCustomError(account, "InvalidOwnerSignature");
    });

    it("still keeps approved payments under the hard caps", async function () {
      const { account, agent, power, tokenAddress, approve } = await loadFixture(deploy);
      const deadline = (await time.latest()) + 3600;
      let { sig } = await approve(power.address, tokenAddress, usd(101), ref("big"), deadline);
      await expect(
        account.connect(agent).payWithApproval(power.address, tokenAddress, usd(101), ref("big"), deadline, sig)
      ).to.be.revertedWithCustomError(account, "AboveMaxPerPayment");

      ({ sig } = await approve(power.address, tokenAddress, usd(100), ref("a"), deadline));
      await account.connect(agent).payWithApproval(power.address, tokenAddress, usd(100), ref("a"), deadline, sig);
      ({ sig } = await approve(power.address, tokenAddress, usd(60), ref("b"), deadline));
      await expect(
        account.connect(agent).payWithApproval(power.address, tokenAddress, usd(60), ref("b"), deadline, sig)
      ).to.be.revertedWithCustomError(account, "DailyCapExceeded");
    });

    it("fails closed when the PQC precompile is not active", async function () {
      const { account, agent, power, tokenAddress, approve } = await loadFixture(deploy);
      const deadline = (await time.latest()) + 3600;
      const { sig } = await approve(power.address, tokenAddress, usd(30), ref("r1"), deadline);
      // An inactive precompile address answers with empty data; the typed call must revert.
      await network.provider.send("hardhat_setCode", [PQC_VERIFY, "0x"]);
      await expect(account.connect(agent).payWithApproval(power.address, tokenAddress, usd(30), ref("r1"), deadline, sig))
        .to.be.reverted;
    });
  });

  describe("owner controls", function () {
    it("only the owner changes settings", async function () {
      const { account, agent, stranger, tokenAddress } = await loadFixture(deploy);
      for (const who of [agent, stranger]) {
        const a = account.connect(who);
        await expect(a.setAgent(who.address, 1)).to.be.revertedWithCustomError(account, "NotOwner");
        await expect(a.setBiller(who.address, true, "me")).to.be.revertedWithCustomError(account, "NotOwner");
        await expect(a.setLimits(tokenAddress, 1, 1, 1, true)).to.be.revertedWithCustomError(account, "NotOwner");
        await expect(a.setMaxPaymentsPerDay(99)).to.be.revertedWithCustomError(account, "NotOwner");
        await expect(a.setPaused(true)).to.be.revertedWithCustomError(account, "NotOwner");
        await expect(a.withdraw(tokenAddress, who.address, 1)).to.be.revertedWithCustomError(account, "NotOwner");
      }
    });

    it("refuses limits that contradict each other", async function () {
      const { account, tokenAddress } = await loadFixture(deploy);
      await expect(account.setLimits(tokenAddress, 50, 40, 100, true)).to.be.revertedWithCustomError(account, "InvalidLimits");
      await expect(account.setLimits(tokenAddress, 10, 40, 30, true)).to.be.revertedWithCustomError(account, "InvalidLimits");
    });

    it("lets the owner withdraw at any time", async function () {
      const { account, owner, token, tokenAddress } = await loadFixture(deploy);
      await account.setPaused(true);
      await account.withdraw(tokenAddress, owner.address, usd(1000));
      expect(await token.balanceOf(owner.address)).to.equal(usd(1000));
      await expect(account.withdraw(NATIVE, owner.address, ethers.parseEther("10"))).to.changeEtherBalance(
        owner,
        ethers.parseEther("10")
      );
    });
  });
});
