#!/bin/bash
# Ablation test script for defensive regime variables

cd /root/ClaudeSolana

# Save baseline config
cp config.json config_ablation_base.json

echo "=== BASELINE ==="
npm run backtest 2>&1 | grep -E "(Final value|Total return|Sharpe|Max drawdown|Trade statistics)" | head -10

echo ""
echo "=== Testing bearFloorSolPct: 35, 40, 45 ==="
for val in 35 40 45; do
    echo "--- bearFloorSolPct=$val ---"
    cp config_ablation_base.json config.json
    sed -i "s/\"bearFloorSolPct\": [0-9]*/\"bearFloorSolPct\": $val/" config.json
    npm run backtest 2>&1 | grep -E "(Final value|Max drawdown|Sharpe)" | head -3
done

echo ""
echo "=== Testing bearTargetMultiplier: 0.7, 0.8, 0.85 ==="
for val in 0.7 0.8 0.85; do
    echo "--- bearTargetMultiplier=$val ---"
    cp config_ablation_base.json config.json
    sed -i "s/\"bearTargetMultiplier\": [0-9.]*/\"bearTargetMultiplier\": $val/" config.json
    npm run backtest 2>&1 | grep -E "(Final value|Max drawdown|Sharpe)" | head -3
done

echo ""
echo "=== Testing bearExtraVwapDiscountPct: 1.5, 3.0, 4.0 ==="
for val in 1.5 3.0 4.0; do
    echo "--- bearExtraVwapDiscountPct=$val ---"
    cp config_ablation_base.json config.json
    sed -i "s/\"bearExtraVwapDiscountPct\": [0-9.]*/\"bearExtraVwapDiscountPct\": $val/" config.json
    npm run backtest 2>&1 | grep -E "(Final value|Max drawdown|Sharpe)" | head -3
done

echo ""
echo "=== Testing bearModerateBuyRsiAdjustment: -6, -8, -10 ==="
for val in "-6" "-8" "-10"; do
    echo "--- bearModerateBuyRsiAdjustment=$val ---"
    cp config_ablation_base.json config.json
    sed -i "s/\"bearModerateBuyRsiAdjustment\": [-0-9]*/\"bearModerateBuyRsiAdjustment\": $val/" config.json
    npm run backtest 2>&1 | grep -E "(Final value|Max drawdown|Sharpe)" | head -3
done

echo ""
echo "=== Testing bearDriftOverridePct: 12, 18, 25 ==="
for val in 12 18 25; do
    echo "--- bearDriftOverridePct=$val ---"
    cp config_ablation_base.json config.json
    sed -i "s/\"bearDriftOverridePct\": [0-9]*/\"bearDriftOverridePct\": $val/" config.json
    npm run backtest 2>&1 | grep -E "(Final value|Max drawdown|Sharpe)" | head -3
done

echo ""
echo "=== Testing highVolTargetReductionPct: 5, 12, 15 ==="
for val in 5 12 15; do
    echo "--- highVolTargetReductionPct=$val ---"
    cp config_ablation_base.json config.json
    sed -i "s/\"highVolTargetReductionPct\": [0-9]*/\"highVolTargetReductionPct\": $val/" config.json
    npm run backtest 2>&1 | grep -E "(Final value|Max drawdown|Sharpe)" | head -3
done

echo ""
echo "=== Testing drawdownScaling.scaleStartPct: 5, 10, 12 ==="
for val in 5 10 12; do
    echo "--- scaleStartPct=$val ---"
    cp config_ablation_base.json config.json
    sed -i "s/\"scaleStartPct\": [0-9]*/\"scaleStartPct\": $val/" config.json
    npm run backtest 2>&1 | grep -E "(Final value|Max drawdown|Sharpe)" | head -3
done

# Restore baseline
cp config_ablation_base.json config.json
rm config_ablation_base.json

echo ""
echo "=== ABLATION COMPLETE ==="
