const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 24 * 60 * 60],
  ["month", 30 * 24 * 60 * 60],
  ["week", 7 * 24 * 60 * 60],
  ["day", 24 * 60 * 60],
  ["hour", 60 * 60],
  ["minute", 60],
];

const format = new Intl.RelativeTimeFormat(undefined, { numeric: "auto", style: "short" });

/** "3 hr. ago", "yesterday", "just now": for lists, where the exact time is a tooltip. */
export function relativeTime(iso: string, now = Date.now()): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const seconds = Math.round((then - now) / 1000);
  for (const [unit, size] of UNITS) {
    if (Math.abs(seconds) >= size) return format.format(Math.round(seconds / size), unit);
  }
  return "just now";
}

/** The full local date and time, for the tooltip behind a relative time. */
export function absoluteTime(iso: string): string {
  const when = new Date(iso);
  return Number.isNaN(when.getTime()) ? "" : when.toLocaleString();
}

/**
 * "3:47 PM" today, "Sep 27, 3:47 PM" before that, with the year once it is not
 * this one: a stamp that stays true on a screen that is not re-rendered as time
 * passes, unlike a relative one.
 */
export function shortTime(iso: string, now = new Date()): string {
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return "";
  const time = when.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (when.toDateString() === now.toDateString()) return time;
  const date = when.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: when.getFullYear() === now.getFullYear() ? undefined : "numeric",
  });
  return `${date}, ${time}`;
}
