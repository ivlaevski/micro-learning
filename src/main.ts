import { waitForEvenAppBridge, type EvenAppBridge } from '@evenrealities/even_hub_sdk';

import { MicroLearningClient } from './even-client';
import {
  PHONE_AUDIO_INPUT_KEY,
  PHONE_AUDIO_OUTPUT_KEY,
  phoneAudioOutputSupportsSink,
  primeSharedPlaybackAudioFromUserGesture,
  setPhoneAudioStorageBridge,
} from './phone-audio';
import { introduceTopicWithCards } from './topic-pipeline';
import {
  appendEventLog,
  installGlobalErrorLogging,
  loadConfigFromLocalStorage,
  saveConfigToLocalStorage,
  setStatus,
  loadTopicsFromLocalStorage,
  saveTopicsToLocalStorage,
} from './utils';

const READ_ALOUD_START_BANNER_DISMISS_KEY = 'micro-learning:hide-read-aloud-start-banner';

declare global {
  interface Window {
    __microLearningSetTheme?: (theme: string) => void;
    __microLearningGetTheme?: () => string;
    __microLearningRefreshDashboard?: () => void;
  }
}

let client: MicroLearningClient | null = null;
let storageBridge: EvenAppBridge | null = null;

async function getStorageValue(key: string): Promise<string> {
  if (storageBridge) return (await storageBridge.getLocalStorage(key)) ?? '';
  try {
    return localStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
}

async function setStorageValue(key: string, value: string): Promise<void> {
  if (storageBridge) {
    await storageBridge.setLocalStorage(key, value);
    return;
  }
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore storage errors */
  }
}

async function runPhoneAudioUnlockFromUserClick(): Promise<void> {
  try {
    const htmlOk = await primeSharedPlaybackAudioFromUserGesture();
    const AC =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (AC) {
      const ctx = new AC();
      await ctx.resume();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      gain.gain.value = 0.07;
      osc.type = 'sine';
      osc.frequency.value = 880;
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.12);
    }
    if (htmlOk) {
      setStatus('Phone audio: unlock OK (tap again if playback stops working).');
      appendEventLog('Phone audio: HTMLAudioElement + Web Audio unlock OK.');
    } else {
      setStatus('Phone audio: Web Audio OK; HTMLAudioElement prime may have been blocked — try again.');
      appendEventLog('Phone audio: HTMLAudioElement prime failed.');
    }
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    setStatus(`Phone audio test: ${m}`);
    appendEventLog(`Phone audio test failed: ${m}`);
  }
}

async function bootReadAloudStartBanner(): Promise<void> {
  const section = document.getElementById('phone-audio-start-banner');
  const unlockStart = document.getElementById('audio-unlock-test-start') as HTMLButtonElement | null;
  const dismissBtn = document.getElementById('phone-audio-start-banner-dismiss') as HTMLButtonElement | null;
  if (!section || !unlockStart || !dismissBtn) return;

  try {
    if ((await getStorageValue(READ_ALOUD_START_BANNER_DISMISS_KEY)) === '1') {
      section.setAttribute('hidden', '');
    } else {
      section.removeAttribute('hidden');
    }
  } catch {
    section.removeAttribute('hidden');
  }

  unlockStart.addEventListener('click', () => {
    void runPhoneAudioUnlockFromUserClick();
  });

  dismissBtn.addEventListener('click', () => {
    void setStorageValue(READ_ALOUD_START_BANNER_DISMISS_KEY, '1');
    section.setAttribute('hidden', '');
  });
}

