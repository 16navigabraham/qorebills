const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { CHAIN, NATIVE, usd, ref, installPqcMock, signAs } = require("./helpers");

async function deploy() {
  const [owner, agent, power, stranger] = await ethers.getSigners();
  const { keys } = await installPqcMock([owner, stranger]);
  const token = await (await ethers.getContractFactory("MockERC20")).deploy();
  const factory = await (await ethers.getContractFactory("BillAgentFactory")).deploy(CHAIN);
  const config = {
    agent: agent.address,
    agentExpiry: (await time.latest()) + 30 * 24 * 3600,
    maxPaymentsPerDay: 5,
    tokens: [{ token: await token.getAddress(), autoPayLimit: usd(20), maxPerPayment: usd(100), dailyCap: usd(150) }],
    billers: [{ biller: power.address, name: "IBEDC electricity" }],
  };
  const setupId = ethers.hexlify(ethers.randomBytes(16));
  const deadline = (await time.latest()) + 1800;
  const text = await factory.setupMessage(owner.address, config, setupId, deadline);
  const sig = signAs(keys.get(owner.address), text);
  return { owner, agent, power, stranger, token, factory, config, setupId, deadline, text, sig, keys };
}

describe("BillAgentFactory", function () {
  it("shows the whole setup in plain text", async function () {
    const { factory, owner, agent, power, token, text, setupId, deadline, config } = await loadFixture(deploy);
    const shown = ethers.toUtf8String(text);
    expect(shown).to.equal(
      [
        "QoreBills: create my bill account",
        `owner: ${owner.address.toLowerCase()}`,
        `agent: ${agent.address.toLowerCase()}`,
        `agent expires: ${config.agentExpiry}`,
        "payments per day: 5",
        "",
        `token: ${(await token.getAddress()).toLowerCase()}`,
        "auto-pay up to: 20 tUSD",
        "max per payment: 100 tUSD",
        "daily cap: 150 tUSD",
        "",
        `biller: IBEDC electricity ${power.address.toLowerCase()}`,
        "",
        `setup: ${setupId}`,
        "evm chain: 31337",
        `factory: ${(await factory.getAddress()).toLowerCase()}`,
        `valid until: ${deadline}`,
      ].join("\n")
    );
  });

  it("creates the account the owner signed for, submitted by anyone", async function () {
    const { factory, owner, agent, power, stranger, token, config, setupId, deadline, sig } = await loadFixture(deploy);
    const tx = factory.connect(stranger).createAccount(owner.address, config, setupId, deadline, sig);
    await expect(tx).to.emit(factory, "AccountCreated");
    const accountAddress = await factory.accountOf(owner.address);
    expect(await factory.isAccount(accountAddress)).to.equal(true);
    const account = await ethers.getContractAt("BillAgentAccount", accountAddress);
    expect(await account.owner()).to.equal(owner.address);
    expect(await account.cosmosChainId()).to.equal(CHAIN);
    expect(await account.agent()).to.equal(agent.address);
    expect(await account.billerInfo(power.address)).to.deep.equal([true, "IBEDC electricity"]);

    // And it works: the agent can pay straight away once it is funded.
    await token.mint(accountAddress, usd(50));
    await account.connect(agent).pay(power.address, await token.getAddress(), usd(10), ref("first"));
    expect(await token.balanceOf(power.address)).to.equal(usd(10));
  });

  it("refuses a setup that was changed, reused, expired or signed by someone else", async function () {
    const { factory, owner, stranger, config, setupId, deadline, sig, keys } = await loadFixture(deploy);
    const changed = { ...config, maxPaymentsPerDay: 50 };
    await expect(factory.createAccount(owner.address, changed, setupId, deadline, sig)).to.be.revertedWithCustomError(factory, "InvalidOwnerSignature");
    // The owner's signature does not create an account for someone else.
    await expect(factory.createAccount(stranger.address, config, setupId, deadline, sig)).to.be.revertedWithCustomError(factory, "InvalidOwnerSignature");
    // Another registered key cannot sign for this owner.
    const other = signAs(keys.get(stranger.address), await factory.setupMessage(owner.address, config, setupId, deadline));
    await expect(factory.createAccount(owner.address, config, setupId, deadline, other)).to.be.revertedWithCustomError(factory, "InvalidOwnerSignature");

    await factory.createAccount(owner.address, config, setupId, deadline, sig);
    await expect(factory.createAccount(owner.address, config, setupId, deadline, sig)).to.be.revertedWithCustomError(factory, "SetupAlreadyUsed");

    const id2 = ethers.hexlify(ethers.randomBytes(16));
    const soon = (await time.latest()) + 5;
    const sig2 = signAs(keys.get(owner.address), await factory.setupMessage(owner.address, config, id2, soon));
    await time.increase(30);
    await expect(factory.createAccount(owner.address, config, id2, soon, sig2)).to.be.revertedWithCustomError(factory, "SignatureExpired");
  });

  it("only the factory can use its deployer", async function () {
    const { factory, owner, config } = await loadFixture(deploy);
    const deployer = await ethers.getContractAt("BillAgentDeployer", await factory.deployer());
    await expect(deployer.deploy(owner.address, CHAIN, config)).to.be.revertedWithCustomError(deployer, "OnlyFactory");
  });

  it("limits the setup size", async function () {
    const { factory, owner, config, setupId, deadline } = await loadFixture(deploy);
    const many = { ...config, billers: Array.from({ length: 13 }, (_, i) => ({ biller: ethers.Wallet.createRandom().address, name: `Biller ${i}` })) };
    await expect(factory.setupMessage(owner.address, many, setupId, deadline)).to.be.revertedWithCustomError(factory, "TooManyEntries");
    const native = { ...config, tokens: [{ token: NATIVE, autoPayLimit: 1, maxPerPayment: 2, dailyCap: 3 }] };
    expect(ethers.toUtf8String(await factory.setupMessage(owner.address, native, setupId, deadline))).to.contain("auto-pay up to: 0.000000000000000001 QOR");
  });
});
