import { ethers } from "ethers";
import fs from "fs";

// ⚠️ Update this if your deployed address is different
// (check backend/.env -> CONTRACT_ADDRESS)
const CONTRACT_ADDRESS = "0x5FbDB2315678afecb367f032d93F642f64180aa3";

async function main() {

  const provider = new ethers.JsonRpcProvider("http://127.0.0.1:8545");

  const artifact = JSON.parse(
    fs.readFileSync(
      "./artifacts/contracts/BillingSystem.sol/TaxBillingSystem.json",
      "utf8"
    )
  );

  const contract = new ethers.Contract(
    CONTRACT_ADDRESS,
    artifact.abi,
    provider
  );

  console.log("\n========================================");
  console.log("PROOF 1: Data exists on-chain, read independently");
  console.log("========================================");

  const count = await contract.getRecordCount();
  console.log("Total records stored on-chain:", count.toString());

  if (count > 0n) {
    const record = await contract.getTaxRecord(count);
    console.log("Latest record (fetched directly from the contract, not your app):");
    console.log(record);
  } else {
    console.log("No records yet — file one from the UI first, then re-run this script.");
  }

  console.log("\n========================================");
  console.log("PROOF 2: The contract has no edit/delete function");
  console.log("========================================");

  const functionNames = artifact.abi
    .filter((item) => item.type === "function")
    .map((item) => item.name);

  console.log("All callable functions on this contract:");
  console.log(functionNames);
  console.log(
    "\nNotice there is no 'updateTaxRecord' or 'deleteTaxRecord' — " +
    "the only way to add data is createTaxRecord, which always appends a new record."
  );

  console.log("\n========================================");
  console.log("PROOF 3: Role rules are enforced on-chain, not by the website");
  console.log("========================================");

  // Account #5 has never been assigned any role
  const randomSigner = await provider.getSigner(5);
  const randomAddress = await randomSigner.getAddress();
  const contractAsRandom = contract.connect(randomSigner);

  console.log(`Attempting createTaxRecord() using an unauthorized account (${randomAddress})...`);

  try {
    const tx = await contractAsRandom.createTaxRecord(
      "Fake Taxpayer",
      "AAAAA0000A",
      "Test",
      100,
      10,
      "Karnataka"
    );
    await tx.wait();
    console.log("⚠️ Unexpected: this should have failed!");
  } catch (err) {
    console.log("✓ REJECTED by the blockchain itself, as expected.");
    console.log("Reason:", err.reason || err.shortMessage || err.message);
  }

  console.log("\n========================================");
  console.log("PROOF 4: Real block-hash chaining (immutability)");
  console.log("========================================");

  const latestBlockNumber = await provider.getBlockNumber();

  if (latestBlockNumber >= 1) {
    const currentBlock = await provider.getBlock(latestBlockNumber);
    const previousBlock = await provider.getBlock(latestBlockNumber - 1);

    console.log(`Block #${currentBlock.number} hash:        `, currentBlock.hash);
    console.log(`Block #${currentBlock.number} parentHash:  `, currentBlock.parentHash);
    console.log(`Block #${previousBlock.number} hash:        `, previousBlock.hash);

    console.log(
      "\nDoes block",
      currentBlock.number,
      "'s parentHash match block",
      previousBlock.number,
      "'s hash?",
      currentBlock.parentHash === previousBlock.hash
    );

    console.log(
      "\nIf anyone edited data inside block " + previousBlock.number +
      ", its hash would change completely, breaking this link " +
      "and every block chained after it."
    );
  } else {
    console.log("Not enough blocks mined yet to show chaining — file a couple of tax records first.");
  }

  console.log("\n========================================");
  console.log("DONE");
  console.log("========================================\n");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
