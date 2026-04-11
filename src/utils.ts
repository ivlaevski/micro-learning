import type { MicroLearningConfig } from './types';

const STATUS_ID = 'status';
const LOG_ID = 'event-log';

export function setStatus(message: string): void {
  // eslint-disable-next-line no-console
  console.log('[micro-learning:status]', message);
  const el = document.getElementById(STATUS_ID);
  if (el) {
    el.textContent = message;
  }
}

export function appendEventLog(message: string): void {
  // eslint-disable-next-line no-console
  console.log('[micro-learning:log]', message);
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
    appendEventLog(`[unhandledrejection] ${detail}`);
  });

  const origError = console.error.bind(console);
  // eslint-disable-next-line no-console
  console.error = (...args: unknown[]) => {
    origError(...args);
    appendEventLog(`[console.error] ${formatConsoleArgs(args)}`);
  };
}

export function loadConfigFromLocalStorage(): MicroLearningConfig {
  return {
    openAiApiKey: localStorage.getItem('micro-learning:openai-key') ?? '',
    elevenLabsApiKey: localStorage.getItem('micro-learning:elevenlabs-key') ?? '',
  };
}

export function saveConfigToLocalStorage(config: MicroLearningConfig): void {
  localStorage.setItem('micro-learning:openai-key', config.openAiApiKey.trim());
  localStorage.setItem('micro-learning:elevenlabs-key', config.elevenLabsApiKey.trim());
}

export function loadTopicsFromLocalStorage(): string[] {
  const raw = localStorage.getItem('micro-learning:topics') ?? '';
  return raw
    .split('\n')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

export function saveTopicsToLocalStorage(topics: string[]): void {
  const normalized = topics.map((value) => value.trim()).filter((value) => value.length > 0);
  localStorage.setItem('micro-learning:topics', normalized.join('\n'));
}

const LEARNING_SCORE_KEY = 'micro-learning:learning-score';

export function loadLearningScore(): number {
  try {
    const raw = localStorage.getItem(LEARNING_SCORE_KEY);
    if (!raw) return 0;
    const n = Number(raw);
    return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
  } catch {
    return 0;
  }
}

export function saveLearningScore(score: number): void {
  const n = Math.max(0, Math.floor(score));
  localStorage.setItem(LEARNING_SCORE_KEY, String(n));
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
