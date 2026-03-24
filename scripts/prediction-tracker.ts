#!/usr/bin/env npx tsx
/**
 * Prediction Tracker — Simulated investment position tracker
 *
 * Manages a JSON file of investment predictions with entry/exit prices,
 * lifecycle stages, and P&L tracking. Designed to be called by the
 * daily investment report task (task #20).
 *
 * Usage:
 *   npx tsx scripts/prediction-tracker.ts list
 *   npx tsx scripts/prediction-tracker.ts add --name "BTC" --entry 67000 --target 85000 --stop 60000 --size 50000 --thesis "Halving cycle"
 *   npx tsx scripts/prediction-tracker.ts update --name "BTC" --current 72000
 *   npx tsx scripts/prediction-tracker.ts close --name "BTC" --exit 84000 --outcome "win"
 *   npx tsx scripts/prediction-tracker.ts score
 *   npx tsx scripts/prediction-tracker.ts lifecycle --name "BTC" --stage "active"
 */

import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_PATH = join(__dirname, '..', 'data', 'predictions-tracker.json');

// --- Types ---

interface Prediction {
  name: string;
  asset_type: 'crypto' | 'stock' | 'etf' | 'commodity' | 'forex' | 'other';
  entry_price: number;
  current_price: number;
  target_price: number;
  stop_loss: number;
  position_size: number;
  thesis: string;
  catalysts: string[];
  stage: 'watching' | 'entered' | 'active' | 'scaling' | 'exiting' | 'closed';
  entry_date: string;
  last_updated: string;
  score: PredictionScore;
  notes: string[];
}

interface ClosedPrediction extends Prediction {
  exit_price: number;
  exit_date: string;
  outcome: 'win' | 'loss' | 'breakeven';
  pnl_dollars: number;
  pnl_percent: number;
  holding_days: number;
  lessons: string;
}

interface PredictionScore {
  return_potential: number;   // 0-25
  risk_timing: number;        // 0-25
  access_liquidity: number;   // 0-25
  catalyst_clarity: number;   // 0-25
  total: number;              // 0-100
}

interface TrackerData {
  metadata: {
    created: string;
    last_updated: string;
    portfolio_context: {
      net_worth: number;
      liquid_cash: number;
      active_capital: number;
      risk_profile: string;
      horizon_years: string;
    };
  };
  predictions: Prediction[];
  history: ClosedPrediction[];
}

// --- Data I/O ---

function loadData(): TrackerData {
  const raw = readFileSync(DATA_PATH, 'utf-8');
  return JSON.parse(raw) as TrackerData;
}

function saveData(data: TrackerData): void {
  data.metadata.last_updated = new Date().toISOString().split('T')[0];
  writeFileSync(DATA_PATH, JSON.stringify(data, null, 2) + '\n');
}

// --- Helpers ---

function today(): string {
  return new Date().toISOString().split('T')[0];
}

function daysBetween(a: string, b: string): number {
  const msPerDay = 86400000;
  return Math.round(
    (new Date(b).getTime() - new Date(a).getTime()) / msPerDay
  );
}

function calcPnl(
  entry: number,
  exit: number,
  size: number
): { dollars: number; percent: number } {
  const percent = ((exit - entry) / entry) * 100;
  const dollars = (percent / 100) * size;
  return { dollars: Math.round(dollars * 100) / 100, percent: Math.round(percent * 100) / 100 };
}

function findPrediction(
  data: TrackerData,
  name: string
): Prediction | undefined {
  return data.predictions.find(
    (p) => p.name.toLowerCase() === name.toLowerCase()
  );
}

// --- Commands ---

function cmdList(data: TrackerData): void {
  if (data.predictions.length === 0) {
    console.log('No active predictions.');
    return;
  }

  console.log(`\n${'Name'.padEnd(12)} ${'Stage'.padEnd(10)} ${'Entry'.padEnd(10)} ${'Current'.padEnd(10)} ${'Target'.padEnd(10)} ${'P&L %'.padEnd(8)} ${'Score'.padEnd(6)}`);
  console.log('-'.repeat(76));

  for (const p of data.predictions) {
    const pnl = calcPnl(p.entry_price, p.current_price, p.position_size);
    const pnlStr = (pnl.percent >= 0 ? '+' : '') + pnl.percent.toFixed(1) + '%';
    console.log(
      `${p.name.padEnd(12)} ${p.stage.padEnd(10)} ${p.entry_price.toString().padEnd(10)} ${p.current_price.toString().padEnd(10)} ${p.target_price.toString().padEnd(10)} ${pnlStr.padEnd(8)} ${p.score.total.toString().padEnd(6)}`
    );
  }

  console.log(`\nActive: ${data.predictions.length} | Closed: ${data.history.length}`);
}

