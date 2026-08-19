import { encodeFunctionData, concatHex } from 'viem';

/** SeaDrop v1, deployed at the same address on every supported chain. */
export const SEADROP_V1 = '0x00005ea00ac477b1030ce78506496e8c2de24bf5';

/**
 * 4 attribution bytes OpenSea appends past the ABI-encoded args. SeaDrop
 * ignores trailing calldata, so this is cosmetic -- but including it makes our
 * calldata byte-identical to OpenSea's, which is what lets us diff the two.
 */
export const OS_ATTRIBUTION_TAG = '0x3d958fe2';


/**
 * SeaDrop custom errors. Without these in the ABI a revert decodes to a raw
 * selector; with them the simulator can say *why* a mint would fail, which is
 * the difference between "retry later" and "give up".
 */
const SEADROP_ERRORS = [
  ['NotActive', ['uint256', 'uint256', 'uint256']],
  ['MintQuantityExceedsMaxMintedPerWallet', ['uint256', 'uint256']],
  ['MintQuantityExceedsMaxSupply', ['uint256', 'uint256']],
  ['MintQuantityExceedsMaxTokenSupplyForStage', ['uint256', 'uint256']],
  ['IncorrectPayment', ['uint256', 'uint256']],
  ['MintQuantityCannotBeZero', []],
  ['FeeRecipientNotAllowed', []],
  ['FeeRecipientCannotBeZeroAddress', []],
  ['PayerNotAllowed', ['address']],
  ['InvalidProof', []],
  ['SignerNotPresent', ['address', 'address']],
  ['InvalidSignature', ['address']],
].map(([name, types]) => ({
  type: 'error',
  name,
  inputs: types.map((t, i) => ({ name: `arg${i}`, type: t })),
}));

/** Human-readable guidance per error -- what the operator should actually do. */
export const ERROR_HINTS = {
  NotActive: 'public stage is not open right now',
  MintQuantityExceedsMaxMintedPerWallet: 'wallet is at or over its per-wallet cap',
  MintQuantityExceedsMaxSupply: 'not enough supply left',
  MintQuantityExceedsMaxTokenSupplyForStage: 'stage allocation exhausted',
  IncorrectPayment: 'value sent does not match the onchain price',
  FeeRecipientNotAllowed: 'fee recipient is not on the contract allowlist',
  PayerNotAllowed: 'this payer is not permitted to mint on behalf of the minter',
  InvalidProof: 'allowlist stage -- a valid merkle proof is required',
  SignerNotPresent: 'signed presale stage -- a server signature is required',
};

export const SEADROP_ABI = [
  {
    type: 'function',
    name: 'mintPublic',
    stateMutability: 'payable',
    inputs: [
      { name: 'nftContract', type: 'address' },
      { name: 'feeRecipient', type: 'address' },
      { name: 'minterIfNotPayer', type: 'address' },
      { name: 'quantity', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'getPublicDrop',
    stateMutability: 'view',
    inputs: [{ name: 'nftContract', type: 'address' }],
    outputs: [
      {
        type: 'tuple',
        components: [
          { name: 'mintPrice', type: 'uint80' },
          { name: 'startTime', type: 'uint48' },
          { name: 'endTime', type: 'uint48' },
          { name: 'maxTotalMintableByWallet', type: 'uint16' },
          { name: 'feeBps', type: 'uint16' },
          { name: 'restrictFeeRecipients', type: 'bool' },
        ],
      },
    ],
  },
  {
    type: 'function',
    name: 'getAllowedFeeRecipients',
    stateMutability: 'view',
    inputs: [{ name: 'nftContract', type: 'address' }],
    outputs: [{ type: 'address[]' }],
  },
  ...SEADROP_ERRORS,
];

/**
 * Read the public stage straight from the contract. This is the authoritative
 * trigger source -- OpenSea's stage data can lag, the chain cannot.
 */
export async function readPublicDrop(client, nftContract) {
  return client.readContract({
    address: SEADROP_V1,
    abi: SEADROP_ABI,
    functionName: 'getPublicDrop',
    args: [nftContract],
  });
}

export async function readFeeRecipients(client, nftContract) {
  return client.readContract({
    address: SEADROP_V1,
    abi: SEADROP_ABI,
    functionName: 'getAllowedFeeRecipients',
    args: [nftContract],
  });
}

/** Build mint calldata locally -- no API call, so it works before a stage opens. */
export function buildMintCalldata({ nftContract, feeRecipient, minter, quantity, attribute = true }) {
  const data = encodeFunctionData({
    abi: SEADROP_ABI,
    functionName: 'mintPublic',
    args: [nftContract, feeRecipient, minter, BigInt(quantity)],
  });
  return attribute ? concatHex([data, OS_ATTRIBUTION_TAG]) : data;
}
