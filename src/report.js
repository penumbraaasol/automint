import { formatEther } from 'viem';
import { duration, iso } from './format.js';

const pad = (s, n) => String(s ?? '').slice(0, n).padEnd(n);

export function renderScanTable(rows, { limit = 20 } = {}) {
  console.log(`\n  ${pad('SCORE', 7)}${pad('CONF', 10)}${pad('SLUG', 30)}${pad('CHAIN', 10)}${pad('PRICE', 12)}${pad('OPENS', 18)}`);
  console.log('  ' + '-'.repeat(87));
  for (const r of rows.slice(0, limit)) {
    const price = r.mintEth === 0 ? 'FREE' : r.mintEth != null ? `${r.mintEth} ETH` : '?';
    const opens = r.stage?.isOpen ? 'OPEN'
      : r.stage?.startMs ? `in ${duration(r.stage.startMs - Date.now())}`
      : '?';
    console.log(`  ${pad(r.score.toFixed(1), 7)}${pad(r.confidence, 10)}${pad(r.drop.slug, 30)}${pad(r.drop.chain, 10)}${pad(price, 12)}${pad(opens, 18)}`);
  }
}

export function renderDetail(r) {
  console.log(`\n${r.drop.name} (${r.drop.slug})`);
  console.log(`  chain     ${r.drop.chain}`);
  console.log(`  contract  ${r.drop.contractAddress}`);
  console.log(`  score     ${r.score}  [${r.confidence}]`);
  if (r.stage) {
    console.log(`  stage     ${r.stage.stageType} -- ${r.stage.label ?? ''}`);
    console.log(`  price     ${r.mintEth === 0 ? 'FREE' : `${r.mintEth} ETH`}  max/wallet ${r.stage.maxPerWallet ?? '?'}`);
    if (r.stage.startMs) {
      console.log(`  window    ${iso(r.stage.startMs)}${r.stage.endMs ? ` -> ${iso(r.stage.endMs)}` : ''}`);
      console.log(`  status    ${r.stage.isOpen ? 'OPEN' : `opens in ${duration(r.stage.startMs - Date.now())}`}`);
    }
  }
  if (r.stats?.sales > 0) {
    console.log(`  history   floor ${r.stats.floor} ${r.stats.floorSymbol} | ${r.stats.sales} sales | ${r.stats.owners} owners`);
  } else {
    console.log(`  history   none -- new collection, nothing to measure`);
  }
  console.log('\n  score components');
  for (const c of r.components) {
    const sign = c.points >= 0 ? '+' : '';
    console.log(`    ${sign}${c.points.toFixed(1).padStart(6)}  ${pad(c.name, 14)} ${c.detail}`);
  }
  if (r.flags.length) {
    console.log('\n  WARNINGS');
    for (const f of r.flags) console.log(`    ! ${f}`);
  }
}
