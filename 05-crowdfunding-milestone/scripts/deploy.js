// Deploys CrowdfundingMilestone to the network given by --network.
// Local use:  npm run node   (terminal 1)
//             npm run deploy:local   (terminal 2)
const hre = require("hardhat");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const factory = await hre.ethers.getContractFactory("CrowdfundingMilestone");
  const contract = await factory.deploy();
  const receipt = await contract.deploymentTransaction().wait();
  const address = await contract.getAddress();

  console.log(`Network:        ${hre.network.name}`);
  console.log(`Deployer:       ${deployer.address}`);
  console.log(`Contract:       ${address}`);
  console.log(`Deployed block: ${receipt.blockNumber}`);
  console.log("\nOpen the frontend with this contract:");
  console.log(`  http://localhost:8080/?address=${address}&fromBlock=${receipt.blockNumber}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
