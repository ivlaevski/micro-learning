import { waitForEvenAppBridge } from '@evenrealities/even_hub_sdk';

import { MicroLearningClient } from './even-client';
import { primeSharedPlaybackAudioFromUserGesture } from './phone-audio';
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

let client: MicroLearningClient | null = null;

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

function bootReadAloudStartBanner(): void {
  const section = document.getElementById('phone-audio-start-banner');
  const unlockStart = document.getElementById('audio-unlock-test-start') as HTMLButtonElement | null;
  const dismissBtn = document.getElementById('phone-audio-start-banner-dismiss') as HTMLButtonElement | null;
  if (!section || !unlockStart || !dismissBtn) return;

  try {
    if (localStorage.getItem(READ_ALOUD_START_BANNER_DISMISS_KEY) === '1') {
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
    try {
      localStorage.setItem(READ_ALOUD_START_BANNER_DISMISS_KEY, '1');
    } catch {
      /* ignore */
    }
    section.setAttribute('hidden', '');
  });
}

function bootTopicsAndSettingsUi(): void {
  const openAiKeyInput = document.getElementById('openai-key') as HTMLInputElement | null;
  const elevenKeyInput = document.getElementById('elevenlabs-key') as HTMLInputElement | null;
  const saveBtn = document.getElementById('save-settings') as HTMLButtonElement | null;
  const newTopicInput = document.getElementById('new-topic') as HTMLInputElement | null;
  const topicsListEl = document.getElementById('topics-list');
  const topicsAddBtn = document.getElementById('topics-add') as HTMLButtonElement | null;
  const topicsDeleteBtn = document.getElementById('topics-delete') as HTMLButtonElement | null;
  const topicsSaveBtn = document.getElementById('topics-save') as HTMLButtonElement | null;

  const cfg = loadConfigFromLocalStorage();
  if (openAiKeyInput) openAiKeyInput.value = cfg.openAiApiKey;
  if (elevenKeyInput) elevenKeyInput.value = cfg.elevenLabsApiKey;

  let topics = loadTopicsFromLocalStorage();

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

  renderTopicsList();

  saveBtn?.addEventListener('click', () => {
    saveConfigToLocalStorage({
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
    if (!topics.includes(value)) {
      topics = [...topics, value];
      saveTopicsToLocalStorage(topics);
      client?.reloadTopicsFromStorage();
      renderTopicsList();
      appendEventLog(`Topic added: ${value}`);
    }
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
      saveTopicsToLocalStorage(topics);
      client?.reloadTopicsFromStorage();
      renderTopicsList();
      appendEventLog(`Topic deleted: ${removed}`);
      setStatus(`Deleted topic: ${removed}`);
    }
  });

  topicsSaveBtn?.addEventListener('click', () => {
    saveTopicsToLocalStorage(topics);
    client?.reloadTopicsFromStorage();
    appendEventLog('Topics list saved.');
    setStatus('Topics saved. They appear on the glasses under “List of topics”.');
  });
}

async function main(): Promise<void> {
  installGlobalErrorLogging();
  setStatus('Booting…');
  bootReadAloudStartBanner();
  bootTopicsAndSettingsUi();

  try {
    appendEventLog('Connecting to Even bridge…');
    const bridge = await waitForEvenAppBridge();
    client = new MicroLearningClient(bridge);
    await client.init();
    appendEventLog('Micro Learning client initialised.');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setStatus(`Bridge not available: ${message}\n\nRunning in browser-only mode (phone UI still works).`);
    appendEventLog(`Bridge connection failed: ${message}`);
  }
}

void main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error('[micro-learning] boot failed', error);
  setStatus('App boot failed');
});
