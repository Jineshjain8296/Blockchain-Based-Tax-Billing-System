import { ethers } from "ethers";

async function main() {
  const provider = new ethers.JsonRpcProvider("http://127.0.0.1:8545");

  const signer = await provider.getSigner(0);

  const abi = [
    "function createInvoice(string,string,uint256)",
    "function invoiceCount() view returns (uint256)"
  ];

  const contractAddress = "0x5FbDB2315678afecb367f032d93F642f64180aa3";

  const contract = new ethers.Contract(contractAddress, abi, signer);

  const tx = await contract.createInvoice("John", "Laptop", 5000);

  await tx.wait();

  console.log("Invoice created successfully!");
}

main().catch(console.error);