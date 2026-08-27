import { base, mainnet, robinhood, shape, apeChain, avalanche } from 'viem/chains';

/**
 * OpenSea's chain identifiers -> viem chains + the env var holding a custom RPC.
 *
 * A chain is supportable when two things hold: viem ships a definition for it,
 * and SeaDrop v1 is deployed there at the canonical address. SeaDrop is
 * deployed via CREATE2, so it lands on the same address on every chain it
 * reaches -- verified as identical 21,081-byte bytecode on all six below.
 *
 * Present in OpenSea's feeds but NOT supported:
 *   megaeth -- SeaDrop is not deployed there, so there is nothing to call.
 */
export const CHAINS = {
  ethereum:  { chain: mainnet,   rpcEnv: 'ETH_RPC_URL' },
  base:      { chain: base,      rpcEnv: 'BASE_RPC_URL' },
  robinhood: { chain: robinhood, rpcEnv: 'ROBINHOOD_RPC_URL' },
  shape:     { chain: shape,     rpcEnv: 'SHAPE_RPC_URL' },
  ape_chain: { chain: apeChain,  rpcEnv: 'APECHAIN_RPC_URL' },
  avalanche: { chain: avalanche, rpcEnv: 'AVALANCHE_RPC_URL' },
};

export function resolveChain(name) {
  const entry = CHAINS[name];
  if (!entry) {
    throw new Error(
      `Unsupported chain "${name}". Supported: ${Object.keys(CHAINS).join(', ')}`
    );
  }
  return entry;
}

/**
 * Native currency symbol for a chain.
 *
 * Not every supported chain pays in ETH -- Avalanche is AVAX, ApeChain is APE.
 * Amounts are still 18-decimal, so formatEther is correct arithmetically; only
 * the label differs. Printing "ETH" on an APE-denominated mint would misstate
 * the cost to the operator.
 */
export function nativeSymbol(name) {
  return CHAINS[name]?.chain.nativeCurrency?.symbol ?? 'ETH';
}
