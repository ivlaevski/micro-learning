import {
  CreateStartUpPageContainer,
  DeviceConnectType,
  ListContainerProperty,
  ListItemContainerProperty,
  List_ItemEvent,
  OsEventTypeList,
  RebuildPageContainer,
  StartUpPageCreateResult,
  Sys_ItemEvent,
  TextContainerProperty,
  TextContainerUpgrade,
  Text_ItemEvent,
  evenHubEventFromJson,
  type EvenAppBridge,
  type EvenHubEvent,
} from '@evenrealities/even_hub_sdk';

import { synthesizeSpeech } from './api';
import type { LearningCard, LearningCardStatus, ViewName } from './types';
import { introduceTopicWithCards } from './topic-pipeline';
import {
  cancelSttRecording,
  feedSttAudio,
  setSttLiveListener,
  startSttRecording,
  stopSttAndTranscribe,
} from './stt-elevenlabs';
import {
  appendEventLog,
  loadConfigFromLocalStorage,
  loadLearningCardsForTopic,
  loadLearningProgress,
  loadLearningProgressGridText,
  loadTopicsFromLocalStorage,
  saveLearningCardsForTopic,
  setStatus,
  incrementLearningCardsLearned,
  incrementLearningCardsShown,
} from './utils';
import {
  getSharedPlaybackAudio,
  prepareSharedPlaybackFromMp3,
  revokeSharedPlaybackBlobUrl,
} from './phone-audio';

const MAX_CONTENT_LENGTH = 900;
const FULL_SCREEN_TIMER_CONTAINER_ID = 11;
const ML_TOPIC_HINT_CONTAINER_ID = 12;
const ML_TOPIC_GEN_TOPIC_CONTAINER_ID = 1;
const ML_TOPIC_GEN_BODY_CONTAINER_ID = 10;
const ML_CARD_HINT_ID = 20;
const ML_CARD_TITLE_ID = 22;
const ML_CARD_BODY_ID = 23;

function normalizeLearningCardStatus(raw: unknown): LearningCardStatus {
  if (raw === 'new-card' || raw === 'read' || raw === 'learned' || raw === 'hidden' || raw === 'done') {
    return raw;
  }
  return 'new-card';
}

function formatElapsedMmSs(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

type UiState = {
  view: ViewName;
  topics: string[];
};

type CardStudySession = {
  topic: string;
  allCards: LearningCard[];
  visibleStorageIndices: number[];
  cursor: number;
};

type CardStudyMenuAction = 'read-aloud' | 'mark-read' | 'mark-learned' | 'mark-done' | 'back';

export class MicroLearningClient {
  private readonly bridge: EvenAppBridge;
  private isStartupCreated = false;
  private ui: UiState = {
    view: 'main-menu',
    topics: [],
  };
  private cardStudy: CardStudySession | null = null;
  private cardStudyMenuActions: CardStudyMenuAction[] = [];
  private readAloudAborted = false;
  private appMessageAfterDismiss: 'main-menu' | 'topic-card-study' = 'main-menu';
  /** Ignores duplicate hub gestures shortly after a handled tap/scroll (cross-screen echo). */
  private hubGestureCooldownUntilMs = 0;
  private static readonly HUB_GESTURE_COOLDOWN_MS = 900;
  private isTopicVoiceRecording = false;
  private fullScreenTimerInterval: ReturnType<typeof setInterval> | null = null;
  private fullScreenTimerStartedAtMs: number | null = null;
  private topicRecordingHintLine = '';

  constructor(bridge: EvenAppBridge) {
    this.bridge = bridge;
  }

  /** Call after phone saves topics so the next glasses list is fresh. */
  async reloadTopicsFromStorage(): Promise<void> {
    this.ui.topics = await loadTopicsFromLocalStorage(this.bridge);
  }

  async init(): Promise<void> {
    await this.waitForGlassesConnected(12000);
    await this.ensureStartupUi();
    await this.reloadTopicsFromStorage();
    await new Promise((r) => setTimeout(r, 3500));
    await this.renderMainMenu();

    this.bridge.onEvenHubEvent((raw) => {
      const event = this.normalizeIncomingHubEvent(raw);
      void this.onEvenHubEvent(event);
    });
    setStatus('Micro Learning connected. Use glasses to navigate menu.');
  }

  private async waitForGlassesConnected(maxMs: number): Promise<void> {
    const t0 = performance.now();
    let lastLogAt = 0;

    while (performance.now() - t0 < maxMs) {
      const d = await this.bridge.getDeviceInfo();
      const ct = d?.status?.connectType;
      const sn = d?.sn ?? '—';

      if (performance.now() - t0 - lastLogAt >= 1500) {
        appendEventLog(
          `[startup] device poll: connectType=${String(ct)} sn=${sn} (+${(performance.now() - t0).toFixed(0)}ms)`,
        );
        lastLogAt = performance.now() - t0;
      }

      if (ct === DeviceConnectType.Connected) {
        appendEventLog(`[startup] glasses Connected after ${(performance.now() - t0).toFixed(0)}ms`);
        return;
      }

      await new Promise((r) => setTimeout(r, 350));
    }

    appendEventLog(
      `[startup] still not Connected after ${maxMs}ms — continuing anyway (simulator / WebView may omit status)`,
    );
  }

  private async ensureStartupUi(): Promise<void> {
    if (this.isStartupCreated) return;

    const title = new TextContainerProperty({
      containerID: 1,
      containerName: 'title',
      xPosition: 20,
      yPosition: 40,
      width: 300,
      height: 140,
      borderWidth: 0,
      borderColor: 5,
      borderRadius: 0,
      paddingLength: 2,
      content: 'Micro Learning\n---------------------------\nProductivity wherever you go',
      isEventCapture: 0,
    });

    const hint = new TextContainerProperty({
      containerID: 2,
      containerName: 'hint',
      xPosition: 20,
      yPosition: 200,
      width: 300,
      height: 40,
      borderWidth: 0,
      borderColor: 5,
      borderRadius: 0,
      paddingLength: 2,
      content: 'Wait application to load...',
      isEventCapture: 1,
    });

    const container = new CreateStartUpPageContainer({
      containerTotalNum: 2,
      textObject: [title, hint],
    });

    const result = await this.bridge.createStartUpPageContainer(container);

    if (result === 0) {
      this.isStartupCreated = true;
      return;
    }

    appendEventLog(
      `createStartUpPageContainer code=${result} (${StartUpPageCreateResult.normalize(result)}); startup may still work on device`,
    );
  }

  private sanitizeForDisplay(text: string, maxLength: number = MAX_CONTENT_LENGTH): string {
    return text.slice(0, maxLength);
  }

  private async applyRebuildPageContainer(payload: RebuildPageContainer): Promise<boolean> {
    this.stopFullScreenTimer();
    return this.bridge.rebuildPageContainer(payload);
  }

  private stopFullScreenTimer(): void {
    if (this.fullScreenTimerInterval != null) {
      window.clearInterval(this.fullScreenTimerInterval);
      this.fullScreenTimerInterval = null;
    }
    this.fullScreenTimerStartedAtMs = null;
  }

  private startFullScreenTimer(): void {
    this.stopFullScreenTimer();
    this.fullScreenTimerStartedAtMs = Date.now();
    this.fullScreenTimerInterval = window.setInterval(() => {
      void this.refreshFullScreenTimerLabel();
    }, 1000);
  }

  private async refreshFullScreenTimerLabel(): Promise<void> {
    if (this.fullScreenTimerStartedAtMs == null) return;
    const sec = Math.floor((Date.now() - this.fullScreenTimerStartedAtMs) / 1000);
    const label = formatElapsedMmSs(sec);
    try {
      await this.bridge.textContainerUpgrade(
        new TextContainerUpgrade({
          containerID: FULL_SCREEN_TIMER_CONTAINER_ID,
          containerName: 'ftimer',
          contentOffset: 0,
          contentLength: 32,
          content: label,
        }),
      );
    } catch {
      /* view replaced */
    }
  }

  private clearTopicRecordingUi(): void {
    this.stopFullScreenTimer();
    setSttLiveListener(null);
    this.topicRecordingHintLine = '';
  }

  private onTopicSttLive(payload: { totalBytes: number; approxDurationMs: number }): void {
    if (payload.totalBytes <= 0) {
      this.topicRecordingHintLine = '';
    } else if (payload.totalBytes < 3200) {
      this.topicRecordingHintLine = 'Receiving audio…';
    } else {
      const sec = (payload.approxDurationMs / 1000).toFixed(1);
      this.topicRecordingHintLine = `~${sec}s buffered`;
    }
    void this.refreshTopicRecordingHint();
  }

  private async refreshTopicRecordingHint(): Promise<void> {
    if (this.ui.view !== 'topic-recording') return;
    const lines = ['Speak your new topic clearly.', ''];
    if (this.topicRecordingHintLine) lines.push(this.topicRecordingHintLine);
    const text = this.sanitizeForDisplay(lines.join('\n'), MAX_CONTENT_LENGTH);
    try {
      await this.bridge.textContainerUpgrade(
        new TextContainerUpgrade({
          containerID: ML_TOPIC_HINT_CONTAINER_ID,
          containerName: 'ml-topic-hint',
          contentOffset: 0,
          contentLength: MAX_CONTENT_LENGTH,
          content: text,
        }),
      );
    } catch {
      /* view replaced */
    }
  }

  private async showTopicRecordingScreen(): Promise<void> {
    this.topicRecordingHintLine = '';
    const infoTextOverlay = new TextContainerProperty({
      containerID: 1,
      containerName: 'finfotext',
      xPosition: 8,
      yPosition: 0,
      width: 420,
      height: 32,
      borderWidth: 1,
      borderColor: 5,
      borderRadius: 2,
      paddingLength: 1,
      content: '[Tab=stop][DTab=cancel]',
      isEventCapture: 0,
    });
    const timerOverlay = new TextContainerProperty({
      containerID: FULL_SCREEN_TIMER_CONTAINER_ID,
      containerName: 'ftimer',
      xPosition: 432,
      yPosition: 0,
      width: 132,
      height: 32,
      borderWidth: 0,
      borderColor: 5,
      borderRadius: 0,
      paddingLength: 0,
      content: formatElapsedMmSs(0),
      isEventCapture: 0,
    });
    const hintBlock = new TextContainerProperty({
      containerID: ML_TOPIC_HINT_CONTAINER_ID,
      containerName: 'ml-topic-hint',
      xPosition: 10,
      yPosition: 40,
      width: 556,
      height: 240,
      borderWidth: 0,
      borderColor: 5,
      borderRadius: 0,
      paddingLength: 0,
      content: this.sanitizeForDisplay('Speak your new topic clearly.\n\nAudio is sent to ElevenLabs for transcription.', MAX_CONTENT_LENGTH),
      isEventCapture: 1,
    });

    const ok = await this.applyRebuildPageContainer(
      new RebuildPageContainer({
        containerTotalNum: 3,
        textObject: [infoTextOverlay, timerOverlay, hintBlock],
      }),
    );
    if (ok) {
      this.startFullScreenTimer();
      setStatus('Recording new topic on glasses…');
    } else {
      appendEventLog('Failed to show topic recording screen');
    }
  }

  /** Glasses progress UI while OpenAI builds cards (voice flow or phone-initiated when connected). */
  private async showTopicGeneratingScreen(topicLabel: string): Promise<void> {
    const trimmed = topicLabel.trim();
    const topicDisplay = this.sanitizeForDisplay(trimmed || '(empty)', 480);

    const topicBlock = new TextContainerProperty({
      containerID: ML_TOPIC_GEN_TOPIC_CONTAINER_ID,
      containerName: 'ml-gen-topic',
      xPosition: 10,
      yPosition: 4,
      width: 404,
      height: 88,
      borderWidth: 0,
      borderColor: 5,
      borderRadius: 0,
      paddingLength: 0,
      content: this.sanitizeForDisplay(`Topic\n${topicDisplay}`, MAX_CONTENT_LENGTH),
      isEventCapture: 0,
    });

    const timerOverlay = new TextContainerProperty({
      containerID: FULL_SCREEN_TIMER_CONTAINER_ID,
      containerName: 'ftimer',
      xPosition: 424,
      yPosition: 4,
      width: 140,
      height: 36,
      borderWidth: 0,
      borderColor: 5,
      borderRadius: 0,
      paddingLength: 0,
      content: formatElapsedMmSs(0),
      isEventCapture: 0,
    });

    const bodyBlock = new TextContainerProperty({
      containerID: ML_TOPIC_GEN_BODY_CONTAINER_ID,
      containerName: 'ml-gen-body',
      xPosition: 10,
      yPosition: 98,
      width: 556,
      height: 182,
      borderWidth: 0,
      borderColor: 5,
      borderRadius: 0,
      paddingLength: 0,
      content: this.sanitizeForDisplay(
        'Generating learning cards…\n\n' +
        'OpenAI is building up to 19 cards for this topic. ' +
        'They will be saved on your phone when ready.\n\n' +
        'Please wait.',
        MAX_CONTENT_LENGTH,
      ),
      isEventCapture: 0,
    });

    const ok = await this.applyRebuildPageContainer(
      new RebuildPageContainer({
        containerTotalNum: 3,
        textObject: [topicBlock, timerOverlay, bodyBlock],
      }),
    );
    if (ok) {
      this.ui.view = 'topic-generating-cards';
      this.startFullScreenTimer();
      setStatus(`Generating cards for: ${trimmed.slice(0, 72)}${trimmed.length > 72 ? '…' : ''}`);
    } else {
      appendEventLog('Failed to show card-generation progress on glasses');
    }
  }

  /** Call from phone UI when adding a topic so glasses show the same progress screen. */
  async showTopicCardsGenerationProgress(topicLabel: string): Promise<void> {
    await this.showTopicGeneratingScreen(topicLabel);
  }

  async dismissGeneratingToMainMenu(): Promise<void> {
    this.stopFullScreenTimer();
    await this.reloadTopicsFromStorage();
    await this.renderMainMenu();
  }

  async dismissGeneratingToError(message: string): Promise<void> {
    this.stopFullScreenTimer();
    await this.showAppMessage(`Could not save topic or cards.\n\n${message}`, '[Tab=back]');
  }

  private async toggleTopicVoiceRecording(): Promise<void> {
    const cfg = await loadConfigFromLocalStorage(this.bridge);
    if (!cfg.elevenLabsApiKey?.trim()) {
      await this.showAppMessage(
        'ElevenLabs API key missing.\n\nSet it under Settings on the phone, then try again.',
        '[Tab=back]',
      );
      return;
    }

    if (!this.isTopicVoiceRecording) {
      try {
        this.ui.view = 'topic-recording';
        await this.showTopicRecordingScreen();
        setSttLiveListener((p) => this.onTopicSttLive(p));
        await startSttRecording(this.bridge);
        this.isTopicVoiceRecording = true;
        setStatus('Listening for new topic… Tab on glasses to stop.');
      } catch (error) {
        this.clearTopicRecordingUi();
        this.isTopicVoiceRecording = false;
        const message = error instanceof Error ? error.message : String(error);
        await this.showAppMessage(`Could not start recording.\n\n${message}`, '[Tab=back]');
      }
      return;
    }

    try {
      this.clearTopicRecordingUi();
      const transcript = await stopSttAndTranscribe(cfg.elevenLabsApiKey);
      this.isTopicVoiceRecording = false;

      if (!transcript.trim()) {
        await this.showAppMessage(
          'No speech captured.\n\nSpeak a bit longer and try again.',
          '[Tab=back]',
        );
        return;
      }

      await this.completeNewTopicFromTranscript(transcript);
    } catch (error) {
      this.isTopicVoiceRecording = false;
      const message = error instanceof Error ? error.message : String(error);
      await this.showAppMessage(`Transcription failed.\n\n${message}`, '[Tab=back]');
    }
  }

  private async completeNewTopicFromTranscript(transcript: string): Promise<void> {
    await this.showTopicGeneratingScreen(transcript);
    try {
      const { addedToList, cardCount } = await introduceTopicWithCards(this.bridge, transcript, 'glasses-voice');
      appendEventLog(
        `Voice topic: "${transcript.slice(0, 80)}${transcript.length > 80 ? '…' : ''}" — ${cardCount} card(s)${addedToList ? ' (new on list)' : ''}.`,
      );
      (window as unknown as { __microLearningRefreshDashboard?: () => void }).__microLearningRefreshDashboard?.();
      this.stopFullScreenTimer();
      await this.reloadTopicsFromStorage();
      await this.renderMainMenu();
      setStatus(`Saved ${cardCount} learning card(s). Open topics on the phone to see the list.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      appendEventLog(`Topic/cards pipeline failed: ${message}`);
      await this.dismissGeneratingToError(message);
    }
  }

  private async showAppMessage(
    body: string,
    info = '[Tab=back]',
    afterDismiss: 'main-menu' | 'topic-card-study' = 'main-menu',
  ): Promise<void> {
    this.appMessageAfterDismiss = afterDismiss;
    this.ui.view = 'app-message';
    const contentText = this.sanitizeForDisplay(body.slice(0, MAX_CONTENT_LENGTH));
    const bodyEl = new TextContainerProperty({
      containerID: 1,
      containerName: 'body',
      xPosition: 10,
      yPosition: 32,
      width: 556,
      height: 255,
      borderWidth: 0,
      borderColor: 5,
      borderRadius: 0,
      paddingLength: 0,
      content: contentText,
      isEventCapture: 1,
    });
    const infoTextOverlay = new TextContainerProperty({
      containerID: 2,
      containerName: 'finfotext',
      xPosition: 8,
      yPosition: 0,
      width: 556,
      height: 32,
      borderWidth: 1,
      borderColor: 5,
      borderRadius: 2,
      paddingLength: 1,
      content: info,
      isEventCapture: 0,
    });
    const ok = await this.applyRebuildPageContainer(
      new RebuildPageContainer({
        containerTotalNum: 2,
        textObject: [bodyEl, infoTextOverlay],
      }),
    );
    if (!ok) appendEventLog('Failed to show app message on glasses');
  }

  private async renderMainMenu(): Promise<void> {
    this.cardStudy = null;
    this.cardStudyMenuActions = [];

    const list = new ListContainerProperty({
      containerID: 9,
      containerName: 'app-menu',
      xPosition: 5,
      yPosition: 40,
      width: 560,
      height: 130,
      borderWidth: 0,
      borderColor: 5,
      borderRadius: 6,
      paddingLength: 0,
      isEventCapture: 1,
      itemContainer: new ListItemContainerProperty({
        itemCount: 3,
        itemWidth: 550,
        isItemSelectBorderEn: 1,
        itemName: [
          'Record new topic for research',
          'List of topics',
          'Learning progress',
        ],
      }),
    });

    const mainPage = new RebuildPageContainer({
      containerTotalNum: 4,
      textObject: [
        new TextContainerProperty({
          containerID: 1,
          containerName: 'menu-title',
          xPosition: 10,
          yPosition: 5,
          width: 300,
          height: 28,
          borderWidth: 0,
          borderColor: 5,
          paddingLength: 0,
          content: 'Micro Learning',
          isEventCapture: 0,
        }),
        new TextContainerProperty({
          containerID: 2,
          containerName: 'menu-subtitle',
          xPosition: 10,
          yPosition: 220,
          width: 300,
          height: 56,
          borderWidth: 0,
          borderColor: 5,
          paddingLength: 0,
          content: '© 2026 Ivan Vlaevski\nLicensed under the MIT License',
          isEventCapture: 0,
        }),
        new TextContainerProperty({
          containerID: 3,
          containerName: 'menu-footer',
          xPosition: 316,
          yPosition: 248,
          width: 250,
          height: 28,
          content: 'Revolute to @ivanvlaevski',
          isEventCapture: 0,
        }),
      ],
      listObject: [list],
    });

    const success = await this.applyRebuildPageContainer(mainPage);
    if (success) {
      this.ui.view = 'main-menu';
      setStatus('Main menu: tap to choose an option.');
    } else {
      appendEventLog('Failed to create main menu');
    }
  }

  private async renderGlassesTopicList(): Promise<void> {
    await this.reloadTopicsFromStorage();

    if (!this.ui.topics.length) {
      await this.showAppMessage(
        'No topics yet.\n\nAdd topics on the phone, then open this list again.',
        '[Tab=back]',
      );
      return;
    }

    const items = this.ui.topics.map((topic, index) =>
      this.sanitizeForDisplay(`${index + 1}. ${topic}`, 60),
    );
    items.push('<- Back to menu');

    const list = new ListContainerProperty({
      containerID: 8,
      containerName: 'ml-topic-list',
      xPosition: 0,
      yPosition: 0,
      width: 576,
      height: 288,
      borderWidth: 1,
      borderColor: 5,
      borderRadius: 6,
      paddingLength: 4,
      isEventCapture: 1,
      itemContainer: new ListItemContainerProperty({
        itemCount: items.length,
        itemWidth: 560,
        isItemSelectBorderEn: 1,
        itemName: items,
      }),
    });

    const ok = await this.applyRebuildPageContainer(
      new RebuildPageContainer({
        containerTotalNum: 1,
        listObject: [list],
      }),
    );
    if (ok) {
      setStatus('Topics on glasses: tap one or Back.');
      this.ui.view = 'glasses-topic-list';
    } else {
      appendEventLog('Failed to render glasses topic list');
    }
  }

  private recomputeVisibleCardIndices(session: CardStudySession): void {
    session.visibleStorageIndices = session.allCards
      .map((c, i) => ({ c, i }))
      .filter(({ c }) => {
        const s = normalizeLearningCardStatus(c.status);
        return s === 'new-card' || s === 'read' || s === 'learned';
      })
      .map(({ i }) => i);
  }

  private async openTopicCardStudy(topic: string): Promise<void> {
    const raw = await loadLearningCardsForTopic(this.bridge, topic);
    const allCards: LearningCard[] = raw.map((c) => ({
      ...c,
      status: normalizeLearningCardStatus(c.status),
    }));

    const session: CardStudySession = {
      topic,
      allCards,
      visibleStorageIndices: [],
      cursor: 0,
    };
    this.recomputeVisibleCardIndices(session);

    if (!session.visibleStorageIndices.length) {
      await this.showAppMessage(
        this.sanitizeForDisplay(
          `No study cards for this topic.\n\n` +
          `(Hidden or finished cards are not shown. Add cards on the phone or generate them for this topic.)`,
          MAX_CONTENT_LENGTH,
        ),
        '[Tap=back]',
      );
      return;
    }

    session.cursor = 0;
    this.cardStudy = session;
    this.ui.view = 'topic-card-study';
    await incrementLearningCardsShown(this.bridge);
    await this.renderTopicCardStudyView();
    setStatus(`Studying: ${topic.slice(0, 48)}${topic.length > 48 ? '…' : ''}`);
  }

  private async renderTopicCardStudyView(): Promise<void> {
    const session = this.cardStudy;
    if (!session || !session.visibleStorageIndices.length) return;

    const total = session.visibleStorageIndices.length;
    const pos = session.cursor;
    const storageIdx = session.visibleStorageIndices[pos];
    if (storageIdx === undefined) return;

    const card = session.allCards[storageIdx];
    const idLabel =
      card.cardId && card.cardId.length > 0 && card.cardId.length <= 18
        ? card.cardId
        : String(pos + 1);
    const topLine = this.sanitizeForDisplay(
      `[${idLabel}/${total}] [Tap=next] [DTap=menu]`,
      260,
    );
    const titleLine = this.sanitizeForDisplay(card.cardTitle || '(No title)', 220);
    const bodyText = this.sanitizeForDisplay(
      (card.text || '').trim() || '(Empty card)',
      MAX_CONTENT_LENGTH,
    );

    const hintBar = new TextContainerProperty({
      containerID: ML_CARD_HINT_ID,
      containerName: 'ml-card-hint',
      xPosition: 6,
      yPosition: 0,
      width: 564,
      height: 36,
      borderWidth: 0,
      borderColor: 5,
      borderRadius: 0,
      paddingLength: 0,
      content: topLine,
      isEventCapture: 0,
    });

    const titleBlock = new TextContainerProperty({
      containerID: ML_CARD_TITLE_ID,
      containerName: 'ml-card-title',
      xPosition: 6,
      yPosition: 36,
      width: 564,
      height: 44,
      borderWidth: 0,
      borderColor: 5,
      borderRadius: 0,
      paddingLength: 0,
      content: titleLine,
      isEventCapture: 0,
    });

    const bodyBlock = new TextContainerProperty({
      containerID: ML_CARD_BODY_ID,
      containerName: 'ml-card-body',
      xPosition: 6,
      yPosition: 80,
      width: 564,
      height: 208,
      borderWidth: 0,
      borderColor: 5,
      borderRadius: 0,
      paddingLength: 0,
      content: bodyText,
      isEventCapture: 1,
    });

    const ok = await this.applyRebuildPageContainer(
      new RebuildPageContainer({
        containerTotalNum: 3,
        textObject: [hintBar, titleBlock, bodyBlock],
      }),
    );
    if (!ok) appendEventLog('Failed to render topic card study view');
  }

  private async handleTopicCardStudyTapAdvance(): Promise<void> {
    const session = this.cardStudy;
    if (!session || session.visibleStorageIndices.length === 0) return;

    const last = session.visibleStorageIndices.length - 1;
    if (session.cursor >= last) {
      this.cardStudy = null;
      await this.renderGlassesTopicList();
      return;
    }

    session.cursor += 1;
    await incrementLearningCardsShown(this.bridge);
    await this.renderTopicCardStudyView();
  }

  private async openTopicCardStudyMenu(): Promise<void> {
    const session = this.cardStudy;
    if (!session?.visibleStorageIndices.length) return;
    const storageIdx = session.visibleStorageIndices[session.cursor];
    if (storageIdx === undefined) return;
    const st = normalizeLearningCardStatus(session.allCards[storageIdx].status);

    const labels: string[] = [];
    const actions: CardStudyMenuAction[] = [];

    labels.push('Read aloud (Unlock & test phone speaker first)');
    actions.push('read-aloud');
    if (st === 'new-card') {
      labels.push('Mark as Read');
      actions.push('mark-read');
    }
    if (st === 'new-card' || st === 'read') {
      labels.push('Mark as Learned');
      actions.push('mark-learned');
    }
    labels.push('Mark as Done');
    actions.push('mark-done');
    labels.push('<- Back to learning topics');
    actions.push('back');

    this.cardStudyMenuActions = actions;

    const list = new ListContainerProperty({
      containerID: 8,
      containerName: 'ml-study-menu',
      xPosition: 0,
      yPosition: 0,
      width: 576,
      height: 288,
      borderWidth: 1,
      borderColor: 5,
      borderRadius: 6,
      paddingLength: 4,
      isEventCapture: 1,
      itemContainer: new ListItemContainerProperty({
        itemCount: labels.length,
        itemWidth: 560,
        isItemSelectBorderEn: 1,
        itemName: labels.map((t) => this.sanitizeForDisplay(t, 60)),
      }),
    });

    const ok = await this.applyRebuildPageContainer(
      new RebuildPageContainer({ containerTotalNum: 1, listObject: [list] }),
    );
    if (ok) {
      this.ui.view = 'topic-card-study-menu';
      setStatus('Card menu: pick an action.');
    }
  }

  private async handleTopicCardStudyMenuSelect(index: number): Promise<void> {
    const action = this.cardStudyMenuActions[index];
    if (!action) return;
    if (action === 'back') {
      this.cardStudyMenuActions = [];
      this.cardStudy = null;
      await this.renderGlassesTopicList();
      return;
    }
    if (action === 'read-aloud') {
      await this.startCardReadAloud();
      return;
    }
    if (action === 'mark-read') {
      await this.applyCardStatusFromMenu('read');
      return;
    }
    if (action === 'mark-learned') {
      await this.applyCardStatusFromMenu('learned');
      return;
    }
    if (action === 'mark-done') {
      await this.applyCardStatusFromMenu('done');
    }
  }

  private async applyCardStatusFromMenu(target: LearningCardStatus): Promise<void> {
    const session = this.cardStudy;
    if (!session) return;
    const storageIdx = session.visibleStorageIndices[session.cursor];
    if (storageIdx === undefined) return;
    const card = session.allCards[storageIdx];
    const prev = normalizeLearningCardStatus(card.status);

    if (target === 'done' && prev !== 'done') {
      await incrementLearningCardsLearned(this.bridge);
    }
    card.status = target;

    try {
      await saveLearningCardsForTopic(this.bridge, session.topic, session.allCards);
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      appendEventLog(`saveLearningCardsForTopic failed: ${m}`);
      await this.showAppMessage(`Could not save.\n\n${m}`, '[Tap=back]', 'topic-card-study');
      return;
    }

    this.recomputeVisibleCardIndices(session);
    if (!session.visibleStorageIndices.length) {
      this.cardStudyMenuActions = [];
      this.cardStudy = null;
      await this.renderGlassesTopicList();
      return;
    }

    const oldCursor = session.cursor;
    const idxAfter = session.visibleStorageIndices.indexOf(storageIdx);
    session.cursor =
      idxAfter >= 0 ? idxAfter : Math.min(oldCursor, session.visibleStorageIndices.length - 1);
    this.ui.view = 'topic-card-study';
    await this.renderTopicCardStudyView();
  }

  private async finishReadAloudBackToCard(): Promise<void> {
    revokeSharedPlaybackBlobUrl();
    const a = getSharedPlaybackAudio();
    a.pause();
    a.currentTime = 0;
    if (this.ui.view === 'topic-card-read-aloud') {
      this.ui.view = 'topic-card-study';
      await this.renderTopicCardStudyView();
    }
  }

  private async cancelCardReadAloudAndReturn(): Promise<void> {
    this.readAloudAborted = true;
    const a = getSharedPlaybackAudio();
    a.pause();
    a.currentTime = 0;
    revokeSharedPlaybackBlobUrl();
    if (this.ui.view === 'topic-card-read-aloud') {
      this.ui.view = 'topic-card-study';
      await this.renderTopicCardStudyView();
    }
  }

  private async readAloudFailedReturnToCard(message: string): Promise<void> {
    this.readAloudAborted = true;
    getSharedPlaybackAudio().pause();
    revokeSharedPlaybackBlobUrl();
    await this.showAppMessage(
      `Read aloud\n\n${message}`,
      '[Tap=back]',
      'topic-card-study',
    );
  }

  private async startCardReadAloud(): Promise<void> {
    const session = this.cardStudy;
    if (!session?.visibleStorageIndices.length) return;
    const storageIdx = session.visibleStorageIndices[session.cursor];
    if (storageIdx === undefined) return;
    const card = session.allCards[storageIdx];

    const cfg = await loadConfigFromLocalStorage(this.bridge);
    if (!cfg.elevenLabsApiKey?.trim()) {
      await this.readAloudFailedReturnToCard(
        'ElevenLabs API key missing.\n\nAdd it under Settings on the phone.',
      );
      return;
    }

    this.readAloudAborted = false;
    this.ui.view = 'topic-card-read-aloud';

    const speakText = this.sanitizeForDisplay(
      `${(card.cardTitle || 'Card').trim()}.\n\n${(card.text || '').trim()}`.trim(),
      1000,
    );
    const titleDisplay = this.sanitizeForDisplay(card.cardTitle || 'Card', 220);
    const bodyDisplay = this.sanitizeForDisplay(
      (card.text || '').trim() || '(Empty)',
      MAX_CONTENT_LENGTH,
    );

    await this.applyRebuildPageContainer(
      new RebuildPageContainer({
        containerTotalNum: 3,
        textObject: [
          new TextContainerProperty({
            containerID: 1,
            containerName: 'finfotext',
            xPosition: 8,
            yPosition: 0,
            width: 556,
            height: 30,
            borderWidth: 1,
            borderColor: 5,
            borderRadius: 2,
            paddingLength: 0,
            content: '[DTap=cancel]',
            isEventCapture: 0,
          }),
          new TextContainerProperty({
            containerID: 2,
            containerName: 'ml-read-title',
            xPosition: 10,
            yPosition: 32,
            width: 556,
            height: 48,
            borderWidth: 0,
            borderColor: 5,
            paddingLength: 0,
            content: titleDisplay,
            isEventCapture: 0,
          }),
          new TextContainerProperty({
            containerID: 3,
            containerName: 'ml-read-body',
            xPosition: 10,
            yPosition: 84,
            width: 556,
            height: 200,
            borderWidth: 0,
            borderColor: 5,
            paddingLength: 0,
            content: bodyDisplay,
            isEventCapture: 1,
          }),
        ],
      }),
    );

    try {
      const mp3 = await synthesizeSpeech(cfg.elevenLabsApiKey, speakText);
      if (this.readAloudAborted || this.ui.view !== 'topic-card-read-aloud') return;
      const audio = prepareSharedPlaybackFromMp3(mp3);
      audio.onended = () => {
        revokeSharedPlaybackBlobUrl();
        if (this.readAloudAborted || this.ui.view !== 'topic-card-read-aloud') return;
        void this.finishReadAloudBackToCard();
      };
      audio.onerror = () => {
        void this.readAloudFailedReturnToCard('Audio playback error.');
      };
      await audio.play().catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        return this.readAloudFailedReturnToCard(
          `${msg}\n\nOn the phone: Settings → Unlock & test phone speaker.`,
        );
      });
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      await this.readAloudFailedReturnToCard(m);
    }
  }

  private async handleMainMenuSelect(index: number): Promise<void> {
    if (index === 0) {
      await this.toggleTopicVoiceRecording();
      return;
    }
    if (index === 1) {
      await this.renderGlassesTopicList();
      return;
    }
    if (index === 2) {
      const p = await loadLearningProgress(this.bridge);
      const grid = await loadLearningProgressGridText(this.bridge);
      await this.showAppMessage(
        `Total shown: ${p.cardsShown}  learned: ${p.cardsLearned}\n` +
        grid,
        '[Tab=back]',
      );
    }
  }

  /**
 * Glass firmware may use different casing / underscores for text container names.
 */
  // private normalizeContainerName(name: string): string {
  //   return name.replace(/_/g, '-').toLowerCase().trim();
  // }

  // private textContainerNameMatches(
  //   got: string | undefined,
  //   expected: string,
  // ): boolean {
  //   if (got == null || got === '') return false;
  //   return this.normalizeContainerName(got) === this.normalizeContainerName(expected);
  // }

  /**
   * `evenHubEventFromJson` can drop `listEvent` when the host uses alternate keys
   * (`list_event`, nested `jsonData`). Merge loose payloads so list taps (main menu, etc.) work.
   */
  private normalizeIncomingHubEvent(raw: unknown): EvenHubEvent {
    const parsed = evenHubEventFromJson(raw);
    if (raw === null || typeof raw !== 'object') return parsed;

    const r = raw as Record<string, unknown>;
    const jd = (r.jsonData ?? r.json_data) as Record<string, unknown> | undefined;

    let listEvent = parsed.listEvent;
    if (!listEvent) {
      const rawList = r.listEvent ?? r.list_event ?? jd?.listEvent ?? jd?.list_event;
      if (rawList != null && typeof rawList === 'object') {
        try {
          listEvent = List_ItemEvent.fromJson(rawList);
        } catch {
          listEvent = rawList as EvenHubEvent['listEvent'];
        }
      }
    }

    let textEvent = parsed.textEvent;
    if (!textEvent) {
      const rawText = r.textEvent ?? r.text_event ?? jd?.textEvent ?? jd?.text_event;
      if (rawText != null && typeof rawText === 'object') {
        try {
          textEvent = Text_ItemEvent.fromJson(rawText);
        } catch {
          textEvent = rawText as EvenHubEvent['textEvent'];
        }
      }
    }

    let sysEvent = parsed.sysEvent;
    if (!sysEvent) {
      const rawSys = r.sysEvent ?? r.sys_event ?? jd?.sysEvent ?? jd?.sys_event;
      if (rawSys != null && typeof rawSys === 'object') {
        try {
          sysEvent = Sys_ItemEvent.fromJson(rawSys);
        } catch {
          sysEvent = rawSys as EvenHubEvent['sysEvent'];
        }
      }
    }

    let audioEvent = parsed.audioEvent;
    if (!audioEvent?.audioPcm) {
      const rawAudio = r.audioEvent ?? r.audio_event ?? jd?.audioEvent ?? jd?.audio_event;
      if (rawAudio != null && typeof rawAudio === 'object') {
        const ra = rawAudio as Record<string, unknown>;
        const nestedPcm = ra.audioPcm ?? ra.audio_pcm;
        if (nestedPcm != null) {
          audioEvent = {
            ...audioEvent,
            audioPcm: nestedPcm as NonNullable<EvenHubEvent['audioEvent']>['audioPcm'],
          };
        } else {
          audioEvent = rawAudio as EvenHubEvent['audioEvent'];
        }
      }
    }
    if (!audioEvent?.audioPcm) {
      const loosePcm = r.audioPcm ?? r.audio_pcm ?? jd?.audioPcm ?? jd?.audio_pcm;
      if (loosePcm != null) {
        audioEvent = {
          ...audioEvent,
          audioPcm: loosePcm as NonNullable<EvenHubEvent['audioEvent']>['audioPcm'],
        };
      }
    }

    return {
      ...parsed,
      listEvent,
      textEvent,
      sysEvent,
      audioEvent,
    };
  }

  /** Gesture type from a list row event only — avoids `textEvent` stealing `eventType` on list UIs. */
  private gestureFromListEvent(list: List_ItemEvent | undefined): OsEventTypeList | undefined {
    if (!list) return undefined;
    return OsEventTypeList.fromJson(list.eventType) ?? list.eventType;
  }

  /** Gesture type from a text container event only. */
  private gestureFromTextEvent(text: Text_ItemEvent | undefined): OsEventTypeList | undefined {
    if (!text) return undefined;
    return OsEventTypeList.fromJson(text.eventType) ?? text.eventType;
  }

  /**
 * Draft/ready readers call `textContainerUpgrade` twice per page (header + body). The host often
 * echoes the same scroll direction twice in quick succession; drop the duplicate, not all rapid scrolls.
 */
  private lastEvent: 'top' | 'bottom' | 'click' | 'double-click' | null = null;
  private lastEventAtMs = 0;

  /** Ignore a second same-direction scroll within a few ms (firmware echo per text upgrade). */
  private consumeIfNotDuplicateEventEcho(dir: 'top' | 'bottom' | 'click' | 'double-click', windowMs: number): boolean {
    const now = performance.now();
    if (this.lastEvent === dir && now - this.lastEventAtMs < windowMs) {
      return false;
    }
    this.lastEvent = dir;
    this.lastEventAtMs = now;
    return true;
  }

  private async onEvenHubEvent(event: EvenHubEvent): Promise<void> {
    const hubPcm = event.audioEvent?.audioPcm as Uint8Array | number[] | string | undefined;
    if (hubPcm != null && hubPcm !== '') {
      feedSttAudio(hubPcm);
    }

    if (!event.textEvent && !event.listEvent && !event.sysEvent) {
      return;
    }

    const eventType =
      event.textEvent?.eventType ??
      event.sysEvent?.eventType ??
      event.listEvent?.eventType ??
      undefined;



    if (this.ui.view === 'topic-recording') {
      if (event.sysEvent?.eventType === OsEventTypeList.IMU_DATA_REPORT) {
        return;
      }

      const textGesture = this.gestureFromTextEvent(event.textEvent) ?? eventType;

      if (textGesture === OsEventTypeList.CLICK_EVENT || textGesture === undefined) {
        if (!this.consumeIfNotDuplicateEventEcho('click', 900)) return;
        if (this.isTopicVoiceRecording) {
          await this.toggleTopicVoiceRecording();
        }
        return;
      }

      if (textGesture === OsEventTypeList.DOUBLE_CLICK_EVENT) {
        if (!this.consumeIfNotDuplicateEventEcho('double-click', 900)) return;
        await cancelSttRecording();
        this.isTopicVoiceRecording = false;
        this.clearTopicRecordingUi();
        await this.renderMainMenu();
        return;
      }
    }

    if (this.ui.view === 'topic-generating-cards') {
      return;
    }

    if (this.ui.view === 'main-menu' && event.listEvent) {
      const listGesture = this.gestureFromListEvent(event.listEvent);

      if (listGesture === OsEventTypeList.CLICK_EVENT || listGesture === undefined) {
        if (!this.consumeIfNotDuplicateEventEcho('click', 900)) return;
        const idx = event.listEvent.currentSelectItemIndex ?? 0;
        await this.handleMainMenuSelect(idx);
        return;
      }
      if (listGesture === OsEventTypeList.DOUBLE_CLICK_EVENT) {
        if (!this.consumeIfNotDuplicateEventEcho('double-click', 900)) return;
        await this.bridge.shutDownPageContainer(1);
        return;
      }
    }

    if (this.ui.view === 'glasses-topic-list' && event.listEvent) {
      const listGesture = this.gestureFromListEvent(event.listEvent) ?? eventType;
      if (listGesture === OsEventTypeList.CLICK_EVENT || listGesture === undefined) {
        if (!this.consumeIfNotDuplicateEventEcho('click', 900)) return;
        const topics = this.ui.topics;
        const idx = event.listEvent.currentSelectItemIndex ?? 0;
        if (idx >= topics.length) {
          await this.renderMainMenu();
        } else {
          const topic = topics[idx];
          await this.openTopicCardStudy(topic);
        }
        return;
      }
      if (listGesture === OsEventTypeList.DOUBLE_CLICK_EVENT) {
        if (!this.consumeIfNotDuplicateEventEcho('double-click', 900)) return;
        await this.renderMainMenu();
        return;
      }
    }

    if (this.ui.view === 'topic-card-study') {
      if (event.sysEvent?.eventType === OsEventTypeList.IMU_DATA_REPORT) {
        return;
      }
      const textGesture = this.gestureFromTextEvent(event.textEvent) ?? eventType;
      if (textGesture === OsEventTypeList.DOUBLE_CLICK_EVENT) {
        if (!this.consumeIfNotDuplicateEventEcho('double-click', 900)) return;
        await this.openTopicCardStudyMenu();
        return;
      }
      if (textGesture === OsEventTypeList.CLICK_EVENT || textGesture === undefined) {
        if (!this.consumeIfNotDuplicateEventEcho('click', 900)) return;
        await this.handleTopicCardStudyTapAdvance();
        return;
      }
    }

    if (this.ui.view === 'topic-card-study-menu' && event.listEvent) {
      const listGesture = this.gestureFromListEvent(event.listEvent) ?? eventType;
      if (listGesture === OsEventTypeList.CLICK_EVENT || listGesture === undefined) {
        if (!this.consumeIfNotDuplicateEventEcho('click', 900)) return;
        const idx = event.listEvent.currentSelectItemIndex ?? 0;
        await this.handleTopicCardStudyMenuSelect(idx);
        return;
      }
      if (listGesture === OsEventTypeList.DOUBLE_CLICK_EVENT) {
        if (!this.consumeIfNotDuplicateEventEcho('double-click', 900)) return;
        this.ui.view = 'topic-card-study';
        await this.renderTopicCardStudyView();
        return;
      }
    }

    if (this.ui.view === 'topic-card-read-aloud') {
      if (event.sysEvent?.eventType === OsEventTypeList.IMU_DATA_REPORT) {
        return;
      }
      const textGesture = this.gestureFromTextEvent(event.textEvent) ?? eventType;
      if (textGesture === OsEventTypeList.DOUBLE_CLICK_EVENT) {
        if (!this.consumeIfNotDuplicateEventEcho('double-click', 900)) return;
        await this.cancelCardReadAloudAndReturn();
      }
      return;
    }

    if (this.ui.view === 'app-message') {
      const textGesture = this.gestureFromTextEvent(event.textEvent) ?? eventType;
      if (textGesture === OsEventTypeList.CLICK_EVENT || eventType === undefined) {
        if (!this.consumeIfNotDuplicateEventEcho('click', 900)) return;
        const go = this.appMessageAfterDismiss;
        this.appMessageAfterDismiss = 'main-menu';
        if (go === 'topic-card-study') {
          this.ui.view = 'topic-card-study';
          await this.renderTopicCardStudyView();
        } else {
          await this.renderMainMenu();
        }
      }
      return;
    }
  }
}
