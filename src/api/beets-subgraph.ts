import axios from "axios";
import "dotenv/config";

const API_KEY = process.env.SUBGRAPH_API_KEY;

const balancerSubgraphUrl = {
  v2: `https://gateway-arbitrum.network.thegraph.com/api/${API_KEY}/subgraphs/id/wwazpiPPt5oJMiTNnQ2VjVxKnKakGDuE2FfEZPD4TKj`,
  v3: `https://gateway-arbitrum.network.thegraph.com/api/${API_KEY}/subgraphs/id/8dRsm8mbA77DwEhVQVgzKmmYByjcbZoyXkafDbD5TuHq`,
};


const balancerV2Client = axios.create({
  baseURL: balancerSubgraphUrl.v2,
  headers: {
    "Content-Type": "application/json",
  },
});

const balancerV3Client = axios.create({
  baseURL: balancerSubgraphUrl.v3,
  headers: {
    "Content-Type": "application/json",
  },
});

async function getUserLiquidityInfoV2(
  userAddress: string,
  poolId: string
): Promise<LiquidityInfo> {

  const subgraphQuery = `
  {
    poolShares(where: {
      userAddress: "${userAddress.toLowerCase()}",
      poolId_contains: "${poolId}"
    }) {
      id
      balance
      poolId {
        id
        address
        totalLiquidity
        totalLiquiditySansBPT
        totalShares
        tokens {
          address
          symbol
          name
          balance
          decimals
        }
      }
    }

    joinExits(where: {
      user: "${userAddress.toLowerCase()}",
      pool_contains: "${poolId}",
      type: "Join"
    }, orderBy: timestamp, orderDirection: asc, first: 1) {
      id                 
      timestamp          
      type              
      amounts           
      valueUSD
      block
      pool {
        id
        tokens {
          address
          symbol
          name
          decimals
        }
      }     
    }
  }
  `;

  const response = await balancerV2Client.post("", { query: subgraphQuery });


  if (response.data.errors) {
    console.error("GraphQL errors:", response.data.errors);
    throw new Error(
      "GraphQL query failed: " + JSON.stringify(response.data.errors)
    );
  }

  if (!response.data.data) {
    console.error("No data returned from the GraphQL query");
    throw new Error("No data returned from the GraphQL query");
  }
  return {
    poolShares: response.data.data.poolShares.map((share: any) => ({
      id: share.id,
      balance: share.balance,
      pool: {
        id: share.poolId.id,
        address: share.poolId.address,
        totalShares: share.poolId.totalShares,
        totalLiquidity: share.poolId.totalLiquidity,
        tokens: share.poolId.tokens
      }
    })),
    deposits: response.data.data.joinExits.map((join: any) => ({
      id: join.id,
      timestamp: join.timestamp,
      amounts: join.amounts,
      valueUSD: join.valueUSD,
      blockNumber: join.block,
      pool: join.pool
    }))
  };

}


// Balancer V3 doesn't index swaps
export async function getPoolSwapsV2(
  poolId: string,
  positionStartTimestamp: number
): Promise<any> {
  const subgraphQuery = `
{
    swaps(
      where: {
        poolId_contains: "${poolId}"
        timestamp_gte: ${positionStartTimestamp}
      }
      first: 1000
      orderBy: timestamp
      orderDirection: desc
    ) {
      id
      poolId {
        id
        address
      }
      tokenIn
      tokenOut
      tokenInSym
      tokenOutSym
      tokenAmountIn
      tokenAmountOut
      valueUSD
      timestamp
      block
      userAddress
      caller
    }
  }
  `;

  const response = await balancerV2Client.post("", { query: subgraphQuery });
  if (response.data.errors) {
    console.error("GraphQL errors:", response.data.errors);
    throw new Error(
      "GraphQL query failed: " + JSON.stringify(response.data.errors)
    );
  }

  if (!response.data.data) {
    console.error("No data returned from the GraphQL query");
    throw new Error("No data returned from the GraphQL query");
  }
  return response.data.data;
}

