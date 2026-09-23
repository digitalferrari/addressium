/**
 * Recurring-schedule helpers behind the human-readable campaign date picker.
 *
 * These shipped with no coverage at all: `buildEventBridgeCron`,
 * `parseEventBridgeCron` and `describeSchedule` were referenced only by
 * `scheduling.ts` itself and the three admin screens, so a full green suite
 * said nothing about them. They translate operator intent into an expression
 * AWS either accepts or rejects outright, and a bad one fails at schedule
 * creation rather than at compile time — hence the emphasis below on the
 * wildcard rule and on round-tripping every shape the picker can emit.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildEventBridgeCron,
  parseEventBridgeCron,
  describeSchedule,
  formatTimeOfDay,
  DAYS_OF_WEEK,
  type DayOfWeek,
  type RecurringScheduleConfig,
} from "@addressium/domain";

/** The six shapes the Compose picker can produce. */
const SHAPES: RecurringScheduleConfig[] = [
  { frequency: "daily", timeOfDay: "07:00" },
  { frequency: "weekdays", timeOfDay: "13:30" },
  { frequency: "weekends", timeOfDay: "09:05" },
  { frequency: "custom", daysOfWeek: ["MON", "WED", "FRI"], timeOfDay: "06:00" },
  { frequency: "custom", daysOfWeek: [], timeOfDay: "08:00" },
  { frequency: "custom", daysOfWeek: ["SAT", "SUN"], timeOfDay: "10:00" },
];

const ALL_DAYS: DayOfWeek[] = DAYS_OF_WEEK.map((d) => d.id);

/** Which named frequency a config normalises to once it has been through a cron expression. */
function expectedFrequency(shape: RecurringScheduleConfig): RecurringScheduleConfig["frequency"] {
  if (shape.frequency !== "custom") return shape.frequency;
  const days = shape.daysOfWeek ?? [];
  if (days.length === 0 || days.length === 7) return "daily";
  if (days.length === 5 && !days.includes("SAT") && !days.includes("SUN")) return "weekdays";
  if (days.length === 2 && days.includes("SAT") && days.includes("SUN")) return "weekends";
  return "custom";
}

test("each frequency emits the expected EventBridge expression", () => {
  assert.equal(buildEventBridgeCron({ frequency: "daily", timeOfDay: "07:00" }), "cron(0 7 * * ? *)");
  assert.equal(buildEventBridgeCron({ frequency: "weekdays", timeOfDay: "13:30" }), "cron(30 13 ? * MON-FRI *)");
  assert.equal(buildEventBridgeCron({ frequency: "weekends", timeOfDay: "09:05" }), "cron(5 9 ? * SAT,SUN *)");
  assert.equal(
    buildEventBridgeCron({ frequency: "custom", daysOfWeek: ["MON", "WED", "FRI"], timeOfDay: "06:00" }),
    "cron(0 6 ? * MON,WED,FRI *)",
  );
});

test("day-of-month and day-of-week are never both wildcards", () => {
  // The rule AWS rejects an expression over: exactly one of the two fields
  // must be '?'. Asserted across every shape rather than case by case, so a
  // new frequency cannot quietly violate it.
  for (const shape of SHAPES) {
    const cron = buildEventBridgeCron(shape);
    const fields = cron.replace(/^cron\(/, "").replace(/\)$/, "").split(/\s+/);
    assert.equal(fields.length, 6, `expected 6 fields in ${cron}`);
    const [, , dom, , dow] = fields;
    const wildcards = [dom, dow].filter((f) => f === "*").length;
    const marks = [dom, dow].filter((f) => f === "?").length;
    assert.equal(marks, 1, `exactly one of day-of-month/day-of-week must be '?' in ${cron}`);
    assert.ok(wildcards <= 1, `day-of-month and day-of-week cannot both be '*' in ${cron}`);
  }
});

test("custom day selections collapse onto the canonical forms", () => {
  const at = (daysOfWeek: DayOfWeek[]) =>
    buildEventBridgeCron({ frequency: "custom", daysOfWeek, timeOfDay: "09:00" });

  assert.equal(at(ALL_DAYS), "cron(0 9 * * ? *)", "all seven days is just daily");
  assert.equal(at(["MON", "TUE", "WED", "THU", "FRI"]), "cron(0 9 ? * MON-FRI *)");
  assert.equal(at(["SAT", "SUN"]), "cron(0 9 ? * SAT,SUN *)");
});

test("selecting no custom days falls back to daily", () => {
  // The Compose picker starts "Custom Days" with nothing selected, so this is
  // reachable from the UI. It is deliberate, and the screen warns about it —
  // pinned here so the fallback cannot change silently.
  assert.equal(
    buildEventBridgeCron({ frequency: "custom", daysOfWeek: [], timeOfDay: "08:00" }),
    "cron(0 8 * * ? *)",
  );
  assert.equal(
    describeSchedule({ frequency: "custom", daysOfWeek: [], timeOfDay: "08:00" }),
    "Every day at 8:00 AM",
  );
});

