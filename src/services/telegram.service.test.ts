import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import mongoose, { type Connection } from "mongoose";
import { ServiceError } from "../http/service-error";
import { AppNotification } from "../models/notification.model";
import { telegramLinkModel } from "../models/telegram-link.model";
import { telegramMessageModel } from "../models/telegram-message.model";
import { clearTestDb, connectTestDb, disconnectTestDb } from "../test/db";
import { FakeGateway, SESSION } from "../test/telegram-gateway";
import { decryptSession, encryptSession } from "./telegram.helpers";
import { SessionRevokedError, telegramConfigFromEnv, TelegramService, type TelegramConfig, type TelegramIncomingMessage } from "./telegram.service";

const KEY = randomBytes(32).toString("base64");
const CONFIG: TelegramConfig = { apiId: 1, apiHash: "hash", sessionKey: KEY, botUsername: "Jotihunt_bot" };

const uri = process.env.MONGO_URI_TEST ?? "mongodb://localhost:27017/jotihunt-test";
/** Stands in for the demo state store's connection to the real database */
let realDb: Connection;
let gateways: FakeGateway[];
let prepare: (gateway: FakeGateway) => void;
let service: TelegramService;
const logs: string[] = [];
const logger = { info: (message: string) => logs.push(message), warn: (message: string) => logs.push(message), error: (message: string) => logs.push(message) };

function createService(config: TelegramConfig | null = CONFIG) {
  return new TelegramService({
    config,
    connection: realDb,
    gateway: () => {
      const gateway = new FakeGateway();
      prepare(gateway);
      gateways.push(gateway);
      return gateway;
    },
    logger,
    retryInitialMs: 5,
    retryMaxMs: 20,
    alertRetryMs: 5,
  });
}

const until = async (check: () => boolean | Promise<boolean>) => {
  for (let i = 0; i < 200; i++) {
    if (await check()) return;
    await Bun.sleep(5);
  }
  throw new Error("Timed out");
};
const botMessage = (id: number, text: string, sender = "Jotihunt_bot"): TelegramIncomingMessage => ({ id, senderUsername: sender, text, date: new Date("2026-10-17T19:14:00Z") });
const storeLink = () => {
  const { ciphertext, iv, tag } = encryptSession(SESSION, KEY);
  return telegramLinkModel(realDb).create({ key: "telegram", sessionCiphertext: ciphertext, iv, tag, account: { id: 42, name: "Silke" }, linkedAt: new Date() });
};

beforeAll(async () => {
  await connectTestDb();
  realDb = await mongoose.createConnection(uri).asPromise();
});
beforeEach(async () => {
  await clearTestDb();
  await telegramLinkModel(realDb).deleteMany({});
  await telegramMessageModel(realDb).deleteMany({});
  gateways = [];
  prepare = () => {};
  logs.length = 0;
  service = createService();
  await service.start();
});
afterEach(() => service.stop());
afterAll(async () => {
  await realDb.close();
  await disconnectTestDb();
});

describe("telegramConfigFromEnv", () => {
  test("off without id/hash, off with a bad session key (warning), default bot username", () => {
    const warnings: string[] = [];
    const warn = (message: string) => warnings.push(message);
    expect(telegramConfigFromEnv({}, warn)).toBeNull();
    expect(warnings).toEqual([]);
    expect(telegramConfigFromEnv({ TELEGRAM_API_ID: "1", TELEGRAM_API_HASH: "h", TELEGRAM_SESSION_KEY: "kort" }, warn)).toBeNull();
    expect(warnings).toHaveLength(1);
    expect(telegramConfigFromEnv({ TELEGRAM_API_ID: "1", TELEGRAM_API_HASH: "h", TELEGRAM_SESSION_KEY: KEY }, warn)).toEqual({ ...CONFIG, apiHash: "h" });
    expect(telegramConfigFromEnv({ TELEGRAM_API_ID: "1", TELEGRAM_API_HASH: "h", TELEGRAM_SESSION_KEY: KEY, TELEGRAM_BOT_USERNAME: "@TestBot" }, warn)?.botUsername).toBe("TestBot");
  });
});

describe("feature off", () => {
  test("status unavailable, linking refused, messages still answer", async () => {
    const off = createService(null);
    expect(await off.status()).toEqual({ state: "unavailable" });
    await expect(off.startLink("Admin")).rejects.toMatchObject({ status: 503 });
    expect(await off.listMessages()).toEqual({ linked: false, messages: [] });
  });
});

describe("linking", () => {
  test("qr → linked stores the encrypted session and listens", async () => {
    const status = await service.startLink("Admin");
    expect(status).toEqual({ state: "qr", url: "tg://login?token=abc", expiresAt: "2026-10-17T20:00:30.000Z" });
    // A second press returns the running login
    expect((await service.startLink("Admin")).state).toBe("qr");
    expect(gateways).toHaveLength(1);

    gateways[0].qr.resolve("linked");
    await until(async () => (await service.status()).state === "linked");
    const linked = await service.status();
    expect(linked).toMatchObject({ state: "linked", account: { name: "Silke", username: "silke", phoneMasked: "+31 6 ••• 12" } });
    expect(linked.linkedAt).toBeString();

    const doc = await telegramLinkModel(realDb).findOne().lean();
    expect(JSON.stringify(doc)).not.toContain(SESSION);
    expect(decryptSession({ ciphertext: doc!.sessionCiphertext, iv: doc!.iv, tag: doc!.tag }, KEY)).toBe(SESSION);
    expect(doc!.linkedBy).toBe("Admin");
    expect(JSON.stringify(linked)).not.toContain(doc!.sessionCiphertext);
    expect(gateways[0].messageCallback).not.toBeNull();
    // Linking again is refused
    await expect(service.startLink("Admin")).rejects.toMatchObject({ status: 409 });
  });

  test("2FA: password state with hint, a wrong password keeps it, the right one links", async () => {
    await service.startLink("Admin");
    gateways[0].qr.resolve("password");
    await until(async () => (await service.status()).state === "password");
    expect(await service.status()).toEqual({ state: "password", hint: "naam van de hond" });

    const wrong = await service.submitPassword("fout").catch((error) => error);
    expect(wrong).toBeInstanceOf(ServiceError);
    expect(wrong).toMatchObject({ status: 400, message: "Wachtwoord klopt niet." });
    expect((await service.status()).state).toBe("password");

    expect((await service.submitPassword("geheim")).state).toBe("linked");
  });

  test("a password without a pending 2FA login is refused", async () => {
    await expect(service.submitPassword("geheim")).rejects.toMatchObject({ status: 409 });
  });

  test("a failed login is reported and leaves the state unlinked", async () => {
    prepare = (gateway) => {
      gateway.startQr = () => Promise.reject(new Error("API_ID_INVALID"));
    };
    await expect(service.startLink("Admin")).rejects.toMatchObject({ status: 502 });
    await until(() => gateways[0]?.cancelled === true);
    expect((await service.status()).state).toBe("unlinked");
  });

  test("unlink cancels a pending login", async () => {
    await service.startLink("Admin");
    await service.unlink();
    expect(gateways[0].cancelled).toBe(true);
    expect((await service.status()).state).toBe("unlinked");
  });

  test("unlink logs the session out and deletes the link", async () => {
    await service.startLink("Admin");
    gateways[0].qr.resolve("linked");
    await until(async () => (await service.status()).state === "linked");
    await service.unlink();
    expect(gateways[0].loggedOut).toBe(true);
    expect(gateways[0].cancelled).toBe(true);
    expect(await telegramLinkModel(realDb).countDocuments()).toBe(0);
    expect((await service.status()).state).toBe("unlinked");
  });
});

describe("listening", () => {
  test("on start a stored link connects with the decrypted session", async () => {
    await storeLink();
    const restarted = createService();
    await restarted.start();
    expect(gateways.at(-1)!.connectedWith).toBe(SESSION);
    expect((await restarted.status()).state).toBe("linked");
    await restarted.stop();
  });

  test("a revoked session at start removes the link", async () => {
    await storeLink();
    prepare = (gateway) => (gateway.connectError = new SessionRevokedError());
    const restarted = createService();
    await restarted.start();
    expect(await telegramLinkModel(realDb).countDocuments()).toBe(0);
    expect((await restarted.status()).state).toBe("unlinked");
    await restarted.stop();
  });

  test("connection errors are retried with backoff", async () => {
    await storeLink();
    let failures = 2;
    prepare = (gateway) => {
      if (failures-- > 0) gateway.connectError = new Error("network down");
    };
    const restarted = createService();
    await restarted.start();
    await until(() => gateways.some((gateway) => gateway.connectedWith === SESSION));
    expect(gateways).toHaveLength(3);
    await restarted.stop();
  });

  test("a session revoked while running removes the link", async () => {
    await service.startLink("Admin");
    gateways[0].qr.resolve("linked");
    await until(async () => (await service.status()).state === "linked");
    gateways[0].revokedCallback!();
    await until(async () => (await service.status()).state === "unlinked");
    expect(gateways[0].cancelled).toBe(true);
  });
});

