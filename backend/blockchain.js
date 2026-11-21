require("dotenv").config();
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

const provider = new ethers.JsonRpcProvider(
    process.env.RPC_URL
);

async function getAdminContract() {

    // Account #0 = Admin
    const signer = await provider.getSigner(0);

    const artifactPath = path.join(
        __dirname,
        "../blockchain/artifacts/contracts/BillingSystem.sol/TaxBillingSystem.json"
    );

    const artifact = JSON.parse(
        fs.readFileSync(
            artifactPath,
            "utf8"
        )
    );

    return new ethers.Contract(
        process.env.CONTRACT_ADDRESS,
        artifact.abi,
        signer
    );
}

async function getContract() {

    // Account #1 = Tax Officer
    const signer = await provider.getSigner(1);

    const artifactPath = path.join(
        __dirname,
        "../blockchain/artifacts/contracts/BillingSystem.sol/TaxBillingSystem.json"
    );

    const artifact = JSON.parse(
        fs.readFileSync(
            artifactPath,
            "utf8"
        )
    );

    return new ethers.Contract(
        process.env.CONTRACT_ADDRESS,
        artifact.abi,
        signer
    );
}

async function getAuditorContract() {

    // Account #2 = Auditor
    const signer = await provider.getSigner(2);

    const artifactPath = path.join(
        __dirname,
        "../blockchain/artifacts/contracts/BillingSystem.sol/TaxBillingSystem.json"
    );

    const artifact = JSON.parse(
        fs.readFileSync(
            artifactPath,
            "utf8"
        )
    );

    return new ethers.Contract(
        process.env.CONTRACT_ADDRESS,
        artifact.abi,
        signer
    );
}

module.exports = {
    getContract,
    getAuditorContract,
    getAdminContract,
    provider
};