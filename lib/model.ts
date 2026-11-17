// horizon-1 — the token radar's valuation and farm-plan model.
//
// A protocol's "launch" is the token it may one day issue. This model never claims a launch is
// coming: it answers one hypothetical question for every pre-token protocol in the snapshot —
// if this protocol's record stayed exactly as it is, what would a claim on it plausibly be worth?
// The number is the entry's own estimate, derived only from figures the sealed input carries.
//
// THE FORMULA (one function, no name is special-cased)
// ---------------------------------------------------
//   base    = tvl_usd * BASE_RATE
//   growth  = 1 + clamp(change_7d, GROWTH_FLOOR, GROWTH_CAP)/100 * GROWTH_WEIGHT
//   tenure  = TENURE_FLOOR + TENURE_GAIN * (1 - exp(-age_days / TENURE_HALFLIFE))
//   breadth = 1 + BREADTH_WEIGHT * log2(1 + min(chain_count, CHAIN_CAP))
//   implied = max(1, round(base * growth * tenure * breadth))
//
// Why these four terms:
//   * TVL is the capital that has actually trusted the protocol; it anchors the estimate. A flat
//     fraction of TVL is used because the snapshot has no token supply or price to scale by.
//   * Seven-day TVL change is the only momentum signal in the file. Clamping it keeps a single
//     blowout week (or one bad week) from dominating, and the 0/neutral point leaves base intact.
//   * Tenure is "how long it has run with no token", read from the day DefiLlama began tracking the
//     protocol. A long, token-free track record means a larger latent community and more history
//     to inherit, so it lifts the estimate — but the exponential saturates, so a decade is not
//     ten times a year. A missing listed_at uses UNKNOWN_AGE, not zero, so an unknown date is not
//     punished as a brand-new protocol.
//   * Breadth rewards a protocol whose TVL spans several chains: more settlement venues mean a
//     wider potential holder base. It is a small, log-scaled tilt, capped so a chain list cannot
//     outweigh the capital actually committed.
//
// The board is the 40 watchlist slugs (the floor) plus the 160 highest-TVL protocols below that
// floor that record no token — 200 rows. A protocol whose gecko_id or symbol is set trades already
// and is kept out of the ranked board entirely; the dashboard shows such protocols in a separate
// "live token" view with the market's own market cap, never as a launch candidate.

/** One protocol from the sealed snapshot: exactly the ten fields the input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The sealed input document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The tunable constants of horizon-1. */
export interface ModelConstants {
  base_rate: number;
  growth_weight: number;
  growth_floor: number;
  growth_cap: number;
  tenure_floor: number;
  tenure_gain: number;
  tenure_halflife: number;
  unknown_age_days: number;
  breadth_weight: number;
  chain_cap: number;
}

export const MODEL: ModelConstants = {
  base_rate: 0.22,
  growth_weight: 0.55,
  growth_floor: -60,
  growth_cap: 150,
  tenure_floor: 0.8,
  tenure_gain: 0.55,
  tenure_halflife: 500,
  unknown_age_days: 240,
  breadth_weight: 0.06,
  chain_cap: 8,
};

/** The model's public label. */
export const MODEL_VERSION = 'horizon-1';

/** Extra early protocols below the watchlist floor, chosen by TVL. */
export const EARLY_ROWS = 160;

/** Live-token protocols shown in the dashboard's separate market view. */
export const LIVE_ROWS = 24;

/** One farm step: an action with an explicit cost and an explicit timeframe. */
export interface FarmStep {
  action: string;
  cost: string;
  time: string;
}

/** One row of board.json. */
export interface BoardRow {
  slug: string;
  name: string;
  rank: number;
  implied_value_usd: number;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_days: number | null;
  token_status: 'pre-token';
  model_terms: {
    base: number;
    growth: number;
    tenure: number;
    breadth: number;
  };
  farm_steps: string[];
}

/** The compact row the page renders from data.js. */
export interface RadarRow {
  slug: string;
  name: string;
  rank: number;
  implied_value_usd: number;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  age_days: number | null;
  growth: number;
  tenure: number;
  breadth: number;
  farm_steps: string[];
}

/** A protocol that already trades: shown as a fact, never ranked as a launch. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

/** Everything the dashboard needs, written into data.js. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelConstants;
  model_version: string;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  formula: string;
  rows: RadarRow[];
  live: LiveRow[];
}

/** Thrown when the file is not the snapshot this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** Whole days from the fetch date to DefiLlama's first-tracked day. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** Whether the snapshot records no token for this protocol. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.gecko_id === null && p.symbol === null;
}

/** The four multipliers and the implied value, from snapshot figures alone. */
export function valueOf(
  p: SnapshotProtocol,
  asOf: string,
  model: ModelConstants,
): { implied: number; age: number | null; base: number; growth: number; tenure: number; breadth: number } {
  const age = ageDays(asOf, p.listed_at);
  const change = typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : 0;
  const growth = 1 + (clamp(change, model.growth_floor, model.growth_cap) / 100) * model.growth_weight;
  const days = age ?? model.unknown_age_days;
  const tenure = model.tenure_floor + model.tenure_gain * (1 - Math.exp(-clamp(days, 0, 36500) / model.tenure_halflife));
  const chains = Math.min(p.chains.length, model.chain_cap);
  const breadth = 1 + model.breadth_weight * Math.log2(1 + chains);
  const base = p.tvl_usd * model.base_rate;
  const implied = Math.max(1, Math.round(base * growth * tenure * breadth));
  return { implied, age, base, growth, tenure, breadth };
}

/** First chain, or a neutral phrase when DefiLlama names none. */
function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its home chain';
}

/** Approximate one-way gas for a first transaction, by the protocol's first chain. */
function gasOf(p: SnapshotProtocol): number {
  const c = (p.chains[0] ?? '').toLowerCase();
  if (c === 'ethereum' || c === 'ethereum starknet' || c === 'blast' || c === 'arbitrum' || c === 'optimism' || c === 'base') return 6;
  if (c === 'solana' || c === 'near' || c === 'avalanche' || c === 'polygon' || c === 'bsc' || c === 'sui' || c === 'aptos') return 1;
  return 3;
}

/** Position size appropriate to the protocol's TVL tier. */
function capitalOf(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 1_000_000_000) return 400;
  if (p.tvl_usd >= 100_000_000) return 200;
  if (p.tvl_usd >= 20_000_000) return 100;
  return 60;
}

/** Hold window: a younger, unproven protocol earns a longer observation window. */
function holdOf(age: number | null): number {
  if (age === null) return 90;
  if (age < 120) return 120;
  if (age < 365) return 75;
  return 45;
}

/** The category's concrete first position, written for a farmer to follow. */
function primaryAction(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const n = p.name;
  if (/lend|cdp|collateral|credit/.test(c)) return `Supply $${capital} of USDC to ${n}'s lending market on ${chain} and borrow a small amount against it to register two sides of the position.`;
  if (/risk curator|allocator|curator|allocator|yield aggregator/.test(c)) return `Deposit $${capital} of USDC into a ${n} vault on ${chain} and record the share balance the vault issues you.`;
  if (/basis|trading|perp|derivative|options/.test(c)) return `Fund $${capital} of USDC as margin on ${n} on ${chain} and open one small, fully hedged position.`;
  if (/restak|staking|liquid staking/.test(c)) return `Stake $${capital} of the chain's native asset through ${n} on ${chain} and keep the liquid receipt token in the same wallet.`;
  if (/dex|spot|amm|exchange/.test(c)) return `Provide $${capital} of two-sided liquidity to ${n}'s deepest pool on ${chain} and keep the LP position for the full window.`;
  if (/bridge|canonical/.test(c)) return `Bridge $${capital} of USDC to ${chain} through ${n} and then move the funds once more inside its destination app.`;
  if (/stable/.test(c)) return `Mint $${capital} of ${n}'s stable asset on ${chain} from an approved collateral and hold the minted amount.`;
  if (/rwa|treasur|bond/.test(c)) return `Buy or mint $${capital} of ${n}'s tokenised yield asset on ${chain} and hold it to the next distribution date.`;
  if (/insurance|cover/.test(c)) return `Buy $${capital} of cover from ${n} on ${chain} and keep the policy NFT and its expiry date in your log.`;
  if (/chain|infrastructure|layer/.test(c)) return `Delegate $${capital} of the chain's native asset to a ${n} validator on ${chain} and keep the delegation receipt.`;
  if (/payment|transfer/.test(c)) return `Route $${capital} through ${n}'s payment rail on ${chain} to a second wallet you control and back, leaving a transaction trail.`;
  if (/governance|incentive/.test(c)) return `Lock $${capital} of the governance asset through ${n} on ${chain} and cast one vote on a live proposal.`;
  return `Deposit $${capital} of USDC into ${n} on ${chain} and keep the position receipt in the same wallet.`;
}

/** A concrete, costed, timed farm plan derived from the protocol's own record. */
export function farmSteps(p: SnapshotProtocol, age: number | null): FarmStep[] {
  const chain = chainOf(p);
  const capital = capitalOf(p);
  const gas = gasOf(p);
  const hold = holdOf(age);
  return [
    {
      action: `Open one dedicated wallet for ${p.name}; fund it with about $${gas * 2} of ${chain === 'its home chain' ? 'native' : chain} gas and keep its recovery phrase offline.`,
      cost: `about $${gas * 2} of gas`,
      time: '5 minutes to set up',
    },
    {
      action: primaryAction(p, capital, chain),
      cost: `$${capital} of capital plus about $${gas} of gas`,
      time: '15 to 30 minutes',
    },
    {
      action: `Return once a week and make one more on-chain action — a top-up, a small swap, a borrow or a governance vote — so the wallet shows repeated use rather than a single deposit.`,
      cost: `about $${gas} of gas a week`,
      time: '10 minutes a week',
    },
    {
      action: `Leave the position untouched for at least ${hold} days so the wallet is present in more than one weekly accounting snapshot; ${age === null ? 'no listing date is recorded, so allow the full window' : `DefiLlama first tracked this protocol ${age} days before the snapshot`}.`,
      cost: `$${capital} stays committed`,
      time: `${hold} days`,
    },
    {
      action: `Check ${p.name}'s own points or rewards page before withdrawing, and claim only through a link that page publishes — never through a message or a private reply.`,
      cost: 'nothing to check; do not pay to claim',
      time: '10 minutes',
    },
    {
      action: `Record the wallet address, the first and last transaction dates, the gas spent and the final position in a farm log so the whole campaign can be repeated or unwound.`,
      cost: 'no chain cost',
      time: '10 minutes',
    },
  ];
}

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** A step as one gate-legal string: action, then its cost and time. */
export function stepText(step: FarmStep): string {
  let s = `${step.action} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Keep the position and review the protocol's own page.`;
  return s;
}

function slugCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The board: watchlist floor plus the top early protocols, scored and ranked 1..n. */
export function buildBoard(snapshot: Snapshot, model: ModelConstants = MODEL): BoardRow[] {
  const index = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const chosen = new Map<string, SnapshotProtocol>();
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined && isPreToken(p)) chosen.set(slug, p);
  }
  const early = snapshot.protocols
    .filter((p) => !chosen.has(p.slug) && isPreToken(p) && p.tvl_usd < snapshot.floor_usd)
    .sort((a, b) => b.tvl_usd - a.tvl_usd || slugCompare(a.slug, b.slug))
    .slice(0, EARLY_ROWS);
  for (const p of early) chosen.set(p.slug, p);

  const scored = [...chosen.values()].map((p) => ({ p, v: valueOf(p, snapshot.as_of, model) }));
  scored.sort((a, b) => b.v.implied - a.v.implied || slugCompare(a.p.slug, b.p.slug));

  return scored.map((s, i) => ({
    slug: s.p.slug,
    name: s.p.name,
    rank: i + 1,
    implied_value_usd: s.v.implied,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    listed_at: s.p.listed_at,
    age_days: s.v.age,
    token_status: 'pre-token',
    model_terms: {
      base: round4(s.v.base),
      growth: round4(s.v.growth),
      tenure: round4(s.v.tenure),
      breadth: round4(s.v.breadth),
    },
    farm_steps: farmSteps(s.p, s.v.age).map(stepText),
  }));
}

/** Live-token protocols, by market cap, for the page's separate market view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p))
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
    }));
}

const FORMULA =
  'implied = max(1, round( tvl_usd x 0.22 x (1 + clamp(change_7d, -60, 150)/100 x 0.55)' +
  ' x (0.80 + 0.55 x (1 - exp(-age/500))) x (1 + 0.06 x log2(1 + chains)) ))';

/** Build the board and the page's compact dataset together, from one snapshot. */
export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData } {
  const board = buildBoard(snapshot, model);
  const live = liveRows(snapshot);
  const watch = new Set(snapshot.watchlist);
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model,
    model_version: MODEL_VERSION,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: board.filter((r) => !watch.has(r.slug)).length,
    live_size: live.length,
    formula: FORMULA,
    rows: board.map((r) => ({
      slug: r.slug,
      name: r.name,
      rank: r.rank,
      implied_value_usd: r.implied_value_usd,
      category: r.category,
      chains: r.chains,
      tvl_usd: r.tvl_usd,
      change_7d: r.change_7d,
      age_days: r.age_days,
      growth: r.model_terms.growth,
      tenure: r.model_terms.tenure,
      breadth: r.model_terms.breadth,
      farm_steps: r.farm_steps,
    })),
    live,
  };
  return { board, radar };
}

/** Data for the page as one script; no fetch, no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}

/** A local mirror of the gate's board checks, so a bad board never reaches /output. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  if (board.length < 100 || board.length > 4000) return `board holds ${board.length} rows`;
  const seen = new Set<string>();
  for (const r of board) {
    if (seen.has(r.slug)) return `slug ${r.slug} appears twice`;
    seen.add(r.slug);
    if (!snapshot.protocols.some((p) => p.slug === r.slug)) return `slug ${r.slug} is not in the snapshot`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0 || r.implied_value_usd > 100_000_000_000_000) return `${r.slug} has implied value ${r.implied_value_usd}`;
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) if (s.length < 20 || s.length > 600) return `${r.slug} has a ${s.length}-character farm step`;
  }
  const missing = snapshot.watchlist.filter((s) => !seen.has(s));
  if (missing.length > 0) return `board misses ${missing.length} watchlist slugs: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `rank ${i + 1} outvalues rank ${i}`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) return 'every row shares one implied value';
  return null;
}

/** Parse and validate the sealed snapshot. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not an object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist');
  const protocols: SnapshotProtocol[] = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`protocol ${i} lacks a slug, name or TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return { as_of: o.as_of, source: o.source, floor_usd: o.floor_usd, protocols, watchlist: o.watchlist as string[] };
}
