import { ethers } from "ethers";
import moment from "moment";
import { PortfolioItem } from "../types";
import {
  calculateAPR,
  portfolioItemFactory,
  roundToSignificantDigits,
} from "../helpers";
import {
  calculateUserSwapFeeRewardsFromSubgraph,
  calculateV3Yield,
  getTokenReward,
  getUnderlyingTokenUSDPrice,
  getUserGaugeRewards,
} from "../../api/beets-api";
import { getUserLiquidityInfo } from "../../api/beets-subgraph";

const SONIC_RPC_URL = "https://rpc.soniclabs.com";
const MILLISECONDS_PER_DAY = 1000 * 60 * 60 * 24;
const provider = new ethers.JsonRpcProvider(SONIC_RPC_URL);

enum BALANCER_VERSION {
  v2 = 2,
  v3 = 3,
}

const vaultArray = [
  {
    name: `scBTC/LBTC Weighted Pool`,
    gaugeAddress: "0x11c43F630b52F1271a5005839d34b07C0C125e72",
    poolId: "0x83952912178aa33c3853ee5d942c96254b235dcc",
    url: "https://beets.fi/pools/sonic/v2/0x83952912178aa33c3853ee5d942c96254b235dcc0002000000000000000000ab",
    type: "balancer-v2-pool",
    balancerVersion: BALANCER_VERSION.v2,
  },
  {
    name: `Avalon Bitcoin Treble`,
    gaugeAddress: "0x232c81fb683b830f2aa8457f88a7ced78ef956ac",
    poolId: "0xd5ab187442998f1a62ea58133a03050691a0c280",
    url: "https://beets.fi/pools/sonic/v3/0xd5ab187442998f1a62ea58133a03050691a0c280",
    type: "balancer-v3-pool",
    balancerVersion: BALANCER_VERSION.v3,
  },
  {
    name: `scETH/scBTC/scUSD/stS Sonic Quartet Audition`,
    gaugeAddress: "0xDbc37b018D4d0536e624fFd3F338F218223a9b61",
    poolId: "0xbd4a2ecdcd7acb0d2b20744ac4cc1368dd8fdc41",
    url: "https://beets.fi/pools/sonic/v2/0xbd4a2ecdcd7acb0d2b20744ac4cc1368dd8fdc410001000000000000000000a8",
    type: "balancer-v3-pool",
    balancerVersion: BALANCER_VERSION.v2,
  },
];


