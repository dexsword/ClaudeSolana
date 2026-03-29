# Agent Guidelines for Solana Swing Bot

## Project Overview

This is a Solana RSI+VWAP swing trading bot written in TypeScript. It executes trades on Solana using Jupiter DEX, integrates with Discord for notifications, and uses technical indicators (RSI, VWAP, SMA) for trading decisions.

---

## Build & Test Commands

### Build
```bash
npm run build          # Compile TypeScript → dist/
```

### Run
```bash
npm start             # Run compiled JS from dist/
npm run dev           # Run with ts-node (src/)
npm run dry-run       # Dry run mode (no actual trades)
npm run backtest      # Run backtest script
npm run optimize      # Run parameter optimization
```

### Test
```bash
npm test              # Run all tests (Jest with --forceExit)
npm run test:watch    # Run tests in watch mode

# Run a single test file
npx jest src/__tests__/indicators.test.ts --forceExit
npx jest src/__tests__/strategy.test.ts --forceExit

# Run a single test (by name)
npx jest --testNamePattern="RSI is 100 when price only goes up" --forceExit
```

### Lint
```bash
npm run lint          # ESLint src/**/*.ts
```

---

## Code Style Guidelines

### TypeScript Configuration
- **Strict mode enabled** in tsconfig.json
- Target: ES2020, module: CommonJS
- Always use explicit types; avoid `any`

### Imports
- Use relative imports: `import { X } from './types';`
- Named exports preferred over default exports
- Group imports: external packages first, then internal modules

### Naming Conventions
| Element | Convention | Example |
|---------|-----------|---------|
| Interfaces | PascalCase | `interface PositionState` |
| Types | PascalCase | `type TrendBias` |
| Functions | camelCase | `calculateRSI()` |
| Variables | camelCase | `avgEntryPrice` |
| Constants | camelCase | `RSI_DIRECTION_THRESHOLD` |
| Enums/Literals | lowercase with underscores | `'rebalance_buy'` |

### Type Definitions (types.ts)
- Use `interface` for object shapes
- Use `type` for unions, aliases, and simple objects
- Document complex fields with inline comments
- Use `| null` for optional values that aren't TypeScript optional

```typescript
// Good
export interface Candle {
  timestamp: number; // Unix ms
  open: number;
  close: number;
}

export type TrendBias = 'bullish' | 'neutral' | 'bearish';

// Avoid
type MaybeNumber = number | null | undefined;
```

### Functions
- Use JSDoc comments for public/exported functions
- Document parameters and return values
- Keep functions focused (< 100 lines preferred)
- Prefer pure functions where possible

```typescript
/**
 * Calculate RSI using Wilder's smoothing method.
 * Returns null if not enough data.
 * @param candles - Array of OHLCV candles
 * @param period - RSI period (default: 14)
 * @returns Array of RSI values (null for insufficient data)
 */
export function calculateRSI(candles: Candle[], period: number = 14): (number | null)[] {
  // ...
}
```

### Error Handling
- Use explicit error types/messages
- Return `Result<T, E>` patterns where appropriate
- Log errors with context using the logger module

### Numeric Literals
- Use underscore separators for readability: `1_700_000_000_000`
- Use decimal notation for financial values: `100.50`

### Conditional Logic
- Use early returns to reduce nesting
- Prefer `else if` chains over deeply nested conditions
- Extract complex conditions into named variables

### Testing (Jest)
- Test files: `src/__tests__/{module}.test.ts`
- Use `describe` blocks to group related tests
- Test names should be descriptive: `"RSI is 100 when price only goes up"`
- Use `toBeCloseTo()` for floating-point comparisons
- Create helper functions for test fixtures (`makeCandles`, `makeCfg`)

```typescript
describe('calculateRSI', () => {
  it('returns all nulls when fewer than period+1 candles', () => {
    const candles = makeCandles([100, 102, 101]);
    const result = calculateRSI(candles, 14);
    expect(result.every((v) => v === null)).toBe(true);
  });
});
```

### Configuration
- Config objects use snake_case keys matching JSON structure
- Default configs created via factory functions (e.g., `makeCfg()`)
- Avoid hardcoding magic numbers; use named constants from config

---

## Architecture Notes

### Core Modules
| File | Purpose |
|------|---------|
| `types.ts` | All TypeScript interfaces and types |
| `indicators.ts` | Pure functions for RSI/VWAP/SMA calculation |
| `strategy.ts` | Trading signal generation logic |
| `bot.ts` | Main bot orchestration |
| `executor.ts` | Trade execution via Jupiter DEX |
| `walletManager.ts` | Wallet/key management |
| `priceFeed.ts` | Price data fetching |
| `notifications.ts` | Discord webhook notifications |
| `logger.ts` | Structured logging |

### State Management
- `PositionState` tracks current portfolio state
- `BotConfig` holds all strategy parameters
- State should be immutable; use spread operator for updates

### Trade Flow
1. Fetch 4h candles (RSI/VWAP) and 3d candles (SMA)
2. Calculate indicators
3. Evaluate strategy → generate signal
4. Check risk rules (stop loss, trailing stop)
5. Execute trade via Jupiter if signal valid

---

## Common Tasks

### Adding a new indicator
1. Add pure calculation function in `indicators.ts`
2. Add tests in `src/__tests__/indicators.test.ts`
3. Integrate in `getLatestIndicators()` or bot loop

### Adding a new strategy parameter
1. Add to `BotConfig` interface in `types.ts`
2. Add default value in `config.json`
3. Add to `makeCfg()` in test files
4. Document in code comments

### Running backtests
```bash
npm run backtest
```
Outputs CSV files in project root for analysis.

---

## Environment Variables
- `RPC_ENDPOINT` - Solana RPC URL
- `WALLET_SECRET_KEY` - Base58 encoded private key
- `DISCORD_WEBHOOK_URL` - Discord webhook (optional)
- See `.env.example` for full list