function bootPhoneAudioUi(): () => Promise<void> {
  const infoEl = document.getElementById('audio-device-info');
  const outputSel = document.getElementById('audio-output-select') as HTMLSelectElement | null;
  const inputSel = document.getElementById('audio-input-select') as HTMLSelectElement | null;
  const unlockBtn = document.getElementById('audio-unlock-test') as HTMLButtonElement | null;
  const refreshBtn = document.getElementById('audio-refresh-devices') as HTMLButtonElement | null;
  const sinkNote = document.getElementById('audio-sink-support-note');

  if (!infoEl || !outputSel || !inputSel || !unlockBtn || !refreshBtn) {
    return async () => {
      /* no-op */
    };
  }

  if (sinkNote) {
    sinkNote.textContent = phoneAudioOutputSupportsSink()
      ? 'Output selection is supported here. '
      : 'Output device picker not supported in this browser — playback uses the system default. ';
  }

  const refreshAudioDeviceUi = async (): Promise<void> => {
    if (!navigator.mediaDevices?.enumerateDevices) {
      infoEl.textContent =
        'navigator.mediaDevices is unavailable in this WebView — cannot list inputs/outputs.';
      return;
    }

    let list = await navigator.mediaDevices.enumerateDevices();

    const needLabels = list.some((d) => !d.label);
    if (needLabels) {
      infoEl.textContent =
        'Requesting one-time microphone access so the browser can show device names (phone mic, not G2)…';
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach((t) => t.stop());
        list = await navigator.mediaDevices.enumerateDevices();
      } catch {
        infoEl.textContent =
          'Permission denied or unavailable — listing devices without friendly names.';
      }
    }

    const lines = list.map(
      (d) => `${d.kind}: ${d.label || '(no label)'} — ${d.deviceId.slice(0, 16)}…`,
    );
    infoEl.textContent = lines.length ? lines.join('\n') : 'No media devices reported.';

    const savedOut = await getStorageValue(PHONE_AUDIO_OUTPUT_KEY);
    const savedIn = await getStorageValue(PHONE_AUDIO_INPUT_KEY);

    if (phoneAudioOutputSupportsSink()) {
      outputSel.disabled = false;
      const outs = list.filter((d) => d.kind === 'audiooutput');
      outputSel.innerHTML = '<option value="">Default (system routing)</option>';
      for (const d of outs) {
        const opt = document.createElement('option');
        opt.value = d.deviceId;
        opt.textContent = d.label || `Output ${d.deviceId.slice(0, 8)}…`;
        outputSel.appendChild(opt);
      }
      outputSel.value = outs.some((d) => d.deviceId === savedOut) ? savedOut : '';
    } else {
      outputSel.disabled = true;
      outputSel.innerHTML =
        '<option value="">System default (no setSinkId in this browser)</option>';
    }

    const ins = list.filter((d) => d.kind === 'audioinput');
    inputSel.innerHTML =
      '<option value="">(Informational — not used for G2 capture in this app)</option>';
    for (const d of ins) {
      const opt = document.createElement('option');
      opt.value = d.deviceId;
      opt.textContent = d.label || `Input ${d.deviceId.slice(0, 8)}…`;
      inputSel.appendChild(opt);
    }
    inputSel.value = ins.some((d) => d.deviceId === savedIn) ? savedIn : '';
  };

  outputSel.addEventListener('change', () => {
    const v = outputSel.value.trim();
    void (async () => {
      await setStorageValue(PHONE_AUDIO_OUTPUT_KEY, v);
      appendEventLog(`Phone audio: playback output ${v ? 'set' : 'cleared (system default)'}.`);
    })();
  });

  inputSel.addEventListener('change', () => {
    const v = inputSel.value.trim();
    void (async () => {
      await setStorageValue(PHONE_AUDIO_INPUT_KEY, v);
      appendEventLog('Phone audio: stored mic selection (informational).');
    })();
  });

  unlockBtn.addEventListener('click', () => {
    void runPhoneAudioUnlockFromUserClick();
  });

  refreshBtn.addEventListener('click', () => {
    void refreshAudioDeviceUi();
  });

  if (navigator.mediaDevices?.addEventListener) {
    navigator.mediaDevices.addEventListener('devicechange', () => {
      void refreshAudioDeviceUi();
    });
  }

  void refreshAudioDeviceUi();
  return refreshAudioDeviceUi;
}

