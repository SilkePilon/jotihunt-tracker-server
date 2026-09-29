import type { ApiArticle } from "../../types/api";
import { ARTICLE_ID_OFFSET, HOUR_MS, MINUTE_MS } from "./constants";

/** Hunt start of the demo world: 6 hours before `now`, rounded down to the hour. */
export function demoHuntStart(now: Date): Date {
  const start = new Date(now.getTime() - 6 * HOUR_MS);
  start.setUTCMinutes(0, 0, 0);
  return start;
}

/**
 * Re-time the real 2025 articles into the demo world: the hints (oldest first) at hunt start + 0 h, + 1 h, …, the
 * assignments and news spread over the gap they were in (before the first hint: the 45 minutes before hunt start;
 * after the last hint: its first 45 minutes). Ids are offset by 800000; an assignment keeps its duration.
 */
export function retimeArticles(articles: ApiArticle[], huntStart: Date): ApiArticle[] {
  const sorted = [...articles].sort((a, b) => new Date(a.publish_at).getTime() - new Date(b.publish_at).getTime() || a.id - b.id);
  const hintTimes = new Map<number, number>();
  sorted.filter((article) => article.type === "hint").forEach((article, index) => hintTimes.set(article.id, huntStart.getTime() + index * HOUR_MS));

  // Group the other articles by the gap (index of the preceding hint, -1 before the first)
  const gaps = new Map<number, ApiArticle[]>();
  let gap = -1;
  for (const article of sorted) {
    if (article.type === "hint") {
      gap++;
      continue;
    }
    gaps.set(gap, [...(gaps.get(gap) ?? []), article]);
  }
  const times = new Map(hintTimes);
  for (const [index, members] of gaps) {
    const from = index < 0 ? huntStart.getTime() - 45 * MINUTE_MS : huntStart.getTime() + index * HOUR_MS;
    const span = index < 0 || index === hintTimes.size - 1 ? 45 * MINUTE_MS : HOUR_MS;
    members.forEach((article, position) => {
      const time = from + Math.round(((position + 1) * span) / (members.length + 1) / MINUTE_MS) * MINUTE_MS;
      times.set(article.id, time);
    });
  }

  return sorted.map((article) => {
    const publish = times.get(article.id)!;
    const shift = publish - new Date(article.publish_at).getTime();
    const endTime = article.message.end_time ? new Date(new Date(article.message.end_time).getTime() + shift).toISOString() : article.message.end_time;
    return {
      ...article,
      id: article.id + ARTICLE_ID_OFFSET,
      publish_at: new Date(publish).toISOString(),
      message: { ...article.message, end_time: endTime },
    };
  });
}
