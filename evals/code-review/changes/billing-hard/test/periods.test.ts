import assert from "node:assert/strict";
import { test } from "node:test";
import { addIntervals, daysBetween } from "../src/periods.ts";

test("monthly periods keep the anchor day and clamp it in short months", () => {
  const jan31 = new Date("2026-01-31T09:30:00.000Z");
  const feb = addIntervals(jan31, "month", 1, 31);
  assert.equal(feb.toISOString(), "2026-02-28T09:30:00.000Z");
  assert.equal(addIntervals(feb, "month", 1, 31).toISOString(), "2026-03-31T09:30:00.000Z");
});

test("a yearly period from Feb 29 ends on Feb 28", () => {
  const leap = new Date("2028-02-29T00:00:00.000Z");
  assert.equal(addIntervals(leap, "year", 1, 29).toISOString(), "2029-02-28T00:00:00.000Z");
});

test("a monthly period crosses the year end", () => {
  const dec15 = new Date("2026-12-15T00:00:00.000Z");
  assert.equal(addIntervals(dec15, "month", 1, 15).toISOString(), "2027-01-15T00:00:00.000Z");
});

test("daysBetween counts a started day as a whole day", () => {
  const start = new Date("2026-03-01T10:00:00.000Z");
  assert.equal(daysBetween(start, new Date("2026-03-15T10:00:00.000Z")), 14);
  assert.equal(daysBetween(start, new Date("2026-03-15T09:00:00.000Z")), 14);
  assert.equal(daysBetween(start, new Date("2026-03-01T10:00:00.001Z")), 1);
  assert.equal(daysBetween(start, start), 0);
});

test("a calendar month is its number of days", () => {
  const march = new Date("2026-03-15T00:00:00.000Z");
  assert.equal(daysBetween(march, addIntervals(march, "month", 1, 15)), 31);
  const february = new Date("2026-02-15T00:00:00.000Z");
  assert.equal(daysBetween(february, addIntervals(february, "month", 1, 15)), 28);
});
