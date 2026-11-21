import { ethers } from "ethers";
import fs from "fs";

async function main() {

  // Load contract artifact
  const artifact = JSON.parse(
    fs.readFileSync(
      "./artifacts/contracts/BillingSystem.sol/TaxBillingSystem.json",
      "utf8"
    )
  );

  // Connect to Hardhat local blockchain
  const provider = new ethers.JsonRpcProvider(
    "http://127.0.0.1:8545"
  );

  // Get Hardhat accounts
  const admin = await provider.getSigner(0);
  const taxOfficer = await provider.getSigner(1);
  const auditor = await provider.getSigner(2);

  // Get addresses
  const adminAddress = await admin.getAddress();
  const taxOfficerAddress = await taxOfficer.getAddress();
  const auditorAddress = await auditor.getAddress();

  console.log("\n========== ACCOUNTS ==========");
  console.log("Admin:       ", adminAddress);
  console.log("Tax Officer: ", taxOfficerAddress);
  console.log("Auditor:     ", auditorAddress);


  // Deploy contract using Admin
  const factory = new ethers.ContractFactory(
    artifact.abi,
    artifact.bytecode,
    admin
  );

  const contract = await factory.deploy();

  await contract.waitForDeployment();

  const contractAddress =
    await contract.getAddress();

  console.log("\n========== CONTRACT ==========");
  console.log(
    "TaxBillingSystem deployed at:",
    contractAddress
  );


  // Assign Tax Officer role
  console.log("\nAssigning Tax Officer role...");

  const officerTx =
    await contract.assignTaxOfficer(
      taxOfficerAddress
    );

  await officerTx.wait();

  console.log(
    "Tax Officer role assigned successfully."
  );


  // Assign Auditor role
  console.log("\nAssigning Auditor role...");

  const auditorTx =
    await contract.assignAuditor(
      auditorAddress
    );

  await auditorTx.wait();

  console.log(
    "Auditor role assigned successfully."
  );


  // Verify roles
  console.log("\n========== ROLE VERIFICATION ==========");

  const adminRole =
    await contract.getRole(adminAddress);

  const officerRole =
    await contract.getRole(taxOfficerAddress);

  const auditorRole =
    await contract.getRole(auditorAddress);

  console.log(
    "Admin role:       ",
    adminRole.toString()
  );

  console.log(
    "Tax Officer role: ",
    officerRole.toString()
  );

  console.log(
    "Auditor role:     ",
    auditorRole.toString()
  );

  console.log("\n========== DEPLOYMENT COMPLETE ==========\n");
}


main().catch((error) => {

  console.error(error);

  process.exitCode = 1;

});