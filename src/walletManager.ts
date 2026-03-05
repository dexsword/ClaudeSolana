import { Connection, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { getAssociatedTokenAddress, getAccount } from '@solana/spl-token';
import { BotConfig, PositionState } from './types';

const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const USDC_DECIMALS = 6;

export interface WalletBalances {
  solBalance: number;    // in SOL
  usdcBalance: number;   // in USDC
  totalValueUSDC: number;
}

export class WalletManager {
  private connection: Connection;
  private walletPubkey: PublicKey;

  constructor(rpcUrl: string, walletAddress: string) {
    this.connection = new Connection(rpcUrl, 'confirmed');
    this.walletPubkey = new PublicKey(walletAddress);
  }

  async getBalances(solPriceUSDC: number): Promise<WalletBalances> {
    const [lamports, usdcBalance] = await Promise.all([
      this.connection.getBalance(this.walletPubkey),
      this.getUSDCBalance(),
    ]);

    const solBalance = lamports / LAMPORTS_PER_SOL;
    const totalValueUSDC = solBalance * solPriceUSDC + usdcBalance;

    return { solBalance, usdcBalance, totalValueUSDC };
  }

  private async getUSDCBalance(): Promise<number> {
    try {
      const ata = await getAssociatedTokenAddress(USDC_MINT, this.walletPubkey);
      const account = await getAccount(this.connection, ata);
      return Number(account.amount) / 10 ** USDC_DECIMALS;
    } catch {
      // ATA may not exist if no USDC has ever been held
      return 0;
    }
  }

  /**
   * Calculate how much USDC to allocate per tier based on available USDC
   * and tier percentages defined in config.
   */
  computeTierAllocations(
    availableUSDC: number,
    cfg: BotConfig,
    position: PositionState,
  ): { tier1: number; tier2: number; tier3: number } {
    const totalCapital = cfg.capital.startingCapitalUSDC;
    const t = cfg.strategy.tiers;

    // Allocations are fractions of total starting capital
    const tier1 = totalCapital * (t.tier1AllocationPct / 100);
    const tier2 = totalCapital * (t.tier2AllocationPct / 100);
    const tier3 = totalCapital * (t.tier3AllocationPct / 100);

    // Subtract already-spent amounts
    const remaining1 = position.tiers.tier1Filled ? 0 : Math.min(tier1, availableUSDC);
    const remaining2 = position.tiers.tier2Filled ? 0 : Math.min(tier2, availableUSDC);
    const remaining3 = position.tiers.tier3Filled ? 0 : Math.min(tier3, availableUSDC);

    return { tier1: remaining1, tier2: remaining2, tier3: remaining3 };
  }

  /**
   * Check if circuit breaker should fire: portfolio value has dropped
   * more than circuitBreakerDrawdownPct% from starting capital.
   */
  isCircuitBreakerTripped(totalValueUSDC: number, cfg: BotConfig): boolean {
    const startingCapital = cfg.capital.startingCapitalUSDC;
    const drawdown = ((startingCapital - totalValueUSDC) / startingCapital) * 100;
    return drawdown >= cfg.strategy.risk.circuitBreakerDrawdownPct;
  }
}
