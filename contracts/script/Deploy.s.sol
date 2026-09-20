// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {CreatorSplitter} from "../src/CreatorSplitter.sol";

interface IERC20Metadata {
    function decimals() external view returns (uint8);
    function symbol() external view returns (string memory);
}

/**
 * @title Deploy
 * @notice 把 `CreatorSplitter` 部署到 Fuji。
 *
 * ## 跑法
 *
 * 部署私钥**只在当前 shell 里 export,绝不写进 `.env`**(方案 §6.2):
 *
 * ```bash
 * export FUJI_RPC_URL="https://api.avax-test.network/ext/bc/C/rpc"
 * export DEPLOYER_PRIVATE_KEY="0x..."   # 领过 AVAX 的地址
 * forge script script/Deploy.s.sol --rpc-url fuji --broadcast
 * ```
 *
 * 默认走 Fuji USDC。换网络时用 `USDC_ADDRESS` 覆盖。
 *
 * ## 为什么脚本里要检查 `decimals()`
 *
 * USDC 地址是经典的翻车点 —— 抄错一位,合约能部署成功,但**每一笔支付都会失败**,
 * 而且失败信息毫无提示。这里在广播**之前**读一次链上 `decimals()`,
 * 把"地址写错"从一个运行时故障变成一个部署期报错。
 *
 * 注意这道检查**不是**多余的:它和 `shared/chain.ts` 从 `viem` 注册表取值是
 * 两个独立来源。脚本这层防的是"人手敲进环境变量的那个地址"。
 */
contract Deploy is Script {
    /// @dev Fuji USDC。与 `shared/chain.ts` 的 viem 注册表、Circle 官方文档两处已核对一致。
    address internal constant FUJI_USDC = 0x5425890298aed601595a70AB815c96711a31Bc65;

    function run() external returns (CreatorSplitter splitter) {
        address usdc = vm.envOr("USDC_ADDRESS", FUJI_USDC);

        // ── 广播前先验地址 ────────────────────────────────────────
        require(usdc.code.length > 0, "USDC address has no code (wrong chain or address?)");

        uint8 decimals = IERC20Metadata(usdc).decimals();
        require(decimals == 6, "USDC decimals must be 6");
        string memory symbol = IERC20Metadata(usdc).symbol();

        console.log("chainId  :", block.chainid);
        console.log("USDC     :", usdc);
        console.log("symbol   :", symbol);
        console.log("decimals :", decimals);
        console.log("");

        vm.startBroadcast();
        splitter = new CreatorSplitter(usdc);
        vm.stopBroadcast();

        // 读回 immutable,确认真的落进去了
        require(address(splitter.usdc()) == usdc, "usdc immutable mismatch");

        console.log("CreatorSplitter deployed at:", address(splitter));
        console.log("");
        console.log("Next: put this in BOTH places (front end .env, and Vercel server env)");
        console.log("  VITE_SPLITTER_ADDRESS =", address(splitter));
        console.log("  SPLITTER_ADDRESS      =", address(splitter));
    }
}
