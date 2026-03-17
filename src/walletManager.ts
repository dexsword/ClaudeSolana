import { Connection, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { getAssociatedTokenAddress, getAccount, TokenAccountNotFoundError, TokenInvalidAccountOwnerError } from '@solana/spl-token';
import { BotConfig } from './types';

const USDC_MINT_MAINNET = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const USDC_MINT_DEVNET  = new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
const USDC_DECIMALS = 6;

export interface WalletBalances {
  solBalance: number;    // in SOL
  usdcBalance: number;   // in USDC
  totalValueUSDC: number;
}

export class WalletManager {
  private connection: Connection;
  private walletPubkey: PublicKey;
  private usdcMint: PublicKey;

  constructor(rpcUrl: string, walletAddress: string, useDevnet = false) {
    this.connection = new Connection(rpcUrl, 'confirmed');
    this.walletPubkey = new PublicKey(walletAddress);
    this.usdcMint = useDevnet ? USDC_MINT_DEVNET : USDC_MINT_MAINNET;
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
      const ata = await getAssociatedTokenAddress(this.usdcMint, this.walletPubkey);
      const account = await getAccount(this.connection, ata);
      return Number(account.amount) / 10 ** USDC_DECIMALS;
    } catch (err) {
      if (err instanceof TokenAccountNotFoundError || err instanceof TokenInvalidAccountOwnerError) {
        return 0;
      }
      throw err;
    }
  }

  /**
   * Current SOL % of the bot-managed portfolio.
   * managedSol = position.solBalance (excludes gas reserve SOL).
   * usdcBalance = available USDC in wallet.
   */
  computeCurrentSolPct(managedSolBalance: number, usdcBalance: number, solPrice: number): number {
    const solValueUSDC = managedSolBalance * solPrice;
    const total = solValueUSDC + usdcBalance;
    if (total <= 0) return 0;
    return (solValueUSDC / total) * 100;
  }

  /**
   * How much USDC to spend to reach the target SOL % from the current allocation.
   * Returns 0 if already at or above target.
   */
  computeRebalanceBuyAmount(
    currentSolPct: number,
    targetSolPct: number,
    totalManagedUSDC: number,
    availableUSDC: number,
  ): number {
    if (targetSolPct <= currentSolPct) return 0;
    const targetSolValue = totalManagedUSDC * (targetSolPct / 100);
    const currentSolValue = totalManagedUSDC * (currentSolPct / 100);
    const usdcNeeded = targetSolValue - currentSolValue;
    return Math.max(0, Math.min(usdcNeeded, availableUSDC));
  }

  /**
   * How much SOL to sell to reach the target SOL % from the current allocation.
   * Returns 0 if already at or below target.
   */
  computeRebalanceSellAmount(
    currentSolPct: number,
    targetSolPct: number,
    totalManagedUSDC: number,
    solPrice: number,
    availableSol: number,
  ): number {
    if (targetSolPct >= currentSolPct) return 0;
    const targetSolValue = totalManagedUSDC * (targetSolPct / 100);
    const currentSolValue = totalManagedUSDC * (currentSolPct / 100);
    const usdcToRaise = currentSolValue - targetSolValue;
    const solToSell = solPrice > 0 ? usdcToRaise / solPrice : 0;
    return Math.max(0, Math.min(solToSell, availableSol));
  }

  /**
   * Check if circuit breaker should fire: portfolio value has dropped
   * more than circuitBreakerDrawdownPct% from its all-time high-water mark.
   *
   * Using a live HWM rather than a static starting capital means the bot
   * automatically recalibrates when funds are added or profits compound —
   * no manual config changes required.
   */
  isCircuitBreakerTripped(totalValueUSDC: number, portfolioHWM: number, cfg: BotConfig): boolean {
    if (portfolioHWM <= 0) return false; // no baseline established yet
    const drawdown = ((portfolioHWM - totalValueUSDC) / portfolioHWM) * 100;
    return drawdown >= cfg.strategy.risk.circuitBreakerDrawdownPct;
  }
}
