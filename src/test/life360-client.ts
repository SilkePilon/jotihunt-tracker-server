import { Life360NotFoundError, type Life360Api, type Life360MembersResult } from "../services/life360.client";
import type { Life360Circle } from "../services/life360.helpers";

/** The access token the fake hands out (secret in real life) */
export const TOKEN = "life360-token-secret";

/** Life360Api without network: tests set answers and errors, and read what was called. */
export class FakeLife360Client implements Life360Api {
  calls: string[] = [];
  sendError: Error | null = null;
  verifyError: Error | null = null;
  meError: Error | null = null;
  circlesError: Error | null = null;
  email: string | null = "jotihunt@example.nl";
  circleList: Life360Circle[] = [{ id: "c1", name: "Jotihunt" }];
  /** Answers of members(), in order; the last one repeats. Empty: no members. */
  memberAnswers: (Life360MembersResult | Error)[] = [];
  memberRequests: { token: string; circleId: string; etag: string | undefined }[] = [];
  /** When set, members() waits for it before answering */
  hold: Promise<void> | null = null;
  requested: string[] = [];
  requestErrors = new Map<string, Error>();
  /** Avatar images by Life360 URL; unknown URLs: NotFound */
  avatars = new Map<string, { contentType: string; body: Buffer }>();
  avatarCalls = 0;

  async sendCode(email: string, deviceId: string) {
    this.calls.push(`send ${email} ${deviceId}`);
    if (this.sendError) throw this.sendError;
    return { transactionId: "tx-1" };
  }

  async verifyCode(transactionId: string, code: string) {
    this.calls.push(`verify ${transactionId} ${code}`);
    if (this.verifyError) throw this.verifyError;
    return TOKEN;
  }

  async me(token: string) {
    this.calls.push(`me ${token}`);
    if (this.meError) throw this.meError;
    return { email: this.email };
  }

  async circles(token: string) {
    this.calls.push(`circles ${token}`);
    if (this.circlesError) throw this.circlesError;
    return this.circleList;
  }

  async members(token: string, circleId: string, etag?: string): Promise<Life360MembersResult> {
    this.memberRequests.push({ token, circleId, etag });
    if (this.hold) await this.hold;
    const answer = this.memberAnswers.length > 1 ? this.memberAnswers.shift()! : this.memberAnswers[0];
    if (!answer) return { notModified: false, etag: null, members: [] };
    if (answer instanceof Error) throw answer;
    return answer;
  }

  async requestLocation(_token: string, _circleId: string, memberId: string) {
    this.requested.push(memberId);
    const error = this.requestErrors.get(memberId);
    if (error) throw error;
  }

  async avatar(url: string) {
    this.avatarCalls++;
    const image = this.avatars.get(url);
    if (!image) throw new Life360NotFoundError();
    return image;
  }
}