describe("bot messages", () => {
  test("only the bot's messages are stored, newest first, with their kind", async () => {
    await service.handleMessage(botMessage(1, "Je hunt is goedgekeurd"));
    await service.handleMessage({ ...botMessage(2, "Hoi"), senderUsername: "iemand" });
    await service.handleMessage({ ...botMessage(3, "Nieuwe opdracht"), senderUsername: "jotihunt_BOT", date: new Date("2026-10-17T19:20:00Z") });
    await service.handleMessage({ id: 4, text: "geen afzender", date: new Date() });
    const { linked, messages } = await service.listMessages();
    expect(linked).toBe(false);
    expect(messages).toEqual([
      { id: "3", text: "Nieuwe opdracht", kind: "assignment", receivedAt: "2026-10-17T19:20:00.000Z" },
      { id: "1", text: "Je hunt is goedgekeurd", kind: "hunt-approved", receivedAt: "2026-10-17T19:14:00.000Z" },
    ]);
    expect(await AppNotification.countDocuments()).toBe(0);
  });

  test("a tegenhunt alerts once per Telegram message", async () => {
    await service.handleMessage(botMessage(10, "Er is een tegenhunt gestart, windrichting noordoost"));
    await service.handleMessage(botMessage(10, "Er is een tegenhunt gestart, windrichting noordoost"));
    const notifications = await AppNotification.find().lean();
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      type: "counter-hunt",
      title: "Tegenhunt! Richting NO ↗",
      urgent: true,
      data: { direction: 45, from: "Telegram", telegramId: 10, startedAt: "2026-10-17T19:14:00.000Z" },
    });
    expect(await telegramMessageModel(realDb).findOne({ telegramId: 10 }).lean()).toMatchObject({ kind: "tegenhunt", data: { direction: 45 } });
  });

  test("a tegenhunt without a recognised direction", async () => {
    await service.handleMessage(botMessage(11, "Tegenhunt! Succes."));
    expect(await AppNotification.findOne().lean()).toMatchObject({
      title: "Tegenhunt!",
      body: "Richting niet herkend, lees het bericht van de Jotihunt-bot.",
      data: { direction: null, text: "Tegenhunt! Succes.", telegramId: 11 },
    });
  });

  test("messages from the listener are handled; status shows the last one", async () => {
    await service.startLink("Admin");
    gateways[0].qr.resolve("linked");
    await until(async () => (await service.status()).state === "linked");
    gateways[0].messageCallback!(botMessage(20, "Happy hour!"));
    await until(async () => (await service.listMessages()).messages.length === 1);
    expect(await service.status()).toMatchObject({ state: "linked", lastMessageAt: "2026-10-17T19:14:00.000Z" });
    expect((await service.listMessages()).linked).toBe(true);
  });
});

describe("catch-up", () => {
  const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);

  test("on start the latest bot messages are read; only a tegenhunt within its 30 minutes alerts", async () => {
    await storeLink();
    prepare = (gateway) => {
      gateway.history = [
        { id: 33, senderUsername: "Jotihunt_bot", text: "Tegenhunt, windrichting west", date: minutesAgo(5) },
        { id: 32, senderUsername: "iemand", text: "Tegenhunt uit het noorden", date: minutesAgo(10) },
        { id: 31, senderUsername: "Jotihunt_bot", text: "Tegenhunt, windrichting oost", date: minutesAgo(40) },
        { id: 30, senderUsername: "Jotihunt_bot", text: "Je hunt is goedgekeurd", date: minutesAgo(50) },
      ];
    };
    const restarted = createService();
    await restarted.start();
    await until(async () => (await restarted.listMessages()).messages.length === 3);
    expect((await restarted.listMessages()).messages.map((message) => message.id)).toEqual(["33", "31", "30"]);
    const notifications = await AppNotification.find().lean();
    expect(notifications).toHaveLength(1);
    expect(notifications[0].data).toMatchObject({ direction: 270, telegramId: 33 });

    // A second connect reads the same messages again: nothing new
    const again = createService();
    await again.start();
    await Bun.sleep(50);
    expect(await AppNotification.countDocuments()).toBe(1);
    expect((await again.listMessages()).messages).toHaveLength(3);
    await again.stop();
    await restarted.stop();
  });

  test("after linking the bot chat is read too", async () => {
    prepare = (gateway) => {
      gateway.history = [{ id: 40, senderUsername: "Jotihunt_bot", text: "Nieuwe opdracht", date: minutesAgo(1) }];
    };
    await service.startLink("Admin");
    gateways[0].qr.resolve("linked");
    await until(async () => (await service.listMessages()).messages.length === 1);
  });

  test("happy-hour messages go to the happy hour service", async () => {
    const received: number[] = [];
    const withHappyHour = new TelegramService({
      config: CONFIG,
      connection: realDb,
      gateway: () => new FakeGateway(),
      logger,
      happyHour: { handleMessage: async (message) => void received.push(message.telegramId) },
    });
    await withHappyHour.handleMessage(botMessage(50, "Happy hour van 21:00 tot 22:00"));
    await withHappyHour.handleMessage(botMessage(50, "Happy hour van 21:00 tot 22:00"));
    await withHappyHour.handleMessage(botMessage(51, "Nieuwe opdracht"));
    expect(received).toEqual([50]);
  });
});

