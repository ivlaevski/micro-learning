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
  Text_ItemEvent,
  evenHubEventFromJson,
  type EvenAppBridge,
  type EvenHubEvent,
} from '@evenrealities/even_hub_sdk';

import type { ViewName } from './types';
import {
  appendEventLog,
  loadLearningScore,
  loadTopicsFromLocalStorage,
  setStatus,
} from './utils';

const MAX_CONTENT_LENGTH = 900;

function gestureFromListEvent(list: List_ItemEvent | undefined): OsEventTypeList | undefined {
  if (!list) return undefined;
  return OsEventTypeList.fromJson(list.eventType) ?? list.eventType;
}

type UiState = {
  view: ViewName;
  topics: string[];
};

export class MicroLearningClient {
  private readonly bridge: EvenAppBridge;
  private isStartupCreated = false;
  private ui: UiState = {
    view: 'main-menu',
    topics: [],
  };

  constructor(bridge: EvenAppBridge) {
    this.bridge = bridge;
  }

  /** Call after phone saves topics so the next glasses list is fresh. */
  reloadTopicsFromStorage(): void {
    this.ui.topics = loadTopicsFromLocalStorage();
  }

  async init(): Promise<void> {
    await this.waitForGlassesConnected(12000);
    await this.ensureStartupUi();
    this.ui.topics = loadTopicsFromLocalStorage();
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
    return this.bridge.rebuildPageContainer(payload);
  }

  private async showAppMessage(body: string, info = '[Tab=back]'): Promise<void> {
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
      height: 30,
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
    this.ui.view = 'main-menu';
    this.ui.topics = loadTopicsFromLocalStorage();

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
          'Learning Score',
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
          content: '© 2026 Ivan Vlaevski',
          isEventCapture: 0,
        }),
        new TextContainerProperty({
          containerID: 3,
          containerName: 'menu-footer',
          xPosition: 316,
          yPosition: 248,
          width: 250,
          height: 28,
          content: '',
          isEventCapture: 0,
        }),
      ],
      listObject: [list],
    });

    const success = await this.applyRebuildPageContainer(mainPage);
    if (success) {
      setStatus('Main menu: tap to choose an option.');
    } else {
      appendEventLog('Failed to create main menu');
    }
  }

  private async renderGlassesTopicList(): Promise<void> {
    this.ui.view = 'glasses-topic-list';
    this.ui.topics = loadTopicsFromLocalStorage();

    if (!this.ui.topics.length) {
      await this.showAppMessage(
        'No topics yet.\n\nAdd topics on the phone, then open this list again.',
        '[Tab=back]',
      );
      return;
    }

    const items = this.ui.topics.map((topic, index) =>
      this.sanitizeForDisplay(`${index + 1}. ${topic}`, 64),
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

    await this.applyRebuildPageContainer(
      new RebuildPageContainer({
        containerTotalNum: 1,
        listObject: [list],
      }),
    );
    setStatus('Topics on glasses: tap one or Back.');
  }

  private async handleMainMenuSelect(index: number): Promise<void> {
    if (index === 0) {
      await this.showAppMessage(
        'Record new topic for research\n\n' +
          'Voice capture from the glasses will plug in here. For now, add or edit topics on the phone.',
        '[Tab=back]',
      );
      return;
    }
    if (index === 1) {
      await this.renderGlassesTopicList();
      return;
    }
    if (index === 2) {
      const score = loadLearningScore();
      await this.showAppMessage(
        `Learning Score\n\n` +
          `Current score: ${score}\n\n` +
          `Complete sessions and reviews to grow your score — detailed rules coming soon.`,
        '[Tab=back]',
      );
    }
  }

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

  private async onEvenHubEvent(event: EvenHubEvent): Promise<void> {
    if (!event.textEvent && !event.listEvent && !event.sysEvent) {
      return;
    }

    const eventType =
      event.textEvent?.eventType ??
      event.sysEvent?.eventType ??
      event.listEvent?.eventType ??
      undefined;

    if (this.ui.view === 'main-menu' && event.listEvent) {
      const listGesture =
        OsEventTypeList.fromJson(event.listEvent.eventType) ??
        OsEventTypeList.fromJson(eventType) ??
        eventType;
      if (
        listGesture === OsEventTypeList.SCROLL_TOP_EVENT ||
        listGesture === OsEventTypeList.SCROLL_BOTTOM_EVENT
      ) {
        return;
      }
      const idx = event.listEvent.currentSelectItemIndex ?? 0;
      await this.handleMainMenuSelect(idx);
      return;
    }

    if (this.ui.view === 'glasses-topic-list' && event.listEvent) {
      const listGesture = gestureFromListEvent(event.listEvent);
      if (
        listGesture === OsEventTypeList.SCROLL_TOP_EVENT ||
        listGesture === OsEventTypeList.SCROLL_BOTTOM_EVENT
      ) {
        return;
      }
      if (listGesture === OsEventTypeList.CLICK_EVENT || listGesture === undefined) {
        const topics = this.ui.topics;
        const idx = event.listEvent.currentSelectItemIndex ?? 0;
        if (idx >= topics.length) {
          await this.renderMainMenu();
        } else {
          const topic = topics[idx];
          await this.showAppMessage(
            `Topic\n\n${this.sanitizeForDisplay(topic, MAX_CONTENT_LENGTH)}\n\n(Edit or remove on the phone.)`,
            '[Tab=back]',
          );
        }
        return;
      }
    }

    if (this.ui.view === 'app-message') {
      if (eventType === OsEventTypeList.CLICK_EVENT || eventType === undefined) {
        await this.renderMainMenu();
      }
      return;
    }
  }
}
