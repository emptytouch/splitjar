/**
 * CreatorSplitter 的 ABI —— **自动生成,请勿手改**。
 *
 * 重新生成:
 * ```bash
 * cd contracts && node script/export-abi.mjs
 * ```
 *
 * 来源:`contracts/src/CreatorSplitter.sol`(方案 §8.1 冻结的接口)
 *
 * ⚠️ 为什么是 .ts 而不是 .json —— 见 `contracts/script/export-abi.mjs` 的文件头。
 * 简单说:JSON 导入会把 `type: "function"` 放宽成 `string`,viem 就推不出签名,
 * 于是**写的参数不受任何检查**。付款应用不能接受这个。
 */
export const creatorSplitterAbi = [
    {
      "type": "constructor",
      "inputs": [
        {
          "name": "usdc_",
          "type": "address",
          "internalType": "address"
        }
      ],
      "stateMutability": "nonpayable"
    },
    {
      "type": "function",
      "name": "contentExists",
      "inputs": [
        {
          "name": "contentId",
          "type": "bytes32",
          "internalType": "bytes32"
        }
      ],
      "outputs": [
        {
          "name": "",
          "type": "bool",
          "internalType": "bool"
        }
      ],
      "stateMutability": "view"
    },
    {
      "type": "function",
      "name": "createContent",
      "inputs": [
        {
          "name": "contentId",
          "type": "bytes32",
          "internalType": "bytes32"
        },
        {
          "name": "price",
          "type": "uint256",
          "internalType": "uint256"
        },
        {
          "name": "contentHash",
          "type": "bytes32",
          "internalType": "bytes32"
        },
        {
          "name": "recipients",
          "type": "address[]",
          "internalType": "address[]"
        },
        {
          "name": "splits",
          "type": "uint16[]",
          "internalType": "uint16[]"
        }
      ],
      "outputs": [],
      "stateMutability": "nonpayable"
    },
    {
      "type": "function",
      "name": "getContent",
      "inputs": [
        {
          "name": "contentId",
          "type": "bytes32",
          "internalType": "bytes32"
        }
      ],
      "outputs": [
        {
          "name": "creator",
          "type": "address",
          "internalType": "address"
        },
        {
          "name": "price",
          "type": "uint256",
          "internalType": "uint256"
        },
        {
          "name": "contentHash",
          "type": "bytes32",
          "internalType": "bytes32"
        },
        {
          "name": "recipients",
          "type": "address[]",
          "internalType": "address[]"
        },
        {
          "name": "splits",
          "type": "uint16[]",
          "internalType": "uint16[]"
        },
        {
          "name": "active",
          "type": "bool",
          "internalType": "bool"
        }
      ],
      "stateMutability": "view"
    },
    {
      "type": "function",
      "name": "pay",
      "inputs": [
        {
          "name": "contentId",
          "type": "bytes32",
          "internalType": "bytes32"
        }
      ],
      "outputs": [],
      "stateMutability": "nonpayable"
    },
    {
      "type": "function",
      "name": "pendingBalance",
      "inputs": [
        {
          "name": "",
          "type": "address",
          "internalType": "address"
        }
      ],
      "outputs": [
        {
          "name": "",
          "type": "uint256",
          "internalType": "uint256"
        }
      ],
      "stateMutability": "view"
    },
    {
      "type": "function",
      "name": "purchases",
      "inputs": [
        {
          "name": "",
          "type": "bytes32",
          "internalType": "bytes32"
        },
        {
          "name": "",
          "type": "address",
          "internalType": "address"
        }
      ],
      "outputs": [
        {
          "name": "",
          "type": "bool",
          "internalType": "bool"
        }
      ],
      "stateMutability": "view"
    },
    {
      "type": "function",
      "name": "setContentActive",
      "inputs": [
        {
          "name": "contentId",
          "type": "bytes32",
          "internalType": "bytes32"
        },
        {
          "name": "active",
          "type": "bool",
          "internalType": "bool"
        }
      ],
      "outputs": [],
      "stateMutability": "nonpayable"
    },
    {
      "type": "function",
      "name": "usdc",
      "inputs": [],
      "outputs": [
        {
          "name": "",
          "type": "address",
          "internalType": "contract IERC20"
        }
      ],
      "stateMutability": "view"
    },
    {
      "type": "function",
      "name": "withdraw",
      "inputs": [],
      "outputs": [],
      "stateMutability": "nonpayable"
    },
    {
      "type": "event",
      "name": "ContentActiveChanged",
      "inputs": [
        {
          "name": "contentId",
          "type": "bytes32",
          "indexed": true,
          "internalType": "bytes32"
        },
        {
          "name": "active",
          "type": "bool",
          "indexed": false,
          "internalType": "bool"
        }
      ],
      "anonymous": false
    },
    {
      "type": "event",
      "name": "ContentRegistered",
      "inputs": [
        {
          "name": "contentId",
          "type": "bytes32",
          "indexed": true,
          "internalType": "bytes32"
        },
        {
          "name": "creator",
          "type": "address",
          "indexed": true,
          "internalType": "address"
        },
        {
          "name": "contentHash",
          "type": "bytes32",
          "indexed": false,
          "internalType": "bytes32"
        },
        {
          "name": "price",
          "type": "uint256",
          "indexed": false,
          "internalType": "uint256"
        }
      ],
      "anonymous": false
    },
    {
      "type": "event",
      "name": "ContentUnlocked",
      "inputs": [
        {
          "name": "contentId",
          "type": "bytes32",
          "indexed": true,
          "internalType": "bytes32"
        },
        {
          "name": "payer",
          "type": "address",
          "indexed": true,
          "internalType": "address"
        }
      ],
      "anonymous": false
    },
    {
      "type": "event",
      "name": "PaymentSplit",
      "inputs": [
        {
          "name": "contentId",
          "type": "bytes32",
          "indexed": true,
          "internalType": "bytes32"
        },
        {
          "name": "payer",
          "type": "address",
          "indexed": true,
          "internalType": "address"
        },
        {
          "name": "recipients",
          "type": "address[]",
          "indexed": false,
          "internalType": "address[]"
        },
        {
          "name": "amounts",
          "type": "uint256[]",
          "indexed": false,
          "internalType": "uint256[]"
        }
      ],
      "anonymous": false
    },
    {
      "type": "event",
      "name": "TransferFailed",
      "inputs": [
        {
          "name": "recipient",
          "type": "address",
          "indexed": true,
          "internalType": "address"
        },
        {
          "name": "amount",
          "type": "uint256",
          "indexed": false,
          "internalType": "uint256"
        }
      ],
      "anonymous": false
    },
    {
      "type": "event",
      "name": "Withdrawn",
      "inputs": [
        {
          "name": "recipient",
          "type": "address",
          "indexed": true,
          "internalType": "address"
        },
        {
          "name": "amount",
          "type": "uint256",
          "indexed": false,
          "internalType": "uint256"
        }
      ],
      "anonymous": false
    },
    {
      "type": "error",
      "name": "AlreadyPurchased",
      "inputs": [
        {
          "name": "contentId",
          "type": "bytes32",
          "internalType": "bytes32"
        },
        {
          "name": "payer",
          "type": "address",
          "internalType": "address"
        }
      ]
    },
    {
      "type": "error",
      "name": "ContentAlreadyExists",
      "inputs": [
        {
          "name": "contentId",
          "type": "bytes32",
          "internalType": "bytes32"
        }
      ]
    },
    {
      "type": "error",
      "name": "ContentInactive",
      "inputs": [
        {
          "name": "contentId",
          "type": "bytes32",
          "internalType": "bytes32"
        }
      ]
    },
    {
      "type": "error",
      "name": "ContentNotFound",
      "inputs": [
        {
          "name": "contentId",
          "type": "bytes32",
          "internalType": "bytes32"
        }
      ]
    },
    {
      "type": "error",
      "name": "EmptyRecipients",
      "inputs": []
    },
    {
      "type": "error",
      "name": "InvalidSplitTotal",
      "inputs": [
        {
          "name": "total",
          "type": "uint256",
          "internalType": "uint256"
        }
      ]
    },
    {
      "type": "error",
      "name": "LengthMismatch",
      "inputs": [
        {
          "name": "recipientsLength",
          "type": "uint256",
          "internalType": "uint256"
        },
        {
          "name": "splitsLength",
          "type": "uint256",
          "internalType": "uint256"
        }
      ]
    },
    {
      "type": "error",
      "name": "NotCreator",
      "inputs": [
        {
          "name": "contentId",
          "type": "bytes32",
          "internalType": "bytes32"
        },
        {
          "name": "caller",
          "type": "address",
          "internalType": "address"
        }
      ]
    },
    {
      "type": "error",
      "name": "NothingToWithdraw",
      "inputs": []
    },
    {
      "type": "error",
      "name": "PaymentFailed",
      "inputs": []
    },
    {
      "type": "error",
      "name": "PriceMustBePositive",
      "inputs": []
    },
    {
      "type": "error",
      "name": "WithdrawFailed",
      "inputs": []
    },
    {
      "type": "error",
      "name": "ZeroAddress",
      "inputs": []
    },
    {
      "type": "error",
      "name": "ZeroSplit",
      "inputs": []
    }
  ] as const