/**
* Beets (Balancer on Sonic) is a decentralized exchange and liquidity protocol where users 
* provide liquidity to pools and earn trading fees plus additional rewards. In v2, users 
* receive BPT (Balancer Pool Tokens) and can stake them in gauges to earn BEETS token rewards. 
* In v3, users deposit into yield-bearing token pools that automatically compound through 
* rate providers connected to underlying protocols like Avalon.
* 
* V2 rewards come from trading fees plus BEETS emissions distributed via gauge voting.
* V3 rewards come from the appreciation of yield-bearing tokens (like wrapped staking tokens)
* where the rate provider tracks the increasing exchange rate to underlying assets.
* APR is calculated based on trading fees, token emissions (v2), or yield token appreciation (v3).
*/
export const getBeetsInfo = async (walletAddress: string) => {
  const portfolioItems: PortfolioItem[] = [];
  const formattedWalletAddress = ethers.getAddress(walletAddress);
  
  const vaultPromises = vaultArray.map(async (vault) => {
        
    const userLiquidityInfo = await getUserLiquidityInfo(
      formattedWalletAddress,
      vault.poolId,
      vault.balancerVersion
    );
    const initialDeposit = userLiquidityInfo.deposits[0];


    let currentBptPrice = 0;
    let currentPositionValue = 0;
    let totalDepositValue = 0;
    let token0rewards = undefined;
    let token1rewards = undefined;
    let totalRewards = 0;
    let staked = false;
    let mainApr = 0;
    let secondaryApr = 0;
    let totalApr = 0
    
    if (!initialDeposit) {
      return;
    }

    const firstDepositTimestamp = new Date(
      initialDeposit?.timestamp * 1000
    ).toISOString();
    const currentBlockNumber = await provider.getBlockNumber();

    const totalBlocks = currentBlockNumber - +initialDeposit.blockNumber;
    const depositDate = new Date(firstDepositTimestamp);
    const currentDate = new Date();
    const daysElapsed =
      (currentDate.getTime() - depositDate.getTime()) / MILLISECONDS_PER_DAY;

    const currentTokenBalances: any[] = [];

      // Process tokens
    const tokensDepositedPromises = initialDeposit.amounts
      .map(async (amount: string, index: number) => {
        const token = initialDeposit.pool.tokens[index];
        const amountInTokenUnits = parseFloat(amount);
        const price = await getUnderlyingTokenUSDPrice(
          token.symbol.toString(),
          +initialDeposit?.timestamp
        );
        const tokenDepositValue = price * amountInTokenUnits;
        totalDepositValue += tokenDepositValue;

        // Skip tokens with zero amount
        if (amountInTokenUnits === 0) {
          return null;
        }
        return {
          symbol: token.symbol,
          name: token.name || token.symbol,
          address: token.address,
          amount: amountInTokenUnits.toString(),
          decimals: token.decimals,
          price,
          value: tokenDepositValue,
        };
      })
      .filter(Boolean);

    const tokensDeposited = await Promise.all(tokensDepositedPromises);

    // position no staked
    if (vault.balancerVersion === BALANCER_VERSION.v2) {
      if (
        userLiquidityInfo.poolShares &&
        +userLiquidityInfo.poolShares[0].balance > 0
      ) {
        // unstaked
        const share = userLiquidityInfo.poolShares[0];

        const pool = share.pool;
        currentBptPrice =
          parseFloat(pool.totalLiquidity) / parseFloat(pool.totalShares);

        const userSharePercentage =
          parseFloat(share.balance) / parseFloat(pool.totalShares);

        for (const token of pool.tokens) {
          const poolTokenBalance = parseFloat(token.balance);
          const userTokenBalance = poolTokenBalance * userSharePercentage;
          const tokenPrice = await getUnderlyingTokenUSDPrice(token.symbol);
          const tokenValue = userTokenBalance * tokenPrice;

          currentPositionValue += tokenValue;

          currentTokenBalances.push({
            symbol: token.symbol,
            name: token.name || token.symbol,
            address: token.address,
            balance: userTokenBalance,
            decimals: token.decimals,
            price: tokenPrice,
            value: tokenValue,
          });
        }

        const bptPositionValue = parseFloat(share.balance) * currentBptPrice;

        const totalGain = currentPositionValue - totalDepositValue;
        token0rewards = getTokenReward(
          currentTokenBalances[0],
          totalGain,
          currentPositionValue
        );
        token1rewards = currentTokenBalances[1]
          ? getTokenReward(
              currentTokenBalances[1],
              totalGain,
              currentPositionValue
            )
          : undefined;
        totalRewards =
          token0rewards.rewardValue + (token1rewards?.rewardValue ?? 0);
        mainApr = calculateAPR(
          totalDepositValue,
          bptPositionValue - totalDepositValue,
          daysElapsed
        );
      } else {
        // staked
        staked = true;

        const result = await getUserGaugeRewards(
          vault.gaugeAddress,
          formattedWalletAddress
        );
        const tokenRewards = result.rewards;
        const beetsReward = tokenRewards.find((t: any) => (t.name = "beets"));
        totalRewards = beetsReward?.rewardValue ?? 0;
        mainApr = beetsReward
          ? calculateAPR(
              totalDepositValue,
              beetsReward?.rewardValue,
              daysElapsed
            )
          : 0;
        token0rewards = {
          rewardAmount: beetsReward?.claimable ?? "",
          rewardValue: beetsReward?.rewardValue ?? "",
          symbol: beetsReward?.symbol.toLowerCase() ?? "",
        };
        
        const swapFeeRewards  = await calculateUserSwapFeeRewardsFromSubgraph(vault.poolId, vault.gaugeAddress, formattedWalletAddress, initialDeposit?.timestamp)
        
        if (totalDepositValue > 0 && swapFeeRewards.userSwapFeeRewardsUSD > 0) {
          secondaryApr = calculateAPR(
          totalDepositValue, 
          swapFeeRewards.userSwapFeeRewardsUSD, 
          daysElapsed);
        }
        if (secondaryApr > 0) {
          token1rewards = {
            rewardAmount: swapFeeRewards.userSwapFeeRewardsUSD ?? "",
            rewardValue: swapFeeRewards.userSwapFeeRewardsUSD ?? "",
            symbol: "Swaps Fees",
          };
        }
        console.log('Swap Fee APR:', secondaryApr)
        console.log('Beets APR', mainApr)
      }

    } else {
      // balancer v3
      const v3YieldData = await calculateV3Yield(initialDeposit);

      token0rewards = v3YieldData.token0Yield
        ? v3YieldData.token0Yield
        : {
            symbol: "",
            rewardAmount: "",
            rewardValue: "0",
          };

      token1rewards = v3YieldData.token1Yield
        ? v3YieldData.token1Yield
        : {
            symbol: "",
            rewardAmount: "",
            rewardValue: "0",
          };

      totalRewards = +token0rewards.rewardValue + +token1rewards.rewardValue;

      mainApr =
        totalRewards > 0
          ? calculateAPR(totalDepositValue, totalRewards, daysElapsed)
          : 0;
    }
    
    totalApr = mainApr + secondaryApr
    
    const portfolioItem: PortfolioItem = {
      ...portfolioItemFactory(),
      type: vault.type,
      name: vault.name,
      address: vault.poolId,
      depositTime: moment(firstDepositTimestamp).format("YY/MM/DD HH:MM:SS"),
      depositAsset0: tokensDeposited[0] ? tokensDeposited[0].symbol : "",
      depositAsset1: tokensDeposited[1] ? tokensDeposited[1].symbol : "",
      depositAmount0: tokensDeposited[0]
        ? roundToSignificantDigits(`${tokensDeposited[0].amount}`)
        : "",
      depositAmount1: tokensDeposited[1]
        ? roundToSignificantDigits(`${tokensDeposited[1].amount}`)
        : "",
      depositValue0: tokensDeposited[0]
        ? roundToSignificantDigits(`${tokensDeposited[0].value}`)
        : "",
      depositValue1: tokensDeposited[1]
        ? roundToSignificantDigits(`${tokensDeposited[1].value}`)
        : "",
      depositValue: roundToSignificantDigits(totalDepositValue.toString()),
      rewardAsset0:
        vault.balancerVersion === BALANCER_VERSION.v3
          ? token0rewards?.symbol || ""
          : staked
            ? token0rewards?.symbol || ""
            : tokensDeposited[0] && token0rewards
              ? tokensDeposited[0].symbol
              : "",
      rewardAsset1:
        vault.balancerVersion === BALANCER_VERSION.v3
          ? token1rewards?.symbol || ""
          : staked 
            ? token1rewards?.symbol || ""
            : tokensDeposited[1] && token1rewards
              ? tokensDeposited[1].symbol
              : "",
      rewardAmount0: token0rewards
        ? roundToSignificantDigits(token0rewards.rewardAmount.toString())
        : "",
      rewardAmount1: token1rewards
        ? roundToSignificantDigits(token1rewards.rewardAmount.toString())
        : "",
      rewardValue0: token0rewards
        ? roundToSignificantDigits(token0rewards.rewardValue.toString())
        : "",
      rewardValue1: token1rewards
        ? roundToSignificantDigits(token1rewards.rewardValue.toString())
        : "",
      rewardValue: roundToSignificantDigits(totalRewards.toString(), 2),
      totalDays: roundToSignificantDigits(`${daysElapsed}`, 4),
      totalBlocks: `${totalBlocks}`,
      apr: roundToSignificantDigits(totalApr.toString()),
      depositLink: vault.url,
    };

    return portfolioItem;
  });

  const results = await Promise.all(vaultPromises);

  results.forEach((item) => {
    if (item) portfolioItems.push(item);
  });

  return portfolioItems;
};
