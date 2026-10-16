import { describe, expect, test } from "bun:test";
import {
  buildTelegramCounterHuntNotification,
  classifyBotMessage,
  COUNTER_HUNT_WINDOW_MS,
  counterHuntView,
  isBotMessage,
  maskPhone,
  parseCounterHuntDirection,
} from "./telegram.helpers";

describe("classifyBotMessage", () => {
  test("keyword rules, tegenhunt first", () => {
    expect(classifyBotMessage("Er is een TEGENHUNT gestart, de opdracht: zoek de sticker")).toBe("tegenhunt");
    expect(classifyBotMessage("Er is een tegen-hunt gestart")).toBe("tegenhunt");
    expect(classifyBotMessage("Je hunt in Alpha is goedgekeurd")).toBe("hunt-approved");
    expect(classifyBotMessage("Je hunt is afgekeurd: foto onleesbaar")).toBe("hunt-rejected");
    expect(classifyBotMessage("Nieuwe opdracht online")).toBe("assignment");
    expect(classifyBotMessage("Jullie inzending is ontvangen")).toBe("assignment");
    expect(classifyBotMessage("Het is Happy Hour! Dubbele punten")).toBe("happy-hour");
    expect(classifyBotMessage("Welkom bij de Jotihunt")).toBe("other");
  });
  test("a tegenhunt only when it looks like a start", () => {
    expect(classifyBotMessage("Happy hour van 21:00 tot 22:00! Hunts tellen dubbel, tegenhunts niet.")).toBe("happy-hour");
    expect(classifyBotMessage("Jullie tegenhunt is goedgekeurd")).toBe("hunt-approved");
    expect(classifyBotMessage("Jullie tegenhunt is afgekeurd")).toBe("hunt-rejected");
    expect(classifyBotMessage("Lees de regels over de tegenhunt")).toBe("other");
    expect(classifyBotMessage("Tegenhunt! Windrichting: Z")).toBe("tegenhunt");
    expect(classifyBotMessage("De tegenhunt begint om 21:14")).toBe("tegenhunt");
    expect(classifyBotMessage("Tegenhunt: jullie hebben 30 minuten")).toBe("tegenhunt");
  });
});

describe("parseCounterHuntDirection", () => {
  test("degrees round to the nearest 45", () => {
    expect(parseCounterHuntDirection("Tegenhunt uit 45°")).toBe(45);
    expect(parseCounterHuntDirection("windrichting 100 graden")).toBe(90);
    expect(parseCounterHuntDirection("richting 350 deg")).toBe(0);
    expect(parseCounterHuntDirection("richting 22,4°")).toBe(0);
    expect(parseCounterHuntDirection("richting 200 °")).toBe(180);
  });
  test("Dutch names, longest first, also with -en and a hyphen", () => {
    expect(parseCounterHuntDirection("Er is een tegenhunt gestart, windrichting noordoost")).toBe(45);
    expect(parseCounterHuntDirection("tegenhunt uit het Zuidwesten")).toBe(225);
    expect(parseCounterHuntDirection("tegenhunt vanuit het noorden")).toBe(0);
    expect(parseCounterHuntDirection("richting west")).toBe(270);
    expect(parseCounterHuntDirection("richting noord-west")).toBe(315);
    expect(parseCounterHuntDirection("vanuit het oosten")).toBe(90);
    expect(parseCounterHuntDirection("zuidoost")).toBe(135);
  });
  test("16-point names and abbreviations round to the nearest 8-point direction (ties clockwise)", () => {
    expect(parseCounterHuntDirection("windrichting noordnoordoost")).toBe(45);
    expect(parseCounterHuntDirection("windrichting oostzuidoost")).toBe(135);
    expect(parseCounterHuntDirection("windrichting NNW")).toBe(0);
    expect(parseCounterHuntDirection("windrichting WZW")).toBe(270);
  });
  test("abbreviations as whole words: uppercase anywhere, any case right after (wind)richting", () => {
    expect(parseCounterHuntDirection("Tegenhunt! NO")).toBe(45);
    expect(parseCounterHuntDirection("Tegenhunt, kom uit Z")).toBe(180);
    expect(parseCounterHuntDirection("tegenhunt windrichting: zw")).toBe(225);
    expect(parseCounterHuntDirection("tegenhunt richting o")).toBe(90);
  });
  test("the word after (wind)richting / (van)uit het wins over other compass words", () => {
    expect(parseCounterHuntDirection("Tegenhunt vanuit Arnhem-Zuid, windrichting noordoost")).toBe(45);
    expect(parseCounterHuntDirection("Tegenhunt bij Zuid-Holland, uit het westen")).toBe(270);
    expect(parseCounterHuntDirection("Oost-Gelre: tegenhunt, richting ZW")).toBe(225);
  });
  test("conflicting directions give null", () => {
    expect(parseCounterHuntDirection("Tegenhunt, windrichting noord of windrichting zuid")).toBeNull();
    expect(parseCounterHuntDirection("Tegenhunt: noord en zuid")).toBeNull();
    expect(parseCounterHuntDirection("Tegenhunt windrichting noord, kom uit het noorden")).toBe(0);
  });
  test("no direction", () => {
    expect(parseCounterHuntDirection("Er is een tegenhunt gestart! Zoek de sticker.")).toBeNull();
    expect(parseCounterHuntDirection("Ga zo snel mogelijk naar Oosterbeek of Westervoort")).toBeNull();
    expect(parseCounterHuntDirection("Noordelijk deel")).toBeNull();
    expect(parseCounterHuntDirection("")).toBeNull();
  });
});


describe("maskPhone", () => {
  test("keeps the country code, first digit and last two", () => {
    expect(maskPhone("+31612345612")).toBe("+31 6 ••• 12");
    expect(maskPhone("31612345612")).toBe("+31 6 ••• 12");
    expect(maskPhone("123")).toBe("•••");
  });
});

describe("isBotMessage", () => {
  const message = { senderUsername: "jotihunt_BOT", senderIsBot: true, privateChat: true };
  test("the bot's username (case-insensitive, with or without @), a bot, in the private chat with it", () => {
    expect(isBotMessage(message, "@Jotihunt_bot")).toBe(true);
    expect(isBotMessage({ ...message, senderUsername: "someone" }, "Jotihunt_bot")).toBe(false);
    expect(isBotMessage({ ...message, senderUsername: undefined }, "Jotihunt_bot")).toBe(false);
    expect(isBotMessage({ ...message, senderIsBot: false }, "Jotihunt_bot")).toBe(false);
    expect(isBotMessage({ ...message, privateChat: false }, "Jotihunt_bot")).toBe(false);
  });
});

describe("counterHuntView", () => {
  const now = new Date("2026-10-17T20:00:00Z");
  const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000);
  test("nothing yet", () => {
    expect(counterHuntView(null, now)).toEqual({ active: false });
  });
  test("active within 30 minutes of the start, startedAt from data", () => {
    const view = counterHuntView({ data: { direction: 45, startedAt: ago(10).toISOString() }, createdAt: ago(9) }, now);
    expect(view).toEqual({ active: true, direction: 45, startedAt: ago(10).toISOString(), endsAt: new Date(ago(10).getTime() + COUNTER_HUNT_WINDOW_MS).toISOString() });
  });
  test("null direction carries the bot text; startedAt falls back to createdAt", () => {
    const view = counterHuntView({ data: { direction: null, text: "Tegenhunt!" }, createdAt: ago(5) }, now);
    expect(view).toEqual({ active: true, direction: null, startedAt: ago(5).toISOString(), endsAt: new Date(ago(5).getTime() + COUNTER_HUNT_WINDOW_MS).toISOString(), text: "Tegenhunt!" });
  });
  test("ended after 30 minutes", () => {
    expect(counterHuntView({ data: { direction: 90, startedAt: ago(30) }, createdAt: ago(30) }, now)).toEqual({ active: false, last: { direction: 90, startedAt: ago(30).toISOString() } });
  });
});

describe("buildTelegramCounterHuntNotification", () => {
  const date = new Date("2026-10-17T19:14:00Z");
  test("with a direction: the usual counter-hunt alert plus the message id and start", () => {
    expect(buildTelegramCounterHuntNotification({ telegramId: 7, text: "Tegenhunt, windrichting noordoost", date })).toEqual({
      type: "counter-hunt",
      title: "Tegenhunt! Richting NO ↗",
      body: "Zoek de sticker binnen 500 m van het clubhuis, richting noordoost.",
      urgent: true,
      data: { direction: 45, from: "Telegram", telegramId: 7, startedAt: date.toISOString() },
    });
  });
  test("without a direction: points to the bot's message", () => {
    expect(buildTelegramCounterHuntNotification({ telegramId: 8, text: "Tegenhunt gestart!", date })).toEqual({
      type: "counter-hunt",
      title: "Tegenhunt!",
      body: "Richting niet herkend, lees het bericht van de Jotihunt-bot.",
      urgent: true,
      data: { direction: null, text: "Tegenhunt gestart!", telegramId: 8, startedAt: date.toISOString() },
    });
  });
});
