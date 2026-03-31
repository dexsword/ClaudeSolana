import { Connection, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { getAssociatedTokenAddress, getAccount, TokenAccountNotFoundError, TokenInvalidAccountOwnerError } from '@solana/spl-token';

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

}
