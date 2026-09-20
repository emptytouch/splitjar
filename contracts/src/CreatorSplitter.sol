// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title CreatorSplitter
 * @notice 创作者付费内容 + 链上多方分账。
 *
 * 买家付一笔稳定币,合约按**基点比例**把钱**直达**各方钱包 —— 无平台抽成、无资金池。
 * 人类买家和 AI Agent 走的是**同一个** `pay()`(方案 §11)。
 *
 * ## 接口来源
 *
 * 完全按产品方案 §8.1 实现,接口已于 2026-09-21 冻结。
 *
 * ## 两处关键语义(方案 §8.1 / §8.2)
 *
 * 1. **余数归最后一个收款人。** `amount * split / 10000` 是整数除法会截断,
 *    所以前 N-1 个取 floor,最后一个取 `amount - 前面之和`。
 *    这样**支付金额恒等于分账之和**,合约不留灰尘。
 *
 * 2. **push 为主 + 失败转可提取余额。** 对每个收款方 `try transfer`;失败则记入
 *    `pendingBalance`,由其 `withdraw()` 领取。纯 push 的致命伤是:任一收款方是
 *    拒收合约时整笔支付 revert,**付款人被 DoS**。这约 30 行代码彻底消除该风险,
 *    同时保住"自动到账"的体验。
 *
 * ## 付款方式:`transferFrom`,买家需先 `approve`
 *
 * ⚠️ 这是**有意为之**,不是疏漏。方案 §8.1 的 `pay()` 不收签名参数,§11 明确
 * 「v2.1 全部改动都在 HTTP 层,合约层零改动」。
 *
 * 因此首次购买是**两笔交易**:`approve` → `pay()`。
 * `approve` 每个买家只需做一次(可授权一个大额度),之后每件内容都只花一笔。
 * 代价是这个两跳的 UX,收益是合约不引入 ERC-3009 的复杂度 —— 后者在 9 天里
 * 风险过高(方案 §9.4 路径 C 的结论)。
 */