async function getUserLiquidityInfoV3(
  userAddress: string,
  poolId: string
): Promise<LiquidityInfo> {
  const subgraphQuery = `
  {
  poolShares(where: {
    user: "${userAddress.toLowerCase()}",
    pool: "${poolId}"
  }) {
    id
    balance
    pool {
      id
      address
      totalShares
      tokens {
        address
        symbol
        name
        balance 
        decimals
      }
    }
  }

  addRemoves(where: {
    user: "${userAddress.toLowerCase()}",
    pool: "${poolId}",
    type: "Add"
  }, orderBy: blockTimestamp, orderDirection: asc, first: 1) {
    id
    blockTimestamp
    type
    amounts
    blockNumber
    pool {
      id
      tokens {
        address
        symbol
        name
        decimals
      }
    }
  }
}
  `;

  const response = await balancerV3Client.post("", { query: subgraphQuery });

  if (response.data.errors) {
    console.error("GraphQL errors:", response.data.errors);
    throw new Error(
      "GraphQL query failed: " + JSON.stringify(response.data.errors)
    );
  }

  if (!response.data.data) {
    console.error("No data returned from the GraphQL query");
    throw new Error("No data returned from the GraphQL query");
  }

  const calculateTotalLiquidity = (tokens: any[], rateProviders: any[]): string => {
    const totalLiquidity = tokens.reduce((sum, token) => {
      const balance = parseFloat(token.balance);
      
      // Find rate provider for this token (for yield-bearing tokens like Avalon)
      const rateProvider = rateProviders?.find(rp => 
        rp.token.toLowerCase() === token.address.toLowerCase()
      );
      
      // Apply rate if available (converts wrapped token balance to underlying value)
      const rate = rateProvider ? parseFloat(rateProvider.rate) : 1;
      const adjustedBalance = balance / Math.pow(10, token.decimals);
      
      return sum + (adjustedBalance * rate);
    }, 0);
    
    return totalLiquidity.toString();
  };

 return {
    poolShares: response.data.data.poolShares.map((share: any) => ({
      id: share.id,
      balance: share.balance,
      pool: {
        id: share.pool.id,
        address: share.pool.address,
        totalShares: share.pool.totalShares,
        totalLiquidity: calculateTotalLiquidity(share.pool.tokens, share.pool.rateProviders),
        tokens: share.pool.tokens
      }
    })),
    deposits: response.data.data.addRemoves.map((add: any) => ({
      id: add.id,
      timestamp: parseInt(add.blockTimestamp),
      amounts: add.amounts,
      valueUSD: undefined, // V3 doesn't provide this
      blockNumber: add.blockNumber,
      pool: add.pool
    }))
  };
}

export async function getTokenPrices(
  poolId: string,
  blockNumber: number
): Promise<any> {
  const subgraphQuery = `
  {
    tokenPrices (where: {block_gt: "${blockNumber - 20}", block_lt: "${blockNumber + 20}", asset: "0xbb30e76d9bb2cc9631f7fc5eb8e87b5aff32bfbd"}) {
      amount
      asset
      id
      price
      block
      timestamp
    }
  }  
  `;

  const response = await balancerV3Client.post("", { query: subgraphQuery });
  if (response.data.errors) {
    console.error("GraphQL errors:", response.data.errors);
    throw new Error(
      "GraphQL query failed: " + JSON.stringify(response.data.errors)
    );
  }

  if (!response.data.data) {
    console.error("No data returned from the GraphQL query");
    throw new Error("No data returned from the GraphQL query");
  }
  return response.data.data.tokenPrices;
}

export async function getUserPoolShares(
  userAddress: string,
  poolId: string
): Promise<any> {
  const subgraphQuery = `
  {
    user(id: "${userAddress.toLowerCase()}") {
      id
      userInternalBalances {
        balance
        id
        token
        tokenInfo {
          address
          decimals
          name
          symbol
          totalBalanceNotional
          totalBalanceUSD
          totalSwapCount
          totalVolumeNotional
          totalVolumeUSD
        }
      }
      sharesOwned {
        id
        poolId {
          id
          address
          totalLiquidity
          totalShares
          tokens {
            address
            symbol
            name
            balance
            decimals
          }
        }
        balance
        
      }
    }
  }
  `;

  const response = await balancerV2Client.post("", { query: subgraphQuery });

  if (response.data.errors) {
    console.error("GraphQL errors:", response.data.errors);
    throw new Error(
      "GraphQL query failed: " + JSON.stringify(response.data.errors)
    );
  }

  if (!response.data.data || !response.data.data.user) {
    console.log("No user data found");
    return [];
  }

  return response.data.data.user.sharesOwned;
}

export async function getUserLiquidityInfo(
  userAddress: string,
  poolId: string,
  balancerVersion: number
): Promise<LiquidityInfo> {
  if (balancerVersion === 2) {
    return await getUserLiquidityInfoV2(userAddress, poolId);
  }
  return await getUserLiquidityInfoV3(userAddress, poolId);
}


interface LiquidityInfo {
  poolShares: {
    id: string;
    balance: string;
    pool: {
      id: string;
      address: string;
      totalLiquidity: string;
      totalShares: string;
      tokens: Array<{
        address: string;
        symbol: string;
        name: string;
        balance: string;
        decimals: number;
      }>;
    };
  }[];
  deposits: {
    id: string;
    timestamp: number;
    amounts: string[];
    valueUSD?: string; // Optional since v3 doesn't have it
    blockNumber: string;
    pool: {
      id: string;
      tokens: Array<{
        address: string;
        symbol: string;
        name: string;
        decimals: number;
      }>;
    };
  }[];
}


