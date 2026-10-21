import { describe, expect, it } from "vitest";
import { parseReminderText, previewDue } from "./due";
import { describeDue } from "./format";

// Wednesday 21 October 2026, 14:30 local time.
const NOW = new Date(2026, 9, 21, 14, 30);
const at = (m: number, d: number, h?: number, min = 0) => (h === undefined ? new Date(2026, m, d) : new Date(2026, m, d, h, min));

function check(text: string, title: string, due: Date | undefined, allDay: boolean) {
  const p = parseReminderText(text, NOW);
  expect(p.title, text).toBe(title);
  expect(p.due?.getTime(), text).toBe(due?.getTime());
  if (due) expect(p.allDay, text).toBe(allDay);
}

describe("parseReminderText", () => {
  it("leaves plain titles alone", () => {
    check("Buy milk", "Buy milk", undefined, false);
    check("Take 2 pills a day", "Take 2 pills a day", undefined, false);
    check("Add 1/2 cup sugar to the list", "Add 1/2 cup sugar to the list", undefined, false);
    check("sun cream and sat nav", "sun cream and sat nav", undefined, false);
  });

  it("day words", () => {
    check("Call mom tomorrow", "Call mom", at(9, 22), true);
    check("Call mom tomorrow 9am", "Call mom", at(9, 22, 9), false);
    check("tomorrow at 9:30 pm pay rent", "pay rent", at(9, 22, 21, 30), false);
    check("Submit report today", "Submit report", at(9, 21), true);
    check("Take out trash tonight", "Take out trash", at(9, 21, 20), false);
    check("water plants the day after tomorrow", "water plants", at(9, 23), true);
    check("gym tomorrow morning", "gym", at(9, 22, 9), false);
  });

  it("relative offsets", () => {
    check("Check oven in 20 minutes", "Check oven", new Date(NOW.getTime() + 20 * 60_000), false);
    check("in 2 hours stretch", "stretch", new Date(NOW.getTime() + 2 * 3_600_000), false);
    check("follow up in an hour", "follow up", new Date(NOW.getTime() + 3_600_000), false);
    check("follow up in half an hour", "follow up", new Date(NOW.getTime() + 1_800_000), false);
    check("renew passport in 3 days", "renew passport", at(9, 24), true);
    check("dentist in 2 weeks", "dentist", at(10, 4), true);
    check("review in 1 month", "review", at(10, 21), true);
  });

  it("weekdays", () => {
    check("Team lunch next friday", "Team lunch", at(9, 23), true);
    check("Team lunch friday at noon", "Team lunch", at(9, 23, 12), false);
    check("standup on mon 10am", "standup", at(9, 26, 10), false);
    check("water plants wednesday", "water plants", at(9, 28), true); // today is Wednesday → next week
    check("this wednesday 6pm dinner", "dinner", at(9, 21, 18), false);
    check("plan trip next week", "plan trip", at(9, 26), true);
    check("clean garage this weekend", "clean garage", at(9, 24), true);
  });

  it("calendar dates", () => {
    check("Buy gifts dec 20", "Buy gifts", at(11, 20), true);
    check("Buy gifts on December 20th at 5pm", "Buy gifts", at(11, 20, 17), false);
    check("tax 15 april", "tax", new Date(2027, 3, 15), true); // already past this year
    check("party 2026-11-01", "party", at(10, 1), true);
    check("vet 11/3", "vet", at(10, 3), true);
    check("vet on 11/3/2027", "vet", new Date(2027, 10, 3), true);
  });

  it("times without dates", () => {
    check("Call Sam at 5pm", "Call Sam", at(9, 21, 17), false);
    check("Call Sam at 9am", "Call Sam", at(9, 22, 9), false); // already past today
    check("Standup 17:45", "Standup", at(9, 21, 17, 45), false);
    check("Call Sam at 4", "Call Sam", at(9, 21, 16), false);
    check("Lunch at noon", "Lunch", at(9, 22, 12), false);
    check("Read in the evening", "Read", at(9, 21, 18), false);
    check("Ship 5p", "Ship", at(9, 21, 17), false);
  });

  it("strips helper words and keeps the title when the whole text is a date", () => {
    check("remind me to call Bob tomorrow", "call Bob", at(9, 22), true);
    check("Pay invoice by friday", "Pay invoice", at(9, 23), true);
    check("tomorrow", "tomorrow", at(9, 22), true);
  });

  it("previews", () => {
    expect(previewDue(parseReminderText("x tomorrow 9am", NOW), NOW)).toBe("Due Tomorrow, 9:00 AM");
    expect(previewDue(parseReminderText("x", NOW), NOW)).toBe("No due date");
    expect(describeDue(at(9, 21), true, NOW)).toBe("Today");
    expect(describeDue(at(9, 24), true, NOW)).toBe("Saturday");
    expect(describeDue(at(9, 20, 8), false, NOW)).toBe("Yesterday, 8:00 AM");
    expect(describeDue(new Date(2027, 0, 5), true, NOW)).toBe("Tue, Jan 5, 2027");
  });
});