test("days are emitted in week order, not click order", () => {
  assert.equal(
    buildEventBridgeCron({ frequency: "custom", daysOfWeek: ["FRI", "MON", "WED"], timeOfDay: "06:00" }),
    "cron(0 6 ? * MON,WED,FRI *)",
  );
});

test("out-of-range times are clamped rather than emitted as invalid", () => {
  assert.equal(buildEventBridgeCron({ frequency: "daily", timeOfDay: "99:99" }), "cron(59 23 * * ? *)");
  assert.equal(buildEventBridgeCron({ frequency: "daily", timeOfDay: "" }), "cron(0 7 * * ? *)");
});

test("every generated expression parses back to its original config", () => {
  for (const shape of SHAPES) {
    const cron = buildEventBridgeCron(shape);
    const parsed = parseEventBridgeCron(cron);
    assert.ok(parsed, `${cron} should parse`);
    assert.equal(parsed.timeOfDay, shape.timeOfDay, `time should survive ${cron}`);
    // A custom selection is normalised to whichever named frequency describes
    // it: no days (and all seven) mean daily, Mon–Fri means weekdays, Sat+Sun
    // means weekends. The schedule is identical either way; only the label
    // the picker will reopen with differs.
    assert.equal(parsed.frequency, expectedFrequency(shape), `frequency should survive ${cron}`);
  }
});

test("a custom expression round-trips its exact day set", () => {
  const parsed = parseEventBridgeCron("cron(0 6 ? * MON,WED,FRI *)");
  assert.ok(parsed);
  assert.equal(parsed.frequency, "custom");
  assert.deepEqual(parsed.daysOfWeek, ["MON", "WED", "FRI"]);
  assert.equal(parsed.timeOfDay, "06:00");
});

test("numeric day spellings are recognised", () => {
  assert.equal(parseEventBridgeCron("cron(0 9 ? * 2-6 *)")?.frequency, "weekdays");
  assert.equal(parseEventBridgeCron("cron(0 9 ? * 1,7 *)")?.frequency, "weekends");
  assert.equal(parseEventBridgeCron("cron(0 9 ? * SUN,SAT *)")?.frequency, "weekends");
});

test("expressions that are not recognisable schedules return null", () => {
  for (const bad of [
    "",
    "not a cron",
    "cron(0 9 * * *)", // five fields, not six
    "rate(1 day)",
    "cron(60 9 * * ? *)", // minute out of range
    "cron(0 24 * * ? *)", // hour out of range
    "cron(0 9 ? * FUNDAY *)", // not a day
    "cron(0 9 15 * ? *)", // day-of-month schedules are not a picker shape
  ]) {
    assert.equal(parseEventBridgeCron(bad), null, `${bad || "(empty)"} should not parse`);
  }
});

test("times render in 12-hour form", () => {
  assert.equal(formatTimeOfDay("00:00"), "12:00 AM");
  assert.equal(formatTimeOfDay("12:00"), "12:00 PM");
  assert.equal(formatTimeOfDay("13:05"), "1:05 PM");
  assert.equal(formatTimeOfDay("09:30"), "9:30 AM");
  assert.equal(formatTimeOfDay("nonsense"), "nonsense", "unparseable input is passed through");
});

test("schedules describe themselves in English", () => {
  assert.equal(describeSchedule({ frequency: "daily", timeOfDay: "07:00" }), "Every day at 7:00 AM");
  assert.equal(
    describeSchedule({ frequency: "weekdays", timeOfDay: "13:30" }),
    "Every weekday (Mon–Fri) at 1:30 PM",
  );
  assert.equal(
    describeSchedule({ frequency: "weekends", timeOfDay: "09:05" }),
    "Every weekend (Sat, Sun) at 9:05 AM",
  );
  assert.equal(
    describeSchedule({ frequency: "custom", daysOfWeek: ["MON", "WED", "FRI"], timeOfDay: "06:00" }),
    "Every Mon, Wed, Fri at 6:00 AM",
  );
});

test("a cron string can be described directly, with its timezone", () => {
  assert.equal(describeSchedule("cron(0 13 ? * MON-FRI *)"), "Every weekday (Mon–Fri) at 1:00 PM");
  assert.equal(
    describeSchedule("cron(0 13 ? * MON-FRI *)", "America/Denver"),
    "Every weekday (Mon–Fri) at 1:00 PM (America/Denver)",
  );
});

test("an unrecognisable cron is echoed rather than throwing", () => {
  // The campaign and schedule lists render whatever the API returns, including
  // expressions written before the picker existed. They must not crash.
  assert.equal(describeSchedule("cron(0 9 15 * ? *)"), "cron(0 9 15 * ? *)");
  assert.equal(
    describeSchedule("rate(1 day)", "America/Denver"),
    "rate(1 day) (America/Denver)",
  );
});
