require("@nomicfoundation/hardhat-toolbox");
const path = require("node:path");
const { subtask } = require("hardhat/config");
const { TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD } = require("hardhat/builtin-tasks/task-names");

const SOLC_VERSION = "0.8.24";

// Compile with the solc package from node_modules instead of downloading a
// compiler, so the project builds on networks that block binaries.soliditylang.org.
subtask(TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD, async ({ solcVersion }, hre, runSuper) => {
  if (solcVersion !== SOLC_VERSION) return runSuper();
  const solc = require("solc");
  return {
    compilerPath: path.join(path.dirname(require.resolve("solc")), "soljson.js"),
    isSolcJs: true,
    version: solcVersion,
    longVersion: solc.version(),
  };
});

const accounts = process.env.DEPLOYER_KEY ? [process.env.DEPLOYER_KEY] : [];

module.exports = {
  solidity: {
    version: SOLC_VERSION,
    // "paris" keeps the bytecode free of opcodes newer than the QoreChain EVM needs.
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "paris" },
  },
  networks: {
    qoreTestnet: {
      url: process.env.QORE_EVM_RPC || "https://evm-testnet.qore.host",
      chainId: 9800,
      accounts,
    },
  },
};
