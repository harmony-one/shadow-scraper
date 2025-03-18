import { promises as fsPromises } from 'fs';
import { parse } from 'csv-parse/sync';

interface Trade {
  txHash: string;
  blockNumber: string;
  timestamp: string;
  pool: string;
  poolId: string;
  origin: string;
  recipient: string;
  token0: string;
  token1: string;
  amount0: string;
  amount1: string;
  amountUSD: string;
}

interface TradeWithVolume {
  price: number;
  volume: number;
}

async function calculateVolumeRange(trades: TradeWithVolume[], targetCenter = 1, volumePercent = 90) {
    if (!trades || trades.length === 0) {
        throw new Error('Trades array cannot be empty');
    }

    // Sort trades by price and filter out negative prices
    const sortedTrades = [...trades]
        .filter(trade => trade.price > 0)
        .sort((a, b) => a.price - b.price);

    const totalVolume = sortedTrades.reduce((sum, trade) => sum + trade.volume, 0);
    const targetVolume = totalVolume * (volumePercent / 100);

    let bestRange = { lower: 0, upper: 0, volume: 0 };
    let minDiff = Number.MAX_VALUE;

    // Try different window sizes
    for (let i = 0; i < sortedTrades.length; i++) {
        let volume = 0;
        let j = i;

        // Accumulate volume until we reach target
        while (j < sortedTrades.length && volume < targetVolume) {
            volume += sortedTrades[j].volume;
            j++;
        }

        if (volume >= targetVolume) {
            const windowPrices = sortedTrades.slice(i, j);
            const avgPrice = windowPrices.reduce((sum, trade) => sum + trade.price * trade.volume, 0) / 
                           windowPrices.reduce((sum, trade) => sum + trade.volume, 0);
            
            const diffFromTarget = Math.abs(avgPrice - targetCenter);
            
            if (diffFromTarget < minDiff) {
                minDiff = diffFromTarget;
                bestRange = {
                    lower: sortedTrades[i].price,
                    upper: sortedTrades[j-1].price,
                    volume: volume
                };
            }
        }
    }

    // Shift the range to center around targetCenter
    const currentCenter = (bestRange.upper + bestRange.lower) / 2;
    const shift = targetCenter - currentCenter;
    
    return {
        lower: bestRange.lower + shift,
        upper: bestRange.upper + shift,
        volume: bestRange.volume
    };
}

async function analyzePoolVolume(poolName: string, csvFilePath: string) {
    try {
        // Asynchronously read data file
        const fileData = await fsPromises.readFile(csvFilePath, 'utf-8');
        
        // Parse CSV file
        const trades = parse(fileData, {
            columns: true,
            skip_empty_lines: true
        }) as Trade[];

        // Check for required columns
        if (!trades.length || !trades[0].amount0 || !trades[0].amount1 || !trades[0].amountUSD) {
            throw new Error('Cannot find required columns amount0, amount1, or amountUSD in data');
        }

        // Calculate prices and volumes for all trades
        const tradesWithVolume = trades.map(trade => {
            const amount0 = Number(trade.amount0);
            const amount1 = Number(trade.amount1);
            const volume = Number(trade.amountUSD);

            // Skip trade if amounts are invalid
            if (isNaN(amount0) || isNaN(amount1) || isNaN(volume) || amount0 === 0) {
                return null;
            }
            return {
                price: Math.abs(amount1) / Math.abs(amount0),
                volume: volume
            };
        }).filter((trade): trade is TradeWithVolume => trade !== null);

        if (tradesWithVolume.length === 0) {
            throw new Error('No valid trades for analysis');
        }

        // Find range containing 90% of volume, centered around $1
        const { lower, upper, volume } = await calculateVolumeRange(tradesWithVolume, 1, 90);
        const center = 1;
        const range = (upper - lower) / 2;
        const percentageFromCenter = (range / center) * 100;

        // Calculate total volume
        const totalVolume = tradesWithVolume.reduce((sum, trade) => sum + trade.volume, 0);
        const volumeInRange = volume / totalVolume * 100;

        // Output results
        console.log(`\nVolume Analysis for pool ${poolName}:`, tradesWithVolume.length);
        console.log(`Total volume: $${totalVolume.toFixed(2)}`);
        console.log(`Volume in range: $${volume.toFixed(2)} (${volumeInRange.toFixed(2)}%)`);
        console.log(`Range center: $${center.toFixed(8)}`);
        console.log(`Lower boundary: $${lower.toFixed(8)}`);
        console.log(`Upper boundary: $${upper.toFixed(8)}`);
        console.log(`Range: ±${percentageFromCenter.toFixed(4)}% from center`);
    } catch (error: any) {
        console.error(`Error analyzing pool ${poolName}: ${error?.message}`);
    }
}

const main = async () => {
    try {
        await analyzePoolVolume('Shadow: USDC.e_USDT', 'export/shadow_swaps_USDC.e_USDT_1742226431.csv');

        console.log('____________');

        await analyzePoolVolume('SwapX: wstkscUSD/scUSD', 'export/swap_x_wstkscUSD.scUSD_1742246881.csv');

        console.log('____________');

        await analyzePoolVolume('SwapX: USDC.e/scUSD', 'export/swap_x_swaps_USDC.e_scUSD_1742313520.csv');

        console.log('____________');
        
        await analyzePoolVolume('Shadow: USDC.e_scUSD', 'export/shadow_swaps_USDC.e_scUSD_1742312216.csv');
    } catch (error: any) {
        console.error(`Error: ${error?.message}`);
    }
};

main(); 