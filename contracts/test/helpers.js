const { ethers, network } = require("hardhat");

const PQC_VERIFY = "0x0000000000000000000000000000000000000a01";
const PQC_KEY_STATUS = "0x0000000000000000000000000000000000000a02";
const CHAIN = "qorechain-diana";
const NATIVE = ethers.ZeroAddress;
const usd = (n) => ethers.parseUnits(String(n), 6);
const ref = (s) => ethers.id(s);

const Kind = { SetBiller: 0, RemoveBiller: 1, SetLimits: 2, DisableToken: 3, SetAgent: 4, SetMaxPaymentsPerDay: 5, Pause: 6, Unpause: 7, Withdraw: 8 };
const action = (kind, f = {}) => ({
  kind,
  target: f.target || ethers.ZeroAddress,
  token: f.token || ethers.ZeroAddress,
  a: f.a || 0n,
  b: f.b || 0n,
  c: f.c || 0n,
  name: f.name || "",
});

/** Put the mock precompile at both PQC addresses and register `owners` with a key each. */
async function installPqcMock(owners) {
  const mock = await (await ethers.getContractFactory("MockQorePQC")).deploy();
  const code = await ethers.provider.getCode(await mock.getAddress());
  await network.provider.send("hardhat_setCode", [PQC_VERIFY, code]);
  await network.provider.send("hardhat_setCode", [PQC_KEY_STATUS, code]);
  const keyStatus = await ethers.getContractAt("MockQorePQC", PQC_KEY_STATUS);
  const keys = new Map();
  for (const owner of owners) {
    const pubkey = ethers.hexlify(ethers.randomBytes(2592));
    await keyStatus.setKey(owner.address, true, 1, pubkey, true);
    keys.set(owner.address, pubkey);
  }
  return { keyStatus, keys };
}

/** What the mock accepts as the owner's ML-DSA-87 signature over `text` (bytes from the contract). */
function signAs(pubkey, text) {
  const signed = ethers.concat([ethers.toUtf8Bytes(`qorechain-msg-v1|${CHAIN}|`), text]);
  return ethers.keccak256(ethers.concat([pubkey, signed]));
}

module.exports = { PQC_VERIFY, PQC_KEY_STATUS, CHAIN, NATIVE, usd, ref, Kind, action, installPqcMock, signAs };
