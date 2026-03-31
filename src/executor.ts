import axios from 'axios';
import { Connection, Keypair, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { SwapResult } from './sharedTypes';

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SOL_DECIMALS = 9;
const USDC_DECIMALS = 6;
const JUPITER_BASE = process.env.JUPITER_API_URL ?? 'https://api.jup.ag/swap/v1';

export class TradeExecutor {
  private connection: Connection;
  private keypair: Keypair;
  private maxSlippageBps: number;
  private maxPriceImpactPct: number;

  constructor(rpcUrl: string, privateKeyBase58: string, maxSlippagePct: number, maxPriceImpactPct: number = Infinity) {
    this.connection = new Connection(rpcUrl, 'confirmed');
    this.keypair = Keypair.fromSecretKey(bs58.decode(privateKeyBase58));
    this.maxSlippageBps = Math.round(maxSlippagePct * 100); // pct → bps
    this.maxPriceImpactPct = maxPriceImpactPct;
  }

  get walletAddress(): string {
    return this.keypair.publicKey.toBase58();
  }

  /**
   * Buy SOL with `usdcAmount` USDC.
   * If dryRun=true, skips the Jupiter API call and simulates output from
   * the provided spot price (no network required for dry-run testing).
   */
  async buySol(usdcAmount: number, dryRun: boolean, spotPrice?: number): Promise<SwapResult> {
    if (dryRun && spotPrice) {
      const outputSol = usdcAmount / spotPrice;
      return { success: true, txSignature: null, inputAmount: usdcAmount, outputAmount: outputSol, price: spotPrice };
    }

    const inputAmountRaw = Math.round(usdcAmount * 10 ** USDC_DECIMALS);
    try {
      const quote = await this.getQuote(USDC_MINT, SOL_MINT, inputAmountRaw);
      const outputSol = Number(quote.outAmount) / 10 ** SOL_DECIMALS;
      const price = usdcAmount / outputSol;

      if (dryRun) {
        return { success: true, txSignature: null, inputAmount: usdcAmount, outputAmount: outputSol, price };
      }

      const sig = await this.executeSwap(quote);
      return { success: true, txSignature: sig, inputAmount: usdcAmount, outputAmount: outputSol, price };
    } catch (err) {
      return { success: false, txSignature: null, inputAmount: usdcAmount, outputAmount: 0, price: 0, error: String(err) };
    }
  }

  /**
   * Sell `solAmount` SOL for USDC.
   * If dryRun=true, skips the Jupiter API call and simulates output from
   * the provided spot price (no network required for dry-run testing).
   */
  async sellSol(solAmount: number, dryRun: boolean, spotPrice?: number): Promise<SwapResult> {
    if (dryRun && spotPrice) {
      const outputUsdc = solAmount * spotPrice;
      return { success: true, txSignature: null, inputAmount: solAmount, outputAmount: outputUsdc, price: spotPrice };
    }

    const inputAmountRaw = Math.round(solAmount * 10 ** SOL_DECIMALS);
    try {
      const quote = await this.getQuote(SOL_MINT, USDC_MINT, inputAmountRaw);
      const outputUsdc = Number(quote.outAmount) / 10 ** USDC_DECIMALS;
      const price = outputUsdc / solAmount;

      if (dryRun) {
        return { success: true, txSignature: null, inputAmount: solAmount, outputAmount: outputUsdc, price };
      }

      const sig = await this.executeSwap(quote);
      return { success: true, txSignature: sig, inputAmount: solAmount, outputAmount: outputUsdc, price };
    } catch (err) {
      return { success: false, txSignature: null, inputAmount: solAmount, outputAmount: 0, price: 0, error: String(err) };
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async getQuote(inputMint: string, outputMint: string, amount: number): Promise<any> {
    const apiKey = process.env.JUPITER_PRICE_API_KEY ?? '';
    const resp = await axios.get(`${JUPITER_BASE}/quote`, {
      params: {
        inputMint,
        outputMint,
        amount,
        slippageBps: this.maxSlippageBps,
        onlyDirectRoutes: false,
      },
      headers: { 'x-api-key': apiKey },
      timeout: 10000,
    });

    const q = resp.data;
    const impact = q?.priceImpactPct;
    if (this.maxPriceImpactPct !== Infinity && impact !== undefined && impact !== null) {
      const pct = typeof impact === 'string' ? parseFloat(impact) * 100 : Number(impact) * 100;
      if (Number.isFinite(pct) && pct > this.maxPriceImpactPct) {
        throw new Error(`Quote price impact too high: ${pct.toFixed(2)}% > ${this.maxPriceImpactPct.toFixed(2)}%`);
      }
    }

    return q;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async executeSwap(quote: any): Promise<string> {
    // Step 1: Get swap transaction from Jupiter
    const apiKey = process.env.JUPITER_PRICE_API_KEY ?? '';
    const swapResp = await axios.post(
      `${JUPITER_BASE}/swap`,
      {
        quoteResponse: quote,
        userPublicKey: this.walletAddress,
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: 'auto',
      },
      { headers: { 'x-api-key': apiKey }, timeout: 15000 },
    );

    const { swapTransaction } = swapResp.data;
    if (!swapTransaction) throw new Error('No swapTransaction returned from Jupiter');

    // Step 2: Deserialize and sign
    const txBuf = Buffer.from(swapTransaction, 'base64');
    const tx = VersionedTransaction.deserialize(txBuf);

    // Step 3: Simulate first
    const sim = await this.connection.simulateTransaction(tx, { commitment: 'confirmed' });
    if (sim.value.err) {
      throw new Error(`Simulation failed: ${JSON.stringify(sim.value.err)}`);
    }

    // Step 4: Sign and send
    tx.sign([this.keypair]);
    const rawTx = tx.serialize();
    const sig = await this.connection.sendRawTransaction(rawTx, {
      skipPreflight: false,
      maxRetries: 3,
    });

    // Step 5: Confirm
    await this.connection.confirmTransaction(sig, 'confirmed');
    return sig;
  }
}
