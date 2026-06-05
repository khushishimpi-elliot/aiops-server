#!/usr/bin/env node
// Debug script to trace what's happening with sessions

import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Import the functions we need
import { runAllAdapters } from './src/adapters/index.js';
import { computeDailyAggregates } from './src/core/aggregator.js';

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('DEBUG: Adapter Session Loading');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

// Run all adapters
const toolResults = runAllAdapters();

console.log('Adapter Results:');
for (const result of toolResults) {
  console.log(`\n${result.toolId}:`);
  console.log(`  Installed: ${result.installed}`);
  console.log(`  Sessions: ${result.sessions.length}`);
  if (result.sessions.length > 0) {
    console.log(`  First session: ${JSON.stringify({
      tool: result.sessions[0].tool,
      model: result.sessions[0].model,
      date: result.sessions[0].sessionDate,
      timestamp: result.sessions[0].sessionTimestamp,
      tokens: `${result.sessions[0].inputTokens}/${result.sessions[0].outputTokens}`,
    }, null, 2).split('\n').join('\n    ')}`);
  }
  console.log(`  Stats: processed=${result.stats.processed}, skipped=${result.stats.skipped}, errors=${result.stats.errors}`);
}

const allSessions = toolResults.flatMap(r => r.sessions);
console.log(`\nTotal sessions from all adapters: ${allSessions.length}`);

// Group by tool
const byTool = {};
for (const s of allSessions) {
  if (!byTool[s.tool]) byTool[s.tool] = [];
  byTool[s.tool].push(s);
}

console.log('\nSessions by tool:');
for (const [tool, sessions] of Object.entries(byTool)) {
  console.log(`  ${tool}: ${sessions.length}`);
}

// Now compute aggregates
console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('DEBUG: Aggregation');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

const aggregates = computeDailyAggregates(90);
console.log(`Total aggregates: ${aggregates.length}`);

// Group by tool
const aggByTool = {};
for (const agg of aggregates) {
  if (!aggByTool[agg.tool]) aggByTool[agg.tool] = [];
  aggByTool[agg.tool].push(agg);
}

console.log('\nAggregates by tool:');
for (const [tool, aggs] of Object.entries(aggByTool)) {
  const totalSessions = aggs.reduce((sum, a) => sum + a.sessions, 0);
  console.log(`  ${tool}: ${aggs.length} rows, ${totalSessions} sessions`);
}

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