function cmdAdd(data: TrackerData, args: Record<string, string>): void {
  const required = ['name', 'entry', 'target', 'stop', 'size', 'thesis'];
  for (const key of required) {
    if (!args[key]) {
      console.error(`Missing required arg: --${key}`);
      process.exit(1);
    }
  }

  if (findPrediction(data, args.name)) {
    console.error(`Prediction "${args.name}" already exists. Use 'update' instead.`);
    process.exit(1);
  }

  const prediction: Prediction = {
    name: args.name,
    asset_type: (args.type as Prediction['asset_type']) || 'other',
    entry_price: parseFloat(args.entry),
    current_price: parseFloat(args.entry),
    target_price: parseFloat(args.target),
    stop_loss: parseFloat(args.stop),
    position_size: parseFloat(args.size),
    thesis: args.thesis,
    catalysts: args.catalysts ? args.catalysts.split(',').map((c) => c.trim()) : [],
    stage: (args.stage as Prediction['stage']) || 'entered',
    entry_date: today(),
    last_updated: today(),
    score: {
      return_potential: parseInt(args.return_potential || '0'),
      risk_timing: parseInt(args.risk_timing || '0'),
      access_liquidity: parseInt(args.access_liquidity || '0'),
      catalyst_clarity: parseInt(args.catalyst_clarity || '0'),
      total: 0,
    },
    notes: args.note ? [args.note] : [],
  };
  prediction.score.total =
    prediction.score.return_potential +
    prediction.score.risk_timing +
    prediction.score.access_liquidity +
    prediction.score.catalyst_clarity;

  data.predictions.push(prediction);
  saveData(data);
  console.log(`Added: ${prediction.name} @ ${prediction.entry_price} (score: ${prediction.score.total})`);
}

function cmdUpdate(data: TrackerData, args: Record<string, string>): void {
  if (!args.name) {
    console.error('Missing required arg: --name');
    process.exit(1);
  }

  const p = findPrediction(data, args.name);
  if (!p) {
    console.error(`Prediction "${args.name}" not found.`);
    process.exit(1);
  }

  if (args.current) p.current_price = parseFloat(args.current);
  if (args.target) p.target_price = parseFloat(args.target);
  if (args.stop) p.stop_loss = parseFloat(args.stop);
  if (args.size) p.position_size = parseFloat(args.size);
  if (args.thesis) p.thesis = args.thesis;
  if (args.note) p.notes.push(`[${today()}] ${args.note}`);

  if (args.return_potential) p.score.return_potential = parseInt(args.return_potential);
  if (args.risk_timing) p.score.risk_timing = parseInt(args.risk_timing);
  if (args.access_liquidity) p.score.access_liquidity = parseInt(args.access_liquidity);
  if (args.catalyst_clarity) p.score.catalyst_clarity = parseInt(args.catalyst_clarity);
  p.score.total =
    p.score.return_potential + p.score.risk_timing +
    p.score.access_liquidity + p.score.catalyst_clarity;

  p.last_updated = today();
  saveData(data);

  const pnl = calcPnl(p.entry_price, p.current_price, p.position_size);
  console.log(`Updated: ${p.name} → $${p.current_price} (${pnl.percent >= 0 ? '+' : ''}${pnl.percent}%, score: ${p.score.total})`);
}

function cmdLifecycle(data: TrackerData, args: Record<string, string>): void {
  if (!args.name || !args.stage) {
    console.error('Missing required args: --name --stage');
    process.exit(1);
  }

  const validStages = ['watching', 'entered', 'active', 'scaling', 'exiting', 'closed'];
  if (!validStages.includes(args.stage)) {
    console.error(`Invalid stage. Must be one of: ${validStages.join(', ')}`);
    process.exit(1);
  }

  const p = findPrediction(data, args.name);
  if (!p) {
    console.error(`Prediction "${args.name}" not found.`);
    process.exit(1);
  }

  const oldStage = p.stage;
  p.stage = args.stage as Prediction['stage'];
  p.last_updated = today();
  if (args.note) p.notes.push(`[${today()}] Stage ${oldStage}→${p.stage}: ${args.note}`);
  saveData(data);
  console.log(`${p.name}: ${oldStage} → ${p.stage}`);
}

function cmdClose(data: TrackerData, args: Record<string, string>): void {
  if (!args.name || !args.exit || !args.outcome) {
    console.error('Missing required args: --name --exit --outcome');
    process.exit(1);
  }

  const validOutcomes = ['win', 'loss', 'breakeven'];
  if (!validOutcomes.includes(args.outcome)) {
    console.error(`Invalid outcome. Must be one of: ${validOutcomes.join(', ')}`);
    process.exit(1);
  }

  const idx = data.predictions.findIndex(
    (p) => p.name.toLowerCase() === args.name.toLowerCase()
  );
  if (idx === -1) {
    console.error(`Prediction "${args.name}" not found.`);
    process.exit(1);
  }

  const p = data.predictions[idx];
  const exitPrice = parseFloat(args.exit);
  const pnl = calcPnl(p.entry_price, exitPrice, p.position_size);

  const closed: ClosedPrediction = {
    ...p,
    stage: 'closed',
    exit_price: exitPrice,
    exit_date: today(),
    outcome: args.outcome as ClosedPrediction['outcome'],
    pnl_dollars: pnl.dollars,
    pnl_percent: pnl.percent,
    holding_days: daysBetween(p.entry_date, today()),
    lessons: args.lessons || '',
    last_updated: today(),
  };

  data.predictions.splice(idx, 1);
  data.history.push(closed);
  saveData(data);

  const sign = pnl.dollars >= 0 ? '+' : '';
  console.log(`Closed: ${closed.name} → ${closed.outcome} | ${sign}$${pnl.dollars} (${sign}${pnl.percent}%) over ${closed.holding_days}d`);
}

function cmdScore(data: TrackerData): void {
  const all = [...data.predictions].sort((a, b) => b.score.total - a.score.total);

  if (all.length === 0) {
    console.log('No predictions to score.');
    return;
  }

  console.log(`\n${'#'.padEnd(4)} ${'Name'.padEnd(12)} ${'Return'.padEnd(8)} ${'Risk'.padEnd(8)} ${'Access'.padEnd(8)} ${'Catalyst'.padEnd(8)} ${'TOTAL'.padEnd(6)} ${'Stage'.padEnd(10)}`);
  console.log('-'.repeat(74));

  all.forEach((p, i) => {
    console.log(
      `${(i + 1).toString().padEnd(4)} ${p.name.padEnd(12)} ${p.score.return_potential.toString().padEnd(8)} ${p.score.risk_timing.toString().padEnd(8)} ${p.score.access_liquidity.toString().padEnd(8)} ${p.score.catalyst_clarity.toString().padEnd(8)} ${p.score.total.toString().padEnd(6)} ${p.stage.padEnd(10)}`
    );
  });

  // Scorecard from history
  if (data.history.length > 0) {
    console.log(`\n--- SCORECARD ---`);
    const wins = data.history.filter((h) => h.outcome === 'win');
    const losses = data.history.filter((h) => h.outcome === 'loss');
    const totalPnl = data.history.reduce((sum, h) => sum + h.pnl_dollars, 0);
    const avgHold = data.history.reduce((sum, h) => sum + h.holding_days, 0) / data.history.length;

    console.log(`Win rate: ${wins.length}/${data.history.length} (${Math.round((wins.length / data.history.length) * 100)}%)`);
    console.log(`Total P&L: ${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}`);
    console.log(`Avg hold: ${Math.round(avgHold)}d`);
    console.log(`Biggest win: ${wins.length > 0 ? `${wins.sort((a, b) => b.pnl_dollars - a.pnl_dollars)[0].name} (+$${wins[0].pnl_dollars})` : 'N/A'}`);
    console.log(`Biggest loss: ${losses.length > 0 ? `${losses.sort((a, b) => a.pnl_dollars - b.pnl_dollars)[0].name} ($${losses[0].pnl_dollars})` : 'N/A'}`);
  }
}

// --- CLI Parser ---

function parseArgs(argv: string[]): { command: string; args: Record<string, string> } {
  const command = argv[2] || 'list';
  const args: Record<string, string> = {};

  for (let i = 3; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : 'true';
      args[key] = val;
      if (val !== 'true') i++;
    }
  }

  return { command, args };
}

// --- Main ---

function main(): void {
  const data = loadData();
  const { command, args } = parseArgs(process.argv);

  switch (command) {
    case 'list': cmdList(data); break;
    case 'add': cmdAdd(data, args); break;
    case 'update': cmdUpdate(data, args); break;
    case 'lifecycle': cmdLifecycle(data, args); break;
    case 'close': cmdClose(data, args); break;
    case 'score': cmdScore(data); break;
    default:
      console.error(`Unknown command: ${command}`);
      console.error('Commands: list, add, update, lifecycle, close, score');
      process.exit(1);
  }
}

main();
