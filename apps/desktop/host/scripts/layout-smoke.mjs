/** Layout acceptance journeys through the public debug/assist CLI. */
process.argv.push('--layout');
await import('./app-control-smoke.mjs');
