import { ethers } from "ethers";

async function main() {

  const provider = new ethers.JsonRpcProvider(
    "http://127.0.0.1:8545"
  );

  const signer = await provider.getSigner(0);

  const abi = [
    "function createTaxRecord(string,string,string,uint256,uint256,string)",
    "function recordCount() view returns (uint256)"
  ];

  const contractAddress =
    "0x5FbDB2315678afecb367f032d93F642f64180aa3";

  const contract = new ethers.Contract(
    contractAddress,
    abi,
    signer
  );

  const tx = await contract.createTaxRecord(
    "Jinesh Jain",
    "ABCDE1234F",
    "Laptop",
    50000,
    9000,
    "Karnataka"
  );

  await tx.wait();

  console.log("Tax record stored successfully!");

  const count = await contract.recordCount();

  console.log("Total Records:", count.toString());
}

main().catch(console.error);