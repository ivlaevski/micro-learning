import type { EvenAppBridge } from '@evenrealities/even_hub_sdk';

import type { LearningCard, MicroLearningConfig } from './types';

const STATUS_ID = 'status';
const LOG_ID = 'event-log';

export async function getStorageValue(bridge: EvenAppBridge | null, key: string): Promise<string> {
  if (!bridge) {
    // eslint-disable-next-line no-console
    console.warn(`[micro-learning:storage] bridge unavailable for get "${key}"`);
    return '';
  }
  return (await bridge.getLocalStorage(key)) ?? '';
}

export async function setStorageValue(bridge: EvenAppBridge | null, key: string, value: string) {
  if (!bridge) {
    // eslint-disable-next-line no-console
    console.warn(`[micro-learning:storage] bridge unavailable for set "${key}"`);
    return;
  }
  await bridge.setLocalStorage(key, value);
}

export function setStatus(message: string): void {
  const el = document.getElementById(STATUS_ID);
  if (el) {
    el.textContent = message;
  }
}

export function appendEventLog(message: string): void {
  const el = document.getElementById(LOG_ID);
  if (!el) return;
  const now = new Date();
  const ts = now.toISOString().split('T')[1]?.replace('Z', '') ?? '';
  el.textContent = `[${ts}] ${message}\n` + el.textContent;
}

let globalErrorLoggingInstalled = false;

function formatConsoleArgs(parts: unknown[]): string {
  return parts
    .map((p) => {
      if (typeof p === 'string') return p;
      if (p instanceof Error) return p.stack ?? p.message;
      try {
        return JSON.stringify(p);
      } catch {
        return String(p);
      }
    })
    .join(' ');
}

export function installGlobalErrorLogging(): void {
  if (globalErrorLoggingInstalled) return;
  globalErrorLoggingInstalled = true;

  window.addEventListener(
    'error',
    (ev: ErrorEvent) => {
      const loc =
        ev.filename && ev.lineno
          ? ` (${ev.filename}:${ev.lineno}:${ev.colno ?? 0})`
          : '';
      const detail =
        ev.error instanceof Error ? ev.error.stack ?? ev.error.message : ev.message || 'Unknown error';
      appendEventLog(`[window.error]${loc} ${detail}`);
    },
    true,
  );

  window.addEventListener('unhandledrejection', (ev: PromiseRejectionEvent) => {
    const r = ev.reason;
    const detail = r instanceof Error ? r.stack ?? r.message : String(r);
    appendEventLog(`[--] ${detail}`);
  });

  const origError = console.error.bind(console);
  // eslint-disable-next-line no-console
  console.error = (...args: unknown[]) => {
    origError(...args);
    appendEventLog(`[console.error] ${formatConsoleArgs(args)}`);
  };
}

export async function loadConfigFromLocalStorage(bridge: EvenAppBridge | null): Promise<MicroLearningConfig> {
  const [openAiApiKey, elevenLabsApiKey] = await Promise.all([
    getStorageValue(bridge, 'micro-learning:openai-key'),
    getStorageValue(bridge, 'micro-learning:elevenlabs-key'),
  ]);
  return {
    openAiApiKey,
    elevenLabsApiKey,
  };
}

export async function saveConfigToLocalStorage(
  bridge: EvenAppBridge | null,
  config: MicroLearningConfig,
): Promise<void> {
  await Promise.all([
    setStorageValue(bridge, 'micro-learning:openai-key', config.openAiApiKey.trim()),
    setStorageValue(bridge, 'micro-learning:elevenlabs-key', config.elevenLabsApiKey.trim()),
  ]);
}

