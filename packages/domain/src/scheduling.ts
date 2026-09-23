/**
 * Scheduling policy (docs/ARCHITECTURE.md §4.6).
 *
 * One-off sends are ALWAYS placed at least `MIN_ONEOFF_LEAD_MS` into the future
 * — even "send now" — so there is a window to hit cancel before anything goes
 * out. A requested time further out is honored as-is.
 */

/** Minimum lead time for a one-off send: 5 minutes. */
export const MIN_ONEOFF_LEAD_MS = 5 * 60 * 1000;

export function effectiveOneOffTime(
  now: Date,
  requestedAt?: Date,
  minLeadMs: number = MIN_ONEOFF_LEAD_MS,
): Date {
  const floor = new Date(now.getTime() + minLeadMs);
  if (requestedAt && requestedAt.getTime() > floor.getTime()) return requestedAt;
  return floor;
}

export type DayOfWeek = "MON" | "TUE" | "WED" | "THU" | "FRI" | "SAT" | "SUN";

export const DAYS_OF_WEEK: { id: DayOfWeek; label: string; shortLabel: string }[] = [
  { id: "MON", label: "Monday", shortLabel: "Mon" },
  { id: "TUE", label: "Tuesday", shortLabel: "Tue" },
  { id: "WED", label: "Wednesday", shortLabel: "Wed" },
  { id: "THU", label: "Thursday", shortLabel: "Thu" },
  { id: "FRI", label: "Friday", shortLabel: "Fri" },
  { id: "SAT", label: "Saturday", shortLabel: "Sat" },
  { id: "SUN", label: "Sunday", shortLabel: "Sun" },
];

export type RecurringFrequency = "daily" | "weekdays" | "weekends" | "custom" | "hourly";

export interface RecurringScheduleConfig {
  frequency: RecurringFrequency;
  daysOfWeek?: DayOfWeek[];
  timeOfDay: string; // "HH:MM" 24h format, e.g. "07:00" or "13:30"
}

export function formatTimeOfDay(timeOfDay: string): string {
  const parts = timeOfDay.split(":");
  const hour = parseInt(parts[0] ?? "0", 10);
  const min = parseInt(parts[1] ?? "0", 10);
  if (isNaN(hour) || isNaN(min)) return timeOfDay;
  const ampm = hour >= 12 ? "PM" : "AM";
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  const minStr = min < 10 ? `0${min}` : `${min}`;
  return `${h12}:${minStr} ${ampm}`;
}

/**
 * Builds a 6-field AWS EventBridge Scheduler cron expression.
 * EventBridge rule: Day-of-month and Day-of-week cannot both be wildcards; one must be '?'.
 */
export function buildEventBridgeCron(config: RecurringScheduleConfig): string {
  const parts = (config.timeOfDay || "07:00").split(":");
  const hour = Math.max(0, Math.min(23, parseInt(parts[0] ?? "0", 10) || 0));
  const min = Math.max(0, Math.min(59, parseInt(parts[1] ?? "0", 10) || 0));

  switch (config.frequency) {
    case "hourly":
      return `cron(${min} * * * ? *)`;
    case "daily":
      return `cron(${min} ${hour} * * ? *)`;
    case "weekdays":
      return `cron(${min} ${hour} ? * MON-FRI *)`;
    case "weekends":
      return `cron(${min} ${hour} ? * SAT,SUN *)`;
    case "custom": {
      const selected = new Set(config.daysOfWeek ?? []);
      const ordered = DAYS_OF_WEEK.map((d) => d.id).filter((d) => selected.has(d));
      if (ordered.length === 0 || ordered.length === 7) {
        return `cron(${min} ${hour} * * ? *)`;
      }
      if (ordered.length === 5 && !ordered.includes("SAT") && !ordered.includes("SUN")) {
        return `cron(${min} ${hour} ? * MON-FRI *)`;
      }
      if (ordered.length === 2 && ordered.includes("SAT") && ordered.includes("SUN")) {
        return `cron(${min} ${hour} ? * SAT,SUN *)`;
      }
      return `cron(${min} ${hour} ? * ${ordered.join(",")} *)`;
    }
  }
}

/**
 * Parses an AWS EventBridge cron expression into a RecurringScheduleConfig,
 * or returns null if the expression does not match standard newsletter recurring patterns.
 */
export function parseEventBridgeCron(cron: string): RecurringScheduleConfig | null {
  const match = cron.trim().match(/^cron\(\s*(\d{1,2})\s+(\d{1,2}|\*)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s*\)$/i);
  if (!match) return null;
  const min = parseInt(match[1]!, 10);
  const hourStr = match[2]!;

  if (isNaN(min) || min < 0 || min > 59) return null;
  const dom = match[3]!;
  const dow = match[5]!.toUpperCase();

  if (hourStr === "*") {
    if (dom === "*" && dow === "?") {
      const timeOfDay = `00:${min < 10 ? `0${min}` : min}`;
      return { frequency: "hourly", timeOfDay };
    }
    return null;
  }

  const hour = parseInt(hourStr, 10);
  if (isNaN(hour) || hour < 0 || hour > 23) return null;
  const timeOfDay = `${hour < 10 ? `0${hour}` : hour}:${min < 10 ? `0${min}` : min}`;

  if (dom === "*" && dow === "?") {
    return { frequency: "daily", timeOfDay };
  }
  if (dom === "?" && (dow === "MON-FRI" || dow === "2-6")) {
    return { frequency: "weekdays", timeOfDay };
  }
  if (dom === "?" && (dow === "SAT,SUN" || dow === "SUN,SAT" || dow === "1,7" || dow === "7,1")) {
    return { frequency: "weekends", timeOfDay };
  }

  const validDays = new Set<DayOfWeek>(["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"]);
  const dayTokens = dow.split(",").map((s) => s.trim());
  if (dayTokens.length > 0 && dayTokens.every((d) => validDays.has(d as DayOfWeek))) {
    const days = DAYS_OF_WEEK.map((d) => d.id).filter((d) => dayTokens.includes(d));
    return { frequency: "custom", daysOfWeek: days, timeOfDay };
  }

  return null;
}

