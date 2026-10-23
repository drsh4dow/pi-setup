export type Interval = "month" | "year";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Returns the instant `count` intervals after `start`, on the billing anchor day. A month
 * shorter than the anchor day ends the period on its last day, and the next period goes
 * back to the anchor: Jan 31 -> Feb 28 -> Mar 31. The time of day is kept.
 */
export function addIntervals(start: Date, interval: Interval, count: number, anchorDay: number): Date {
  const months = interval === "month" ? count : count * 12;
  const year = start.getUTCFullYear();
  const month = start.getUTCMonth() + months;
  const lastDayOfMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(
    Date.UTC(
      year,
      month,
      Math.min(anchorDay, lastDayOfMonth),
      start.getUTCHours(),
      start.getUTCMinutes(),
      start.getUTCSeconds(),
      start.getUTCMilliseconds(),
    ),
  );
}

/** Returns the instant `days` whole days after `at`. */
export function addDays(at: Date, days: number): Date {
  return new Date(at.getTime() + days * DAY_MS);
}

/**
 * Returns the days from `from` to `to`, counting a day that has started as a whole day:
 * 13 days and 1 hour is 14. Billing never charges for part of a day.
 */
export function daysBetween(from: Date, to: Date): number {
  return Math.ceil((to.getTime() - from.getTime()) / DAY_MS);
}
