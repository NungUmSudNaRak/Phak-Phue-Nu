require("@nomicfoundation/hardhat-ethers");
require("@nomicfoundation/hardhat-chai-matchers");

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  // Same compiler as Remix. The optimizer stays off, as in Remix by default.
  solidity: "0.8.24",
  paths: {
    tests: "./tests",
  },
};