contract CreatorSplitter {
    /*//////////////////////////////////////////////////////////////
                                 常量
    //////////////////////////////////////////////////////////////*/

    /// @dev 基点分母。10000 = 100%,故 7000 = 70%。
    uint16 private constant BPS_DENOMINATOR = 10000;

    /*//////////////////////////////////////////////////////////////
                                 类型
    //////////////////////////////////////////////////////////////*/

    struct Content {
        address creator;
        uint256 price; // USDC,6 位小数(0.1 USDC = 100000)
        bytes32 contentHash; // 内容文件的 keccak256,仅存证,不参与门禁
        address[] recipients;
        uint16[] splits; // 基点,合计恒为 10000
        bool active;
        bool exists; // 区分"不存在"与"存在但字段全零"
    }

    /*//////////////////////////////////////////////////////////////
                                状态
    //////////////////////////////////////////////////////////////*/

    /// @notice 结算用的稳定币(Fuji USDC,6 位小数)
    IERC20 public immutable usdc;

    mapping(bytes32 => Content) private _contents;

    /// @notice contentId => 买家 => 是否已购买
    mapping(bytes32 => mapping(address => bool)) public purchases;

    /// @notice 收款方因转账失败而暂存的余额,可自行 `withdraw()`
    mapping(address => uint256) public pendingBalance;

    /*//////////////////////////////////////////////////////////////
                                事件(方案 §8.4)
    //////////////////////////////////////////////////////////////*/

    event ContentRegistered(
        bytes32 indexed contentId,
        address indexed creator,
        bytes32 contentHash,
        uint256 price
    );
    event PaymentSplit(
        bytes32 indexed contentId,
        address indexed payer,
        address[] recipients,
        uint256[] amounts
    );
    event ContentUnlocked(bytes32 indexed contentId, address indexed payer);

    /// @dev 转入待提取余额时触发。没有它,链下无法还原"这笔钱到底到账没有"。
    event TransferFailed(address indexed recipient, uint256 amount);

    event Withdrawn(address indexed recipient, uint256 amount);
    event ContentActiveChanged(bytes32 indexed contentId, bool active);

    /*//////////////////////////////////////////////////////////////
                                错误
    //////////////////////////////////////////////////////////////*/

    error ContentAlreadyExists(bytes32 contentId);
    error ContentNotFound(bytes32 contentId);
    error ContentInactive(bytes32 contentId);
    error AlreadyPurchased(bytes32 contentId, address payer);
    error NotCreator(bytes32 contentId, address caller);

    error EmptyRecipients();
    error LengthMismatch(uint256 recipientsLength, uint256 splitsLength);
    error ZeroAddress();
    error ZeroSplit();
    error InvalidSplitTotal(uint256 total);
    error PriceMustBePositive();

    error PaymentFailed();
    error NothingToWithdraw();
    error WithdrawFailed();

    /*//////////////////////////////////////////////////////////////
                                构造
    //////////////////////////////////////////////////////////////*/

    /// @param usdc_ 结算币地址。Fuji USDC 从 viem 注册表取,代码里不手写。
    constructor(address usdc_) {
        if (usdc_ == address(0)) revert ZeroAddress();
        usdc = IERC20(usdc_);
    }

    /*//////////////////////////////////////////////////////////////
                              创作者操作
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice 登记一件付费内容。
     *
     * `creator` **恒为 msg.sender**,不接受外部传入 —— v1 的伪造漏洞就出在这里。
     *
     * @param contentId   前端生成的随机 bytes32。不派生自标题/时间:派生规则会让
     *                    前端(W3)与 Agent(W7)有分叉风险。合约靠"重复即 revert"保证唯一。
     * @param price       USDC,6 位小数。
     * @param contentHash 内容文件的 keccak256,仅存证。
     * @param recipients  收款方,非空、无零地址。
     * @param splits      基点,每项 > 0,合计必须 == 10000。
     */
    function createContent(
        bytes32 contentId,
        uint256 price,
        bytes32 contentHash,
        address[] calldata recipients,
        uint16[] calldata splits
    ) external {
        if (_contents[contentId].exists) revert ContentAlreadyExists(contentId);
        if (price == 0) revert PriceMustBePositive();

        uint256 n = recipients.length;
        if (n == 0) revert EmptyRecipients();
        if (n != splits.length) revert LengthMismatch(n, splits.length);

        uint256 total;
        for (uint256 i; i < n; ++i) {
            if (recipients[i] == address(0)) revert ZeroAddress();
            if (splits[i] == 0) revert ZeroSplit();
            total += splits[i];
        }
        if (total != BPS_DENOMINATOR) revert InvalidSplitTotal(total);

        Content storage c = _contents[contentId];
        c.creator = msg.sender;
        c.price = price;
        c.contentHash = contentHash;
        c.recipients = recipients;
        c.splits = splits;
        c.active = true;
        c.exists = true;

        emit ContentRegistered(contentId, msg.sender, contentHash, price);
    }

    /// @notice 上下架。仅 creator 可调。
    function setContentActive(bytes32 contentId, bool active) external {
        Content storage c = _contents[contentId];
        if (!c.exists) revert ContentNotFound(contentId);
        if (c.creator != msg.sender) revert NotCreator(contentId, msg.sender);

        c.active = active;
        emit ContentActiveChanged(contentId, active);
    }

    /// @notice 领取"待提取余额"(收款方拒收时暂存在合约里的钱)。
    function withdraw() external {
        uint256 amount = pendingBalance[msg.sender];
        if (amount == 0) revert NothingToWithdraw();

        // checks-effects-interactions:先清零再转账,防重入重复提取
        pendingBalance[msg.sender] = 0;

        if (!usdc.transfer(msg.sender, amount)) revert WithdrawFailed();
        emit Withdrawn(msg.sender, amount);
    }

    /*//////////////////////////////////////////////////////////////
                                买家操作
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice 购买一件内容,当场按比例分账。
     *
     * `payer` **恒为 msg.sender** —— v1 的第二个伪造漏洞就出在这里。
     *
     * 需要事先对合约 `approve` 足额 USDC(首次购买是两笔交易,见合约头部说明)。
     */
    function pay(bytes32 contentId) external {
        Content storage c = _contents[contentId];
        if (!c.exists) revert ContentNotFound(contentId);
        if (!c.active) revert ContentInactive(contentId);
        if (purchases[contentId][msg.sender]) revert AlreadyPurchased(contentId, msg.sender);

        // effects 先于 interactions —— 必须先落购买标记,否则收款方合约可重入重复分账
        purchases[contentId][msg.sender] = true;

        uint256 amount = c.price;

        // 先把买家的钱拉进来。失败则整笔 revert(这是买家的问题,不该由合约兜底)
        if (!usdc.transferFrom(msg.sender, address(this), amount)) revert PaymentFailed();

        uint256 n = c.recipients.length;
        uint256 distributed;

        address[] memory recipients = new address[](n);
        uint256[] memory amounts = new uint256[](n);

        for (uint256 i; i < n; ++i) {
            // 余数归最后一个收款人 —— 保证 distributed 最终恰好等于 amount,合约不留灰尘
            uint256 share = i == n - 1
                ? amount - distributed
                : (amount * c.splits[i]) / BPS_DENOMINATOR;

            distributed += share;
            recipients[i] = c.recipients[i];
            amounts[i] = share;

            _push(c.recipients[i], share);
        }

        emit PaymentSplit(contentId, msg.sender, recipients, amounts);
        emit ContentUnlocked(contentId, msg.sender);
    }

    /*//////////////////////////////////////////////////////////////
                                读取
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice 读一件内容的完整信息。
     *
     * ⚠️ 这是 §8.1 冻结清单**之外**的新增函数,但它是 view,不改任何写入接口的语义。
     * 必须要有:struct 里有动态数组,Solidity 不会为 public mapping 生成可用的 getter,
     * 前端没有它就读不到价格和分账比例。
     */
    function getContent(bytes32 contentId)
        external
        view
        returns (
            address creator,
            uint256 price,
            bytes32 contentHash,
            address[] memory recipients,
            uint16[] memory splits,
            bool active
        )
    {
        Content storage c = _contents[contentId];
        if (!c.exists) revert ContentNotFound(contentId);

        return (c.creator, c.price, c.contentHash, c.recipients, c.splits, c.active);
    }

    /// @notice 内容是否已登记
    function contentExists(bytes32 contentId) external view returns (bool) {
        return _contents[contentId].exists;
    }

    /*//////////////////////////////////////////////////////////////
                                内部
    //////////////////////////////////////////////////////////////*/

    /**
     * @dev 推一笔钱给收款方。**失败不 revert,转记待提取余额。**
     *
     * 用 try/catch 覆盖两种失败形态:
     *   - 收款方是**拒收合约**(receive/fallback revert)→ catch
     *   - USDC 本身拒绝(如收款方被 Circle 拉黑)→ transfer 返回 false
     *
     * 两种都走 escrow,付款人不会因为收款方的问题而交易失败。
     */
    function _push(address recipient, uint256 amount) private {
        if (amount == 0) return;

        bool ok;
        try usdc.transfer(recipient, amount) returns (bool success) {
            ok = success;
        } catch {
            ok = false;
        }

        if (!ok) {
            pendingBalance[recipient] += amount;
            emit TransferFailed(recipient, amount);
        }
    }
}

/// @dev 只用到这两个方法,自带最小接口,不引入 OpenZeppelin(少一个依赖少一处风险)。
interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);

    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}
