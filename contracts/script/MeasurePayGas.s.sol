// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {CreatorSplitter} from "../src/CreatorSplitter.sol";

interface IERC20Approve {
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address who) external view returns (uint256);
}

/**
 * @title MeasurePayGas
 * @notice 用**一笔真实交易**测出 `pay()` 的 gas,替换方案 §12.2 表里的绝对数。
 *
 * ## 为什么非要在链上测,不用 Foundry 单测的数
 *
 * `test/Gas.t.sol` 已经测出了形状(每方 +28,750 gas),但那是跑在 USDC **替身**
 * 上的 —— 替身没有代理转发、不发 `Transfer` 事件、不读黑名单存储。
 * 真实 USDC 三样都有,实测一笔真实转账贵约 26,500 gas。
 * **形状可信,绝对数必须来自真实 USDC。**
 *
 * ## 跑法
 *
 * 前提:PAYER 地址有 USDC(`faucet.circle.com`,每地址每 2 小时 1 USDC)。
 * 一次 `pay` 花 0.2 USDC,所以 1 USDC 够跑 5 次。
 *
 * ```bash
 * export SPLITTER_ADDRESS=0xDe9b3090263e20ebD5b3795F0199B500f6da72f5
 * export PAYER=0xA0b760DCb7561B30E728170Ce58f4df2D2843D63
 * forge script script/MeasurePayGas.s.sol \
 *   --rpc-url https://api.avax-test.network/ext/bc/C/rpc \
 *   --account splitjar-deployer --broadcast
 * ```
 *
 * 跑完**去读那三笔交易的收据**取 `gasUsed` —— 别用脚本里的 `console.log`
 * 或 `gasleft()`:脚本先在本地模拟再广播,本地量到的数不含真实的
 * calldata 与存储冷热差异。只有收据上的 `gasUsed` 是权威的:
 *
 * ```bash
 * cast receipt <pay 那笔的 hash> --json | jq .gasUsed
 * ```
 */
contract MeasurePayGas is Script {
    function run() external {
        address splitterAddr = vm.envAddress("SPLITTER_ADDRESS");
        address payer = vm.envAddress("PAYER");
        uint256 n = vm.envOr("RECIPIENTS", uint256(3));
        uint256 price = vm.envOr("PRICE", uint256(200_000)); // 0.2 USDC

        CreatorSplitter splitter = CreatorSplitter(splitterAddr);
        address usdc = address(splitter.usdc());

        uint256 balance = IERC20Approve(usdc).balanceOf(payer);
        require(balance >= price, "PAYER does not have enough USDC - use the Circle faucet");
        console.log("PAYER USDC balance:", balance);

        // ── 构造 n 方分账 ─────────────────────────────────────────
        address[] memory recipients = new address[](n);
        uint16[] memory splits = new uint16[](n);
        for (uint256 i; i < n; ++i) {
            // 收款方只要是非零地址即可,gas 与地址本身无关
            recipients[i] = i == 0
                ? payer
                : address(uint160(uint256(keccak256(abi.encode(payer, i)))));
            // 均分;不整除时最后一方吃余数(正好也顺带验证了这条语义)
            // n >= 1,故 10000/n <= 10000,uint16 装得下
            // forge-lint: disable-next-line(unsafe-typecast)
            splits[i] = uint16(10000 / n);
        }
        uint256 assigned;
        for (uint256 i; i < n - 1; ++i) assigned += splits[i];
        // assigned 是前 n-1 项之和,恒 < 10000
        // forge-lint: disable-next-line(unsafe-typecast)
        splits[n - 1] = uint16(10000 - assigned);

        // 每次都用全新的 contentId,否则同一买家第二次 pay 会 AlreadyPurchased
        bytes32 contentId = keccak256(abi.encode("gas-measure", block.timestamp, payer));

        vm.startBroadcast();

        splitter.createContent(contentId, price, bytes32(0), recipients, splits);

        // 首次购买是两笔交易:先 approve 再 pay
        IERC20Approve(usdc).approve(splitterAddr, price);

        splitter.pay(contentId);

        vm.stopBroadcast();

        console.log("");
        console.log("contentId :", vm.toString(contentId));
        console.log("recipients:", n);
        console.log("");
        console.log("Now read the receipts - ONLY the on-chain gasUsed is authoritative:");
        console.log("  forge script wrote them to broadcast/MeasurePayGas.s.sol/43113/run-latest.json");

        // 顺带确认分账真的到账了,别只看 gas
        for (uint256 i; i < n; ++i) {
            console.log("  recipient", i, "got:", IERC20Approve(usdc).balanceOf(recipients[i]));
        }
    }
}
