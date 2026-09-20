// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {CreatorSplitter} from "../src/CreatorSplitter.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

/*//////////////////////////////////////////////////////////////////
                            测试替身
//////////////////////////////////////////////////////////////////*/

/**
 * 一个"什么都拒收"的合约 —— 所有调用与转账都 revert。
 *
 * 存在的唯一目的是**证伪**一件事:见 `test_ERC20_NoHook_RejectingContractStillGetsPaid`。
 */
contract RejectingRecipient {
    receive() external payable {
        revert("no thanks");
    }

    fallback() external payable {
        revert("no thanks");
    }
}

/*//////////////////////////////////////////////////////////////////
                              测试
//////////////////////////////////////////////////////////////////*/

contract CreatorSplitterTest is Test {
    MockUSDC internal usdc;
    CreatorSplitter internal splitter;

    address internal creator = makeAddr("creator");
    address internal buyer = makeAddr("buyer");

    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");

    bytes32 internal constant CONTENT_ID = keccak256("my-first-article");
    bytes32 internal constant CONTENT_HASH = keccak256("the actual file bytes");
    uint256 internal constant PRICE = 200_000; // 0.2 USDC

    function setUp() public {
        usdc = new MockUSDC();
        splitter = new CreatorSplitter(address(usdc));

        usdc.mint(buyer, 100_000_000); // 100 USDC
    }

    /*//////////////////////////////////////////////////////////////
                            辅助
    //////////////////////////////////////////////////////////////*/

    function _threeWay() internal view returns (address[] memory r, uint16[] memory s) {
        r = new address[](3);
        s = new uint16[](3);
        (r[0], r[1], r[2]) = (alice, bob, carol);
        (s[0], s[1], s[2]) = (7000, 2000, 1000);
    }

    function _register(bytes32 id, uint256 price, address[] memory r, uint16[] memory s) internal {
        vm.prank(creator);
        splitter.createContent(id, price, CONTENT_HASH, r, s);
    }

    function _approveAndPay(address payer, bytes32 id, uint256 amount) internal {
        vm.startPrank(payer);
        usdc.approve(address(splitter), amount);
        splitter.pay(id);
        vm.stopPrank();
    }

    /*//////////////////////////////////////////////////////////////
                        创建:正常路径
    //////////////////////////////////////////////////////////////*/

    function test_CreateContent_StoresAllFields() public {
        (address[] memory r, uint16[] memory s) = _threeWay();
        _register(CONTENT_ID, PRICE, r, s);

        (
            address cCreator,
            uint256 cPrice,
            bytes32 cHash,
            address[] memory cRecipients,
            uint16[] memory cSplits,
            bool cActive
        ) = splitter.getContent(CONTENT_ID);

        assertEq(cCreator, creator, "creator must be msg.sender");
        assertEq(cPrice, PRICE);
        assertEq(cHash, CONTENT_HASH);
        assertEq(cRecipients.length, 3);
        assertEq(cSplits[0], 7000);
        assertTrue(cActive, "new content must default to active");
    }

    /// v1 的漏洞 ①:`creator` 参数可被伪造。现在它恒为 msg.sender,没有参数可传。
    function test_CreateContent_CreatorCannotBeSpoofed() public {
        (address[] memory r, uint16[] memory s) = _threeWay();

        vm.prank(buyer); // 冒名者
        splitter.createContent(CONTENT_ID, PRICE, CONTENT_HASH, r, s);

        (address cCreator, , , , , ) = splitter.getContent(CONTENT_ID);
        assertEq(cCreator, buyer, "creator is whoever called, by construction");
        assertTrue(cCreator != creator);
    }

    /*//////////////////////////////////////////////////////////////
                        创建:校验与边界
    //////////////////////////////////////////////////////////////*/

    function test_RevertWhen_SplitTotalIsNot10000() public {
        address[] memory r = new address[](2);
        uint16[] memory s = new uint16[](2);
        (r[0], r[1]) = (alice, bob);
        (s[0], s[1]) = (7000, 2000); // 合计 9000

        vm.prank(creator);
        vm.expectRevert(
            abi.encodeWithSelector(CreatorSplitter.InvalidSplitTotal.selector, 9000)
        );
        splitter.createContent(CONTENT_ID, PRICE, CONTENT_HASH, r, s);
    }

    function test_RevertWhen_LengthMismatch() public {
        address[] memory r = new address[](2);
        uint16[] memory s = new uint16[](3);
        (r[0], r[1]) = (alice, bob);
        (s[0], s[1], s[2]) = (5000, 3000, 2000);

        vm.prank(creator);
        vm.expectRevert(
            abi.encodeWithSelector(CreatorSplitter.LengthMismatch.selector, 2, 3)
        );
        splitter.createContent(CONTENT_ID, PRICE, CONTENT_HASH, r, s);
    }

    function test_RevertWhen_DuplicateContentId() public {
        (address[] memory r, uint16[] memory s) = _threeWay();
        _register(CONTENT_ID, PRICE, r, s);

        vm.prank(creator);
        vm.expectRevert(
            abi.encodeWithSelector(CreatorSplitter.ContentAlreadyExists.selector, CONTENT_ID)
        );
        splitter.createContent(CONTENT_ID, PRICE, CONTENT_HASH, r, s);
    }

    function test_RevertWhen_EmptyRecipients() public {
        vm.prank(creator);
        vm.expectRevert(CreatorSplitter.EmptyRecipients.selector);
        splitter.createContent(
            CONTENT_ID,
            PRICE,
            CONTENT_HASH,
            new address[](0),
            new uint16[](0)
        );
    }

    function test_RevertWhen_PriceIsZero() public {
        (address[] memory r, uint16[] memory s) = _threeWay();

        vm.prank(creator);
        vm.expectRevert(CreatorSplitter.PriceMustBePositive.selector);
        splitter.createContent(CONTENT_ID, 0, CONTENT_HASH, r, s);
    }

    function test_RevertWhen_RecipientIsZeroAddress() public {
        address[] memory r = new address[](2);
        uint16[] memory s = new uint16[](2);
        (r[0], r[1]) = (alice, address(0));
        (s[0], s[1]) = (5000, 5000);

        vm.prank(creator);
        vm.expectRevert(CreatorSplitter.ZeroAddress.selector);
        splitter.createContent(CONTENT_ID, PRICE, CONTENT_HASH, r, s);
    }

    function test_RevertWhen_SplitIsZero() public {
        address[] memory r = new address[](2);
        uint16[] memory s = new uint16[](2);
        (r[0], r[1]) = (alice, bob);
        (s[0], s[1]) = (10000, 0);

        vm.prank(creator);
        vm.expectRevert(CreatorSplitter.ZeroSplit.selector);
        splitter.createContent(CONTENT_ID, PRICE, CONTENT_HASH, r, s);
    }

    /*//////////////////////////////////////////////////////////////
                          分账:核心语义
    //////////////////////////////////////////////////////////////*/

    function test_Pay_SplitsThreeWays() public {
        (address[] memory r, uint16[] memory s) = _threeWay();
        _register(CONTENT_ID, PRICE, r, s);

        _approveAndPay(buyer, CONTENT_ID, PRICE);

        assertEq(usdc.balanceOf(alice), (PRICE * 7000) / 10000, "70%");
        assertEq(usdc.balanceOf(bob), (PRICE * 2000) / 10000, "20%");
        assertEq(usdc.balanceOf(carol), (PRICE * 1000) / 10000, "10%");
        assertEq(usdc.balanceOf(address(splitter)), 0, "contract must not keep dust");
    }

    /**
     * 方案 §8.1 特别标注"容易漏"的一条:余数归**最后一个**收款人。
     *
     * 取 `amount = 101`、`splits = [7000, 2000, 1000]`:
     *   alice   = floor(101 * 7000 / 10000) = 70
     *   bob     = floor(101 * 2000 / 10000) = 20
     *   carol   = 101 - 90 = **11**(不是 10)
     * 不这样定,那 1 个单位就永远卡在合约里,`withdraw()` 也取不走。
     */
    function test_RemainderGoesToLastRecipient() public {
        (address[] memory r, uint16[] memory s) = _threeWay();
        _register(CONTENT_ID, 101, r, s); // 故意用除不尽的数

        _approveAndPay(buyer, CONTENT_ID, 101);

        assertEq(usdc.balanceOf(alice), 70);
        assertEq(usdc.balanceOf(bob), 20);
        assertEq(usdc.balanceOf(carol), 11, "last recipient absorbs the remainder");

        // 最关键的一条断言:支付金额恒等于分账之和
        uint256 sum = usdc.balanceOf(alice) + usdc.balanceOf(bob) + usdc.balanceOf(carol);
        assertEq(sum, 101, "sum of shares must equal amount paid");
        assertEq(usdc.balanceOf(address(splitter)), 0, "no dust left behind");
    }

    /// 把余数语义在多个价位上钉死 —— 只在 101 上对,说明可能碰巧。
    function testFuzz_SumOfSharesAlwaysEqualsAmount(uint96 amount) public {
        amount = uint96(bound(amount, 1, 1_000_000_000));
        (address[] memory r, uint16[] memory s) = _threeWay();
        _register(CONTENT_ID, amount, r, s);
        usdc.mint(buyer, amount);

        _approveAndPay(buyer, CONTENT_ID, amount);

        assertEq(
            usdc.balanceOf(alice) + usdc.balanceOf(bob) + usdc.balanceOf(carol),
            amount,
            "sum of shares must always equal amount paid"
        );
        assertEq(usdc.balanceOf(address(splitter)), 0, "no dust");
    }

    /// 两条事件都要发,且 `PaymentSplit` 在**前** —— 链下索引器依赖这个顺序。
    function test_Pay_EmitsSplitThenUnlock() public {
        (address[] memory r, uint16[] memory s) = _threeWay();
        _register(CONTENT_ID, PRICE, r, s);

        vm.recordLogs();
        _approveAndPay(buyer, CONTENT_ID, PRICE);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertEq(logs.length, 2, "exactly two events");
        assertEq(
            logs[0].topics[0],
            keccak256("PaymentSplit(bytes32,address,address[],uint256[])"),
            "PaymentSplit first"
        );
        assertEq(logs[1].topics[0], keccak256("ContentUnlocked(bytes32,address)"));
        assertEq(logs[0].topics[1], CONTENT_ID);
        assertEq(logs[1].topics[1], CONTENT_ID);
        assertEq(address(uint160(uint256(logs[1].topics[2]))), buyer, "payer is msg.sender");

        // 事件里带的金额要和实际到账一致 —— 链下靠它记账
        (address[] memory evRecipients, uint256[] memory evAmounts) =
            abi.decode(logs[0].data, (address[], uint256[]));
        assertEq(evRecipients.length, 3);
        assertEq(evAmounts[0], usdc.balanceOf(alice));
        assertEq(evAmounts[1], usdc.balanceOf(bob));
        assertEq(evAmounts[2], usdc.balanceOf(carol));

        assertTrue(splitter.purchases(CONTENT_ID, buyer));
    }

    function test_RevertWhen_AlreadyPurchased() public {
        (address[] memory r, uint16[] memory s) = _threeWay();
        _register(CONTENT_ID, PRICE, r, s);
        _approveAndPay(buyer, CONTENT_ID, PRICE);

        vm.startPrank(buyer);
        usdc.approve(address(splitter), PRICE);
        vm.expectRevert(
            abi.encodeWithSelector(
                CreatorSplitter.AlreadyPurchased.selector,
                CONTENT_ID,
                buyer
            )
        );
        splitter.pay(CONTENT_ID);
        vm.stopPrank();
    }

    /// v1 的漏洞 ②:`pay` 的 `payer` 参数可被伪造。现在它恒为 msg.sender。
    function test_Pay_PaysFromCallerNotFromArgument() public {
        (address[] memory r, uint16[] memory s) = _threeWay();
        _register(CONTENT_ID, PRICE, r, s);

        address other = makeAddr("other");
        usdc.mint(other, PRICE);

        _approveAndPay(other, CONTENT_ID, PRICE);

        assertEq(usdc.balanceOf(other), 0, "caller paid, not someone else");
        assertTrue(splitter.purchases(CONTENT_ID, other));
        assertFalse(splitter.purchases(CONTENT_ID, buyer), "buyer untouched");
    }

    function test_RevertWhen_NoApproval() public {
        (address[] memory r, uint16[] memory s) = _threeWay();
        _register(CONTENT_ID, PRICE, r, s);

        vm.prank(buyer);
        vm.expectRevert("USDC: insufficient allowance");
        splitter.pay(CONTENT_ID);
    }

    function test_RevertWhen_ContentNotFound() public {
        vm.prank(buyer);
        vm.expectRevert(
            abi.encodeWithSelector(CreatorSplitter.ContentNotFound.selector, CONTENT_ID)
        );
        splitter.pay(CONTENT_ID);
    }

    /*//////////////////////////////////////////////////////////////
                            上下架
    //////////////////////////////////////////////////////////////*/

    function test_SetContentActive_OnlyCreator() public {
        (address[] memory r, uint16[] memory s) = _threeWay();
        _register(CONTENT_ID, PRICE, r, s);

        vm.prank(buyer);
        vm.expectRevert(
            abi.encodeWithSelector(CreatorSplitter.NotCreator.selector, CONTENT_ID, buyer)
        );
        splitter.setContentActive(CONTENT_ID, false);

        vm.prank(creator);
        splitter.setContentActive(CONTENT_ID, false);

        (, , , , , bool active) = splitter.getContent(CONTENT_ID);
        assertFalse(active);
    }

    function test_RevertWhen_PayingInactiveContent() public {
        (address[] memory r, uint16[] memory s) = _threeWay();
        _register(CONTENT_ID, PRICE, r, s);

        vm.prank(creator);
        splitter.setContentActive(CONTENT_ID, false);

        vm.startPrank(buyer);
        usdc.approve(address(splitter), PRICE);
        vm.expectRevert(
            abi.encodeWithSelector(CreatorSplitter.ContentInactive.selector, CONTENT_ID)
        );
        splitter.pay(CONTENT_ID);
        vm.stopPrank();
    }

    /*//////////////////////////////////////////////////////////////
                    ⚠️ 收款失败 → 待提取余额(方案 §8.2)
    //////////////////////////////////////////////////////////////*/

    /**
     * ## 这条测试**证伪**了方案 §8.2 给出的理由
     *
     * §8.2 写:"任一收款方是**拒收合约**时,整笔支付会 revert,付款人被 DoS"。
     *
     * **这个说法对本合约不成立。** ERC-20 的 `transfer` 只是改余额,
     * **不调用收款方的任何代码** —— 没有 `receive`/`fallback`/钩子。
     * 所以一个"什么调用都 revert"的合约,**照样能收到 ERC-20**。
     *
     * 这条测试把该结论钉死:如果哪天有人"优化"掉了 escrow 分支、理由是
     * "防拒收合约",这个测试不会失败 —— **它证明的是那个理由本身是错的**。
     *
     * 真正的风险在下面 `test_Escrow_TokenPaused...` 那几条。
     */
    function test_ERC20_NoHook_RejectingContractStillGetsPaid() public {
        RejectingRecipient rejector = new RejectingRecipient();

        // 它连以太都拒收
        vm.deal(address(this), 1 ether);
        (bool ok, ) = address(rejector).call{value: 1 wei}("");
        assertFalse(ok, "rejecting contract does reject ETH");

        // 但 ERC-20 照收不误 —— 因为 transfer 根本不进它的代码
        address[] memory r = new address[](2);
        uint16[] memory s = new uint16[](2);
        (r[0], r[1]) = (address(rejector), bob);
        (s[0], s[1]) = (5000, 5000);

        _register(CONTENT_ID, PRICE, r, s);
        _approveAndPay(buyer, CONTENT_ID, PRICE);

        assertEq(
            usdc.balanceOf(address(rejector)),
            PRICE / 2,
            "ERC-20 transfer ignores the recipient's code entirely"
        );
        assertEq(splitter.pendingBalance(address(rejector)), 0, "no escrow needed");
    }

    /**
     * ## escrow 分支真实的触发条件:代币侧失败
     *
     * USDC 会失败的真实原因是 **Circle 拉黑**或**暂停**,不是收款方拒收。
     */
    function test_Escrow_BlacklistedRecipient_FundsGoToPendingBalance() public {
        (address[] memory r, uint16[] memory s) = _threeWay();
        _register(CONTENT_ID, PRICE, r, s);

        usdc.setBlacklisted(carol, true); // Circle 把 carol 拉黑了

        _approveAndPay(buyer, CONTENT_ID, PRICE);

        // 付款**照常成功** —— 这就是 escrow 的价值:付款人不会被收款方的问题拖累
        assertTrue(splitter.purchases(CONTENT_ID, buyer), "buyer still got the content");
        assertEq(usdc.balanceOf(alice), (PRICE * 7000) / 10000, "others unaffected");
        assertEq(usdc.balanceOf(bob), (PRICE * 2000) / 10000);

        uint256 expected = PRICE - (PRICE * 7000) / 10000 - (PRICE * 2000) / 10000;
        assertEq(splitter.pendingBalance(carol), expected, "carol's share is escrowed");
        assertEq(usdc.balanceOf(carol), 0);
    }

    /**
     * ⚠️ **escrow 的真实边界,必须如实知道**:
     * 被拉黑的收款人 `withdraw()` **也会失败** —— 因为同样的拉黑对转出也生效。
     * 钱不会丢(记在 `pendingBalance` 里),但**在被解封之前取不出来**。
     *
     * 解封后就能取 —— 见下一条。
     */
    function test_Escrow_BlacklistedRecipient_CannotWithdrawWhileBlacklisted() public {
        (address[] memory r, uint16[] memory s) = _threeWay();
        _register(CONTENT_ID, PRICE, r, s);
        usdc.setBlacklisted(carol, true);
        _approveAndPay(buyer, CONTENT_ID, PRICE);

        vm.prank(carol);
        vm.expectRevert("USDC: blacklisted");
        splitter.withdraw();

        // 余额没被吞掉,仍挂在账上
        assertGt(splitter.pendingBalance(carol), 0, "funds are recorded, not lost");
    }

    /// 解封后能取出来 —— 这才是 escrow 真正救回来的场景。
    function test_Escrow_WithdrawSucceedsAfterUnblacklist() public {
        (address[] memory r, uint16[] memory s) = _threeWay();
        _register(CONTENT_ID, PRICE, r, s);
        usdc.setBlacklisted(carol, true);
        _approveAndPay(buyer, CONTENT_ID, PRICE);

        uint256 escrowed = splitter.pendingBalance(carol);
        usdc.setBlacklisted(carol, false); // Circle 解封

        vm.prank(carol);
        splitter.withdraw();

        assertEq(usdc.balanceOf(carol), escrowed, "carol finally got her money");
        assertEq(splitter.pendingBalance(carol), 0, "balance cleared");
    }

    /**
     * ## escrow 最实在的价值场景:拉款成功、推送时代币被暂停
     *
     * 这个"夹缝时刻"是纯 push 方案真正的死穴 —— 钱已经在合约里了,
     * 推送却全数失败。没有 escrow 的话这笔交易直接 revert,
     * 而钱其实**已经扣了**。有 escrow,买家照样拿到内容,三方各记一笔待提取,
     * 代币恢复后各自取走。
     */
    function test_Escrow_TokenPausedDuringPush_WithdrawAfterResume() public {
        (address[] memory r, uint16[] memory s) = _threeWay();
        _register(CONTENT_ID, PRICE, r, s);

        // 扣款成功的那一瞬间,代币进入暂停
        usdc.setPauseAfterPull(true);
        _approveAndPay(buyer, CONTENT_ID, PRICE);

        uint256 shareAlice = (PRICE * 7000) / 10000;
        uint256 shareBob = (PRICE * 2000) / 10000;
        uint256 shareCarol = PRICE - shareAlice - shareBob;

        // 买家不受影响 —— 这才是关键
        assertTrue(splitter.purchases(CONTENT_ID, buyer), "buyer still unlocked the content");
        assertEq(usdc.balanceOf(address(splitter)), PRICE, "money sits in the contract");
        assertEq(usdc.balanceOf(alice), 0, "nothing pushed while paused");

        assertEq(splitter.pendingBalance(alice), shareAlice);
        assertEq(splitter.pendingBalance(bob), shareBob);
        assertEq(splitter.pendingBalance(carol), shareCarol);

        // 暂停期间谁也取不出来(如实记录:钱不会丢,但暂时动不了)
        vm.prank(alice);
        vm.expectRevert("USDC: paused");
        splitter.withdraw();

        // 代币恢复 → 三方各自取走,合约清零
        usdc.setPaused(false);

        vm.prank(alice);
        splitter.withdraw();
        vm.prank(bob);
        splitter.withdraw();
        vm.prank(carol);
        splitter.withdraw();

        assertEq(usdc.balanceOf(alice), shareAlice);
        assertEq(usdc.balanceOf(bob), shareBob);
        assertEq(usdc.balanceOf(carol), shareCarol, "remainder included");
        assertEq(usdc.balanceOf(address(splitter)), 0, "contract fully drained");
    }

    function test_Withdraw_RevertsWhenNothingToWithdraw() public {
        vm.prank(alice);
        vm.expectRevert(CreatorSplitter.NothingToWithdraw.selector);
        splitter.withdraw();
    }

    /*//////////////////////////////////////////////////////////////
                        重入:CEI 顺序
    //////////////////////////////////////////////////////////////*/

    /**
     * `pay()` 必须在**任何外部调用之前**落购买标记。
     *
     * 用一个会在 `transfer` 里回调 `pay()` 的恶意代币来验证:
     * 若 `purchases` 没有先行设置,重入会再分一次账,把合约里其他买家的钱掏空。
     */
    function test_Reentrancy_PurchaseFlagSetBeforeExternalCall() public {
        ReentrantUSDC evil = new ReentrantUSDC();
        CreatorSplitter s = new CreatorSplitter(address(evil));
        evil.setTarget(s, CONTENT_ID);

        address[] memory r = new address[](2);
        uint16[] memory s2 = new uint16[](2);
        (r[0], r[1]) = (alice, bob);
        (s2[0], s2[1]) = (5000, 5000);

        vm.prank(creator);
        s.createContent(CONTENT_ID, PRICE, CONTENT_HASH, r, s2);

        evil.mint(buyer, PRICE * 10);
        vm.startPrank(buyer);
        evil.approve(address(s), type(uint256).max);
        s.pay(CONTENT_ID);
        vm.stopPrank();

        // 重入被 AlreadyPurchased 挡掉,只分了一次账
        assertEq(evil.reentrancyAttempts(), 1, "reentry attempted");
        assertEq(evil.reentrancySucceeded(), 0, "but must have reverted");
        assertEq(
            evil.balanceOf(alice) + evil.balanceOf(bob),
            PRICE,
            "exactly one payment was split"
        );
    }
}

/*//////////////////////////////////////////////////////////////////
                        恶意代币(仅测试)
//////////////////////////////////////////////////////////////////*/

/// @dev 在 `transfer` 里回调 `pay()`,用来验证 CEI 顺序。
contract ReentrantUSDC {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    CreatorSplitter public target;
    bytes32 public contentId;
    bool public armed;

    uint256 public reentrancyAttempts;
    uint256 public reentrancySucceeded;

    function setTarget(CreatorSplitter t, bytes32 id_) external {
        target = t;
        contentId = id_;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;

        if (armed) {
            armed = false;
            reentrancyAttempts++;
            try target.pay(contentId) {
                reentrancySucceeded++;
            } catch {
                // 预期路径:AlreadyPurchased
            }
        }
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        armed = true; // 拉款之后的第一次 transfer 会尝试重入
        return true;
    }
}