/** Wires dashboard settings/topics UI and returns a function to re-apply stored values (e.g. after bridge connects). */
async function setupTopicsAndSettingsUi(): Promise<() => Promise<void>> {
  const openAiKeyInput = document.getElementById('openai-key') as HTMLInputElement | null;
  const elevenKeyInput = document.getElementById('elevenlabs-key') as HTMLInputElement | null;
  const saveBtn = document.getElementById('save-settings') as HTMLButtonElement | null;
  const newTopicInput = document.getElementById('new-topic') as HTMLInputElement | null;
  const topicsListEl = document.getElementById('topics-list');
  const topicsAddBtn = document.getElementById('topics-add') as HTMLButtonElement | null;
  const topicsDeleteBtn = document.getElementById('topics-delete') as HTMLButtonElement | null;
  const topicsSaveBtn = document.getElementById('topics-save') as HTMLButtonElement | null;

  let topics: string[] = [];

  const renderTopicsList = (): void => {
    if (!topicsListEl) return;
    topicsListEl.innerHTML = '';
    topics.forEach((topic, index) => {
      const li = document.createElement('li');
      li.textContent = topic;
      li.dataset.index = String(index);
      li.addEventListener('click', () => {
        if (!topicsListEl) return;
        topicsListEl.querySelectorAll('li').forEach((child) => child.classList.remove('selected'));
        li.classList.add('selected');
      });
      topicsListEl.appendChild(li);
    });
  };

  const applyConfigAndTopicsFromStorage = async (): Promise<void> => {
    const cfg = await loadConfigFromLocalStorage(storageBridge);
    if (openAiKeyInput) openAiKeyInput.value = cfg.openAiApiKey;
    if (elevenKeyInput) elevenKeyInput.value = cfg.elevenLabsApiKey;
    topics = await loadTopicsFromLocalStorage(storageBridge);
    renderTopicsList();
  };

  await applyConfigAndTopicsFromStorage();

  const reloadTopicsFromStorage = async (): Promise<void> => {
    topics = await loadTopicsFromLocalStorage(storageBridge);
    renderTopicsList();
  };

  window.__microLearningRefreshDashboard = () => {
    void reloadTopicsFromStorage();
  };

  saveBtn?.addEventListener('click', () => {
    void saveConfigToLocalStorage(storageBridge, {
      openAiApiKey: openAiKeyInput?.value ?? '',
      elevenLabsApiKey: elevenKeyInput?.value ?? '',
    });
    appendEventLog('Settings saved.');
    setStatus('Settings saved.');
  });

  topicsAddBtn?.addEventListener('click', () => {
    const value = newTopicInput?.value.trim() ?? '';
    if (!value) {
      setStatus('Topic is empty. Type a name first.');
      return;
    }
    if (topics.includes(value)) {
      setStatus('That topic is already in the list.');
      return;
    }
    void (async () => {
      try {
        setStatus('Adding topic and generating learning cards…');
        if (client) {
          await client.showTopicCardsGenerationProgress(value);
        }
        const { cardCount } = await introduceTopicWithCards(storageBridge, value, 'phone-add');
        window.__microLearningRefreshDashboard?.();
        if (client) {
          await client.dismissGeneratingToMainMenu();
        }
        await reloadTopicsFromStorage();
        appendEventLog(`Topic "${value}": ${cardCount} learning card(s) saved.`);
        setStatus(
          cardCount > 0
            ? `Added "${value}" with ${cardCount} card(s).`
            : `Added "${value}" but no cards were returned — check OpenAI key and prompt output.`,
        );
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        if (client) {
          await client.dismissGeneratingToError(m);
        }
        appendEventLog(`Add topic / cards failed: ${m}`);
        setStatus(`Failed: ${m}`);
      }
    })();
    if (newTopicInput) newTopicInput.value = '';
  });

  topicsDeleteBtn?.addEventListener('click', () => {
    if (!topicsListEl) return;
    const selected = topicsListEl.querySelector('li.selected') as HTMLLIElement | null;
    if (!selected) {
      setStatus('No topic selected to delete.');
      return;
    }
    const index = Number(selected.dataset.index ?? '-1');
    if (index >= 0 && index < topics.length) {
      const removed = topics[index];
      topics = topics.filter((_, i) => i !== index);
      void (async () => {
        await saveTopicsToLocalStorage(storageBridge, topics);
        await client?.reloadTopicsFromStorage();
        renderTopicsList();
        appendEventLog(`Topic deleted: ${removed}`);
        setStatus(`Deleted topic: ${removed}`);
      })();
    }
  });

  topicsSaveBtn?.addEventListener('click', () => {
    void (async () => {
      await saveTopicsToLocalStorage(storageBridge, topics);
      await client?.reloadTopicsFromStorage();
      appendEventLog('Topics list saved.');
      setStatus('Topics saved. They appear on the glasses under “List of topics”.');
    })();
  });

  return applyConfigAndTopicsFromStorage;
}

async function main(): Promise<void> {
  installGlobalErrorLogging();
  setStatus('Booting…');

  const loadingOverlay = document.getElementById('phone-loading-overlay');
  const loadingText = document.getElementById('phone-loading-overlay-text');
  const setLoading = (isVisible: boolean, message?: string): void => {
    if (message && loadingText) loadingText.textContent = message;
    if (!loadingOverlay) return;
    if (isVisible) loadingOverlay.removeAttribute('hidden');
    else loadingOverlay.setAttribute('hidden', '');
  };

  window.addEventListener('micro-learning:theme-changed', (ev: Event) => {
    const custom = ev as CustomEvent<{ theme?: string }>;
    const theme = custom.detail?.theme === 'light' ? 'light' : 'dark';
    void setStorageValue('micro-learning:theme', theme);
  });

  setLoading(true, 'Loading…');

  try {
    await bootReadAloudStartBanner();
    const reloadSettingsFields = await setupTopicsAndSettingsUi();
    const refreshPhoneAudioDevices = bootPhoneAudioUi();

    try {
      appendEventLog('Connecting to Even bridge…');
      const bridge = await waitForEvenAppBridge();
      storageBridge = bridge;
      setPhoneAudioStorageBridge(bridge);
      setLoading(true, 'Loading…');
      await reloadSettingsFields();
      void refreshPhoneAudioDevices();

      const storedTheme = await getStorageValue('micro-learning:theme');
      if (storedTheme) {
        window.__microLearningSetTheme?.(storedTheme);
      } else {
        const currentTheme = window.__microLearningGetTheme?.() ?? 'dark';
        await setStorageValue('micro-learning:theme', currentTheme);
      }

      client = new MicroLearningClient(bridge);
      await client.init();
      appendEventLog('Micro Learning client initialised.');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus(`Bridge not available: ${message}\n\nRunning in browser-only mode (phone UI still works).`);
      appendEventLog(`Bridge connection failed: ${message}`);
    }
  } finally {
    setLoading(false);
  }
}

void main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error('[micro-learning] boot failed', error);
  setStatus('App boot failed');
  document.getElementById('phone-loading-overlay')?.setAttribute('hidden', '');
});