/**
 * Returns an English description of a recurring schedule or cron expression.
 */
export function describeSchedule(
  schedule: RecurringScheduleConfig | string,
  timezone?: string,
): string {
  const config = typeof schedule === "string" ? parseEventBridgeCron(schedule) : schedule;
  const tzSuffix = timezone ? ` (${timezone})` : "";

  if (!config) {
    return typeof schedule === "string" ? `${schedule}${tzSuffix}` : `Custom schedule${tzSuffix}`;
  }

  const timeStr = formatTimeOfDay(config.timeOfDay);
  switch (config.frequency) {
    case "hourly": {
      const parts = config.timeOfDay.split(":");
      const minStr = parts[1] || "00";
      return `Every hour at minute ${minStr}${tzSuffix}`;
    }
    case "daily":
      return `Every day at ${timeStr}${tzSuffix}`;
    case "weekdays":
      return `Every weekday (Mon–Fri) at ${timeStr}${tzSuffix}`;
    case "weekends":
      return `Every weekend (Sat, Sun) at ${timeStr}${tzSuffix}`;
    case "custom": {
      const days = config.daysOfWeek ?? [];
      if (days.length === 0 || days.length === 7) {
        return `Every day at ${timeStr}${tzSuffix}`;
      }
      const dayLabels = DAYS_OF_WEEK.filter((d) => days.includes(d.id)).map((d) => d.shortLabel);
      return `Every ${dayLabels.join(", ")} at ${timeStr}${tzSuffix}`;
    }
  }
}

/**
 * Construct a local Date for a target timezone from specific calendar parts.
 */
function dateInTimezone(year: number, month: number, day: number, hour: number, minute: number, timezone: string): Date {
  const pad = (n: number) => String(n).padStart(2, "0");
  const isoStr = `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:00`;
  if (!timezone) return new Date(isoStr + "Z");
  const utcDate = new Date(isoStr + "Z");
  const tzFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric", month: "numeric", day: "numeric",
    hour: "numeric", minute: "numeric", second: "numeric",
    hour12: false
  });
  const parts = tzFormatter.formatToParts(utcDate);
  const findPart = (type: string) => parts.find(p => p.type === type)?.value || "0";
  const tzYear = parseInt(findPart("year"), 10);
  const tzMonth = parseInt(findPart("month"), 10);
  const tzDay = parseInt(findPart("day"), 10);
  const tzHour = parseInt(findPart("hour"), 10);
  const tzMin = parseInt(findPart("minute"), 10);
  const gotDate = new Date(Date.UTC(tzYear, tzMonth - 1, tzDay, tzHour, tzMin));
  const diffMs = utcDate.getTime() - gotDate.getTime();
  return new Date(utcDate.getTime() + diffMs);
}

/**
 * Get uppercase short weekday in target timezone.
 */
function getDayOfWeekInTimezone(date: Date, timezone: string): string {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone || "UTC",
    weekday: "short"
  });
  return formatter.format(date).toUpperCase();
}

/**
 * Predicts the next N run times of a recurring campaign.
 */
export function getNextRuns(
  config: RecurringScheduleConfig,
  timezone?: string,
  limit: number = 60
): Date[] {
  const runs: Date[] = [];
  const parts = config.timeOfDay.split(":");
  const targetHour = parseInt(parts[0] ?? "0", 10);
  const targetMin = parseInt(parts[1] ?? "0", 10);

  if (config.frequency === "hourly") {
    const current = new Date();
    current.setSeconds(0, 0);
    current.setMinutes(targetMin);
    if (current.getTime() <= Date.now()) {
      current.setHours(current.getHours() + 1);
    }
    for (let i = 0; i < limit; i++) {
      runs.push(new Date(current));
      current.setHours(current.getHours() + 1);
    }
    return runs;
  }

  const now = new Date();
  let searchDate = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  for (let dayOffset = 0; dayOffset < 365 && runs.length < limit; dayOffset++) {
    const year = searchDate.getFullYear();
    const month = searchDate.getMonth() + 1;
    const day = searchDate.getDate();
    const runTime = dateInTimezone(year, month, day, targetHour, targetMin, timezone || "");
    if (runTime.getTime() > now.getTime()) {
      const dow = getDayOfWeekInTimezone(runTime, timezone || "");
      let matches = false;
      if (config.frequency === "daily") {
        matches = true;
      } else if (config.frequency === "weekdays") {
        matches = ["MON", "TUE", "WED", "THU", "FRI"].includes(dow);
      } else if (config.frequency === "weekends") {
        matches = ["SAT", "SUN"].includes(dow);
      } else if (config.frequency === "custom") {
        matches = (config.daysOfWeek ?? []).includes(dow as any);
      }
      if (matches) runs.push(runTime);
    }
    searchDate.setDate(searchDate.getDate() + 1);
  }
  return runs;
}
