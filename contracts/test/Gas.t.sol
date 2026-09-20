// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {CreatorSplitter} from "../src/CreatorSplitter.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

/**
 * @title pay() 的实测 gas
 *
 * 这不是断言测试,是**测量**。目的:把方案 §12.2 里那个 `ESTIMATED_PAY_GAS = 250_000`
 * 的抽样上界换成真实数字。
 *
 * 为什么值得单独测:方案 §12.2 定"演示价 0.2 USDC"的依据是
 * "AVAX 波动到什么价位时 gas 成本会超过价格的 2.5%"。这个论断的分母就是这里测出的数。
 * 收款方数量直接决定循环次数,所以按 1/2/3/5 方分别测。
 *
 * 跑法:`forge test --match-path test/Gas.t.sol -vv`
 */
contract GasTest is Test {
    MockUSDC internal usdc;
    CreatorSplitter internal splitter;
    address internal creator = makeAddr("creator");
    address internal buyer = makeAddr("buyer");

    function setUp() public {
        usdc = new MockUSDC();
        splitter = new CreatorSplitter(address(usdc));
        usdc.mint(buyer, 1_000_000_000);
        vm.prank(buyer);
        usdc.approve(address(splitter), type(uint256).max);
    }

    /// @dev 每次测量用**互不重叠**的收款地址段。
    ///      复用地址会让第二次起落进"非零余额 → 非零"的 SSTORE 便宜档,
    ///      测出来的数不可比(第一版就踩了这个坑:1 个收款方反而比 2 个贵)。
    function _measure(uint256 n) internal returns (uint256 gasUsed, uint256 createGas) {
        address[] memory recipients = new address[](n);
        uint16[] memory splits = new uint16[](n);
        for (uint256 i; i < n; ++i) {
            // n ≤ 5、i ≤ 4,最大 0x1000+504,离 uint160 上界差着天堑
            // forge-lint: disable-next-line(unsafe-typecast)
            recipients[i] = address(uint160(0x1000 + n * 100 + i)); // 按 n 分段,全冷
            // n ≥ 1,故 10000/n ≤ 10000,uint16 装得下
            // forge-lint: disable-next-line(unsafe-typecast)
            splits[i] = uint16(10000 / n);
        }
        uint256 assigned;
        for (uint256 i; i < n - 1; ++i) assigned += splits[i];
        // assigned 是前 n-1 项之和,恒 < 10000
        // forge-lint: disable-next-line(unsafe-typecast)
        splits[n - 1] = uint16(10000 - assigned);

        bytes32 id = keccak256(abi.encode("gas", n));

        vm.prank(creator);
        uint256 beforeCreate = gasleft();
        splitter.createContent(id, 200_000, bytes32(0), recipients, splits);
        createGas = beforeCreate - gasleft();

        vm.prank(buyer);
        uint256 before = gasleft();
        splitter.pay(id);
        gasUsed = before - gasleft();
    }

    function test_ReportGas() public {
        console.log("");
        console.log("=== CreatorSplitter gas, by recipient count ===");
        console.log("(all recipients are fresh addresses: never held USDC before)");
        console.log("");
        console.log("n   createContent   pay()   pay()+intrinsic");

        uint256[5] memory ns = [uint256(1), 2, 3, 4, 5];
        for (uint256 i; i < 5; ++i) {
            (uint256 g, uint256 c) = _measure(ns[i]);
            // 一笔真实交易还要加:intrinsic 21000 + calldata(pay(bytes32) = 4+32 字节)
            console.log(ns[i], c, g, g + 21_000 + 36 * 16);
        }

        console.log("");
        console.log("intrinsic = 21000 + 36 bytes calldata * 16 gas/byte");
        console.log("price = 0.2 USDC = 200000 (6 decimals)");
        console.log("");
    }
}