export async function loadTopicsFromLocalStorage(bridge: EvenAppBridge | null): Promise<string[]> {
  const raw = await getStorageValue(bridge, 'micro-learning:topics');
  return raw
    .split('\n')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

export async function saveTopicsToLocalStorage(
  bridge: EvenAppBridge | null,
  topics: string[],
): Promise<void> {
  const normalized = topics.map((value) => value.trim()).filter((value) => value.length > 0);
  await setStorageValue(bridge, 'micro-learning:topics', normalized.join('\n'));
}

const LEARNING_PROGRESS_DAILY_KEY = 'micro-learning:learning-progress-daily';
const LEGACY_LEARNING_PROGRESS_KEY = 'micro-learning:learning-progress';
const LEGACY_LEARNING_SCORE_KEY = 'micro-learning:learning-score';

export type LearningProgress = {
  cardsShown: number;
  cardsLearned: number;
};

export type DailyProgressEntry = { s: number; l: number };

export type DailyProgressMap = Record<string, DailyProgressEntry>;

function localYmd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function parseYmdLocal(ymd: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/** Monday 00:00 local of the ISO week containing `d`. */
function startOfIsoWeekMonday(d: Date): Date {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setHours(0, 0, 0, 0);
  const day = x.getDay();
  const offset = day === 0 ? -6 : 1 - day;
  x.setDate(x.getDate() + offset);
  return x;
}

/** ISO week number (1–53) for the week containing this local calendar day. */
function isoWeekNumberLocal(dayInWeek: Date): number {
  const d = new Date(dayInWeek.getFullYear(), dayInWeek.getMonth(), dayInWeek.getDate());
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
  const week1 = new Date(d.getFullYear(), 0, 4);
  return (
    1 +
    Math.round(
      ((d.getTime() - week1.getTime()) / 86400000 - 3 + ((week1.getDay() + 6) % 7)) / 7,
    )
  );
}

function pruneDailyProgressOlderThan365Days(map: DailyProgressMap): DailyProgressMap {
  const cutoff = new Date();
  cutoff.setHours(0, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() - 365);
  const out: DailyProgressMap = {};
  for (const [k, v] of Object.entries(map)) {
    const d = parseYmdLocal(k);
    if (!d || d < cutoff) continue;
    out[k] = { s: Math.max(0, Math.floor(v.s)), l: Math.max(0, Math.floor(v.l)) };
  }
  return out;
}

async function loadDailyProgressMap(bridge: EvenAppBridge | null): Promise<DailyProgressMap> {
  const raw = await getStorageValue(bridge, LEARNING_PROGRESS_DAILY_KEY);
  if (!raw) return {};
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    const map: DailyProgressMap = {};
    for (const [k, v] of Object.entries(o)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(k)) continue;
      if (v == null || typeof v !== 'object') continue;
      const row = v as Record<string, unknown>;
      const s = Math.max(0, Math.floor(Number(row.s ?? row.shown) || 0));
      const l = Math.max(0, Math.floor(Number(row.l ?? row.learned) || 0));
      map[k] = { s, l };
    }
    return pruneDailyProgressOlderThan365Days(map);
  } catch {
    return {};
  }
}

async function saveDailyProgressMap(bridge: EvenAppBridge | null, map: DailyProgressMap): Promise<void> {
  const pruned = pruneDailyProgressOlderThan365Days(map);
  await setStorageValue(bridge, LEARNING_PROGRESS_DAILY_KEY, JSON.stringify(pruned));
}

export async function loadLearningProgress(bridge: EvenAppBridge | null): Promise<LearningProgress> {
  const map = await loadDailyProgressMap(bridge);
  if (Object.keys(map).length > 0) {
    let cardsShown = 0;
    let cardsLearned = 0;
    for (const { s, l } of Object.values(map)) {
      cardsShown += s;
      cardsLearned += l;
    }
    return { cardsShown, cardsLearned };
  }
  try {
    const raw = await getStorageValue(bridge, LEGACY_LEARNING_PROGRESS_KEY);
    if (raw) {
      const o = JSON.parse(raw) as { cardsShown?: unknown; cardsLearned?: unknown };
      return {
        cardsShown: Math.max(0, Math.floor(Number(o.cardsShown) || 0)),
        cardsLearned: Math.max(0, Math.floor(Number(o.cardsLearned) || 0)),
      };
    }
  } catch {
    /* fall through */
  }
  try {
    const legacy = await getStorageValue(bridge, LEGACY_LEARNING_SCORE_KEY);
    const n = legacy ? Math.max(0, Math.floor(Number(legacy) || 0)) : 0;
    return { cardsShown: 0, cardsLearned: n };
  } catch {
    return { cardsShown: 0, cardsLearned: 0 };
  }
}

