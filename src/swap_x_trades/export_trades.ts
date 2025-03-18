import moment from 'moment'
import {ClSwap} from "../types";
import {exportArrayToCSV} from "../utils";
import {getSwapEvents} from "../api";
import axios from 'axios';

const GRAPH_API_URL = `https://gateway.thegraph.com/api/${process.env.THEGRAPH_API_KEY}/subgraphs/id/6wy1bFB2XuB31Uk7vq853YGhxwiLLKK7K4PRbRxgAsNC`;

async function fetchSwaps(timestamp_gt: number) {
    const query = `
    {
        swaps(
            first: 1000,
            where: { timestamp_gt: "${timestamp_gt}", token0_: {symbol: "USDC.e"}, token1_: {symbol: "scUSD"} },
            orderBy: transaction__blockNumber
            orderDirection: asc
        ) {
            id
            transaction {
                id
                blockNumber
                timestamp
            }
            sender
            recipient
            origin
            amount0
            amount1
            amountUSD
            tick
            logIndex
            token0 {
                id
                name
                symbol
            }
            token1 {
                id
                name
                symbol
            }
            pool {
                id
            }
        }
    }`;

    try {
        const response = await axios.post(GRAPH_API_URL, { query });
        return response.data.data.swaps;
    } catch (error: any) {
        console.error('Ошибка при получении данных:', error.message);
        return [];
    }
}

const main = async () => {
  const poolSymbol = 'USDC.e/scUSD'
  let timestampFrom = moment().subtract(7, 'days').unix()

  let continueLoop = true
  let swaps: ClSwap[] = []
  do {
    // const newSwaps = await getSwapEvents({
    //   first: 1000,
    //   filter: {
    //     poolSymbol,
    //     timestamp_gt: timestampFrom
    //   },
    //   sort: {
    //     orderBy: 'transaction__blockNumber',
    //     orderDirection: 'asc'
    //   }
    // })

    const newSwaps = await fetchSwaps(timestampFrom);

    if(newSwaps.length < 1000) {
      continueLoop = false
    }
    if(newSwaps.length > 0) {
      timestampFrom = Number(newSwaps[newSwaps.length - 1].transaction.timestamp)
    }
    swaps.push(...newSwaps)
    console.log(`timestampFrom=${timestampFrom}, new=${newSwaps.length}, total=${swaps.length}`)
  } while (continueLoop)

  swaps.sort((a, b) => Number(a.transaction.blockNumber) - Number(b.transaction.blockNumber))

  const csvItems = swaps.map(swap => {
    return {
      txHash: swap.transaction.id,
      blockNumber: swap.transaction.blockNumber,
      timestamp: swap.transaction.timestamp,
      pool: swap.pool.symbol,
      poolId: swap.pool.id,
      origin: swap.origin,
      recipient: swap.recipient,
      token0: swap.token0.symbol,
      token1: swap.token1.symbol,
      amount0: swap.amount0,
      amount1: swap.amount1,
      amountUSD: swap.amountUSD,
    }
  })

  const exportFileName = `export/swap_x_swaps_${
    poolSymbol.replace('/','_')
  }_${
    Math.round(Date.now() / 1000)
  }.csv`
  console.log(`Exporting to ${exportFileName}...`)
  exportArrayToCSV(exportFileName, csvItems)
  console.log('Export complete! check' + exportFileName)
}

main()
