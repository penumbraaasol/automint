import { base, mainnet, robinhood } from 'viem/chains';

// OpenSea's chain identifiers -> viem chains + the env var holding a custom RPC.
export const CHAINS = {
  base:      { chain: base,      rpcEnv: 'BASE_RPC_URL' },
  ethereum:  { chain: mainnet,   rpcEnv: 'ETH_RPC_URL'  },
  robinhood: { chain: robinhood, rpcEnv: 'ROBINHOOD_RPC_URL' },
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