export async function incrementLearningCardsShown(bridge: EvenAppBridge | null): Promise<void> {
  const map = await loadDailyProgressMap(bridge);
  const k = localYmd(new Date());
  const e = map[k] ?? { s: 0, l: 0 };
  e.s += 1;
  map[k] = e;
  await saveDailyProgressMap(bridge, map);
}

export async function incrementLearningCardsLearned(bridge: EvenAppBridge | null): Promise<void> {
  const map = await loadDailyProgressMap(bridge);
  const k = localYmd(new Date());
  const e = map[k] ?? { s: 0, l: 0 };
  e.l += 1;
  map[k] = e;
  await saveDailyProgressMap(bridge, map);
}

/** 7 rows (Mon–Sun) × 10 weeks; each cell 3 chars: ` - `, ` + `, or ` x `. */
export function formatLearningProgressGridDisplay(map: DailyProgressMap): string {
  const LABEL_W = 3;
  const dayLabels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  const cellStr = (shown: number, learned: number): string => {
    if (shown <= 0) return '\u2007\u2007\u2007'; // U+2007 or U+25A2  ... U+2591
    const ratio = learned / shown;
    return ratio >= 0.25 ? '\u2007\u25A3\u2007' : // U+25A3 ... U+2592
                           '\u2007\u25A0\u2007'; // U+25A0 ... U+2588
  };

  const today = new Date();
  const newestMon = startOfIsoWeekMonday(today);

  let header =''; //'Week_'.padStart(5, '_');
  for (let c = 0; c < 15; c++) {
    const mon = new Date(newestMon);
    mon.setDate(mon.getDate() - (14 - c) * 7);
    const wk = isoWeekNumberLocal(mon);
    header += `${String(wk).padStart(2, '_')}_`;
  }
  header += ' - Week#';

  const lines: string[] = [header];

  for (let r = 0; r < 7; r++) {
    let row = ''; //`${dayLabels[r]}_____`.slice(0, 5);
    for (let c = 0; c < 15; c++) {
      const mon = new Date(newestMon);
      mon.setDate(mon.getDate() - (14 - c) * 7 + r);
      const key = localYmd(mon);
      const e = map[key] ?? { s: 0, l: 0 };
      row += cellStr(e.s, e.l);
    }
    row += ` ${dayLabels[r]}`;
    lines.push(row);
  }

  //lines.push('');
  //lines.push(' (=) shown or <25% learned;  (#) 25%+ learned');
  return lines.join('\n');
}

export async function loadLearningProgressGridText(bridge: EvenAppBridge | null): Promise<string> {
  const map = await loadDailyProgressMap(bridge);
  return formatLearningProgressGridDisplay(map);
}

/** @deprecated Use loadLearningProgress; kept for one-off migrations. */
export async function loadLearningScore(bridge: EvenAppBridge | null): Promise<number> {
  const p = await loadLearningProgress(bridge);
  return p.cardsLearned;
}

function base64UrlEncodeUtf8(str: string): string {
  const bytes = new TextEncoder().encode(str.trim());
  let binary = '';
  bytes.forEach((b) => {
    binary += String.fromCharCode(b);
  });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Stable storage key for JSON card arrays keyed by topic title. */
export function topicCardsStorageKey(topic: string): string {
  return `micro-learning:topic-cards:${base64UrlEncodeUtf8(topic)}`;
}

export async function saveLearningCardsForTopic(
  bridge: EvenAppBridge | null,
  topic: string,
  cards: LearningCard[],
): Promise<void> {
  await setStorageValue(bridge, topicCardsStorageKey(topic), JSON.stringify(cards));
}

export async function loadLearningCardsForTopic(
  bridge: EvenAppBridge | null,
  topic: string,
): Promise<LearningCard[]> {
  try {
    const raw = await getStorageValue(bridge, topicCardsStorageKey(topic));
    if (!raw) return [];
    const value = JSON.parse(raw) as unknown;
    return Array.isArray(value) ? (value as LearningCard[]) : [];
  } catch {
    return [];
  }
}

/** Clears stored cards for this topic (same key as saveLearningCardsForTopic). */
export async function deleteLearningCardsForTopic(
  bridge: EvenAppBridge | null,
  topic: string,
): Promise<void> {
  await setStorageValue(bridge, topicCardsStorageKey(topic), '');
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
