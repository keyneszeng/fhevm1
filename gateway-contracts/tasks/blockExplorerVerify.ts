const { task } = require("hardhat/config");

// ==========================================
// 1. 配置区域：在这里统一管理所有合约
// ==========================================
const CONTRACT_CONFIGS = [
  {
    name: "CiphertextCommits",
    envKey: "CIPHERTEXT_COMMITS_ADDRESS",
    isProxy: true, // 标记为代理合约，会自动验证 Implementation
  },
  {
    name: "Decryption",
    envKey: "DECRYPTION_ADDRESS",
    isProxy: true,
  },
  {
    name: "PrecompileCostEstimator",
    envKey: "PRECOMPILE_COST_ESTIMATOR_ADDRESS",
    isProxy: true,
  },
  {
    name: "CiphertextResults",
    envKey: "CIPHERTEXT_RESULTS_ADDRESS",
    isProxy: true,
  },
  {
    name: "GatewayContract",
    envKey: "GATEWAY_CONTRACT_ADDRESS",
    isProxy: true,
  },
  {
    name: "PauserSet",
    envKey: "PAUSER_SET_ADDRESS",
    isProxy: false, // PauserSet 似乎不是代理，标记为 false
  },
  {
    name: "FhevmParams",
    envKey: "FHEVM_PARAMS_ADDRESS",
    isProxy: true,
  },
  {
    name: "BytecodeRegistry",
    envKey: "BYTECODE_REGISTRY_ADDRESS",
    isProxy: true,
  },
];

// ==========================================
// 2. 辅助工具函数
// ==========================================

// 获取环境变量，不存在则抛错
const getRequiredEnvVar = (envVar) => {
  const value = process.env[envVar];
  if (!value) {
    throw new Error(`缺少环境变量: ${envVar}`);
  }
  return value;
};

// 简单的延时函数，防止触发 Etherscan API 速率限制
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 通用验证核心逻辑
const verifyContractLogic = async (hre, config) => {
  const { name, envKey, isProxy } = config;
  const address = getRequiredEnvVar(envVar);
  
  console.log(`\nStarting verification for [${name}] at ${address}...`);

  // 1. 验证主合约 (如果是 Proxy，这里验证的是 Proxy 本身)
  try {
    await hre.run("verify:verify", {
      address: address,
      constructorArguments: [], // 如果有特定参数，可以在 Config 中扩展
    });
    console.log(`✅ [${name}] Contract verified.`);
  } catch (error) {
    // 忽略“已验证”的错误，其他错误抛出
    if (error.message.toLowerCase().includes("already verified")) {
      console.log(`ℹ️ [${name}] Already verified.`);
    } else {
      throw new Error(`Failed to verify ${name}: ${error.message}`);
    }
  }

  // 2. 如果是代理合约，获取并验证 Implementation
  if (isProxy) {
    try {
      const implAddress = await hre.upgrades.erc1967.getImplementationAddress(address);
      console.log(`   Detected Implementation for [${name}] at ${implAddress}`);
      
      await sleep(1000); // 稍微休息一下，保护 API 调用频率

      await hre.run("verify:verify", {
        address: implAddress,
        constructorArguments: [],
      });
      console.log(`✅ [${name}] Implementation verified.`);
    } catch (error) {
      if (error.message.toLowerCase().includes("already verified")) {
        console.log(`ℹ️ [${name}] Implementation already verified.`);
      } else {
        throw new Error(`Failed to verify Implementation of ${name}: ${error.message}`);
      }
    }
  }
};

// ==========================================
// 3. 任务定义
// ==========================================

// 主任务：批量验证所有网关合约
task("task:verifyAllGatewayContracts", "Verifies all gateway contracts and their implementations")
  .setAction(async (taskArgs, hre) => {
    const results = [];
    let hasFailure = false;

    console.log("🚀 开始批量验证流程...\n");

    for (const config of CONTRACT_CONFIGS) {
      const result = { name: config.name, status: "PENDING", error: null };
      try {
        await verifyContractLogic(hre, config);
        result.status = "SUCCESS";
      } catch (err) {
        console.error(`❌ Error verifying ${config.name}:`, err.message);
        result.status = "FAILED";
        result.error = err.message;
        hasFailure = true;
      }
      results.push(result);
      
      // 任务间间隔，避免 API 封禁
      await sleep(1500); 
    }

    // ==========================================
    // 4. 最终汇总报告 (CI/CD 关键部分)
    // ==========================================
    console.log("\n==========================================");
    console.log("             验证结果汇总 Report           ");
    console.log("==========================================");
    
    console.table(results.map(r => ({
      Contract: r.name,
      Status: r.status,
      Error: r.error ? r.error.substring(0, 50) + "..." : "" // 截断错误信息以便展示
    })));

    if (hasFailure) {
      console.error("\n❌ 部分合约验证失败，请检查上方日志。");
      process.exit(1); // 非零退出码，通知 CI 流水线失败
    } else {
      console.log("\n✅ 所有合约验证成功！");
    }
  });

// 这是一个可选的通用任务，如果你只想验证单个合约
// 用法: npx hardhat task:verifySingle --name CiphertextCommits
task("task:verifySingle", "Verifies a single contract by name defined in config")
  .addParam("name", "The name of the contract configuration to use")
  .setAction(async ({ name }, hre) => {
    const config = CONTRACT_CONFIGS.find(c => c.name === name);
    if (!config) {
      throw new Error(`找不到名为 ${name} 的配置项`);
    }
    await verifyContractLogic(hre, config);
  });
