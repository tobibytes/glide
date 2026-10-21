import { describe, expect, it } from "vitest";
import { dayKeys, findMeetingLink, isJoinable, matchesJoinQuery, meetingLinkFor, startsInLabel } from "./links";

describe("findMeetingLink", () => {
  it.each([
    ["Join: https://us02web.zoom.us/j/8123456789?pwd=abc.", "Zoom", "https://us02web.zoom.us/j/8123456789?pwd=abc"],
    ["https://meet.google.com/abc-defg-hij", "Google Meet", "https://meet.google.com/abc-defg-hij"],
    ["<https://teams.microsoft.com/l/meetup-join/19%3ameeting_x%40thread.v2/0?context=%7b%7d>", "Microsoft Teams", "https://teams.microsoft.com/l/meetup-join/19%3ameeting_x%40thread.v2/0?context=%7b%7d"],
    ["https://acme.webex.com/acme/j.php?MTID=m123", "Webex", "https://acme.webex.com/acme/j.php?MTID=m123"],
    ["room: https://whereby.com/team-standup", "Whereby", "https://whereby.com/team-standup"],
    ["https://around.co/r/design", "Around", "https://around.co/r/design"],
    ["(https://facetime.apple.com/join#v=1&p=xyz)", "FaceTime", "https://facetime.apple.com/join#v=1&p=xyz"],
  ])("detects %s", (text, provider, url) => {
    expect(findMeetingLink(text)).toEqual({ provider, url });
  });

  it("ignores ordinary links and empty text", () => {
    expect(findMeetingLink("https://example.com/agenda and zoom.us homepage")).toBeNull();
    expect(findMeetingLink(undefined)).toBeNull();
  });

  it("picks the earliest link in the text", () => {
    expect(findMeetingLink("backup https://meet.google.com/aaa-bbbb-ccc primary? no: https://zoom.us/j/1")?.provider).toBe("Google Meet");
  });

  it("prefers url over location over notes", () => {
    expect(meetingLinkFor({ url: "https://zoom.us/j/1", location: "https://meet.google.com/x-y-z", notes: "" })?.provider).toBe("Zoom");
    expect(meetingLinkFor({ location: "Room 4", notes: "Dial in https://meet.google.com/x-y-z" })?.provider).toBe("Google Meet");
    expect(meetingLinkFor({ location: "Room 4" })).toBeNull();
  });
});

describe("joinability", () => {
  const now = Date.parse("2026-10-19T10:00:00Z");
  const ev = (startMin: number, endMin: number, allDay = false) => ({ start: new Date(now + startMin * 60_000).toISOString(), end: new Date(now + endMin * 60_000).toISOString(), allDay });

  it("is joinable when ongoing or within 10 minutes", () => {
    expect(isJoinable(ev(5, 35), now)).toBe(true);
    expect(isJoinable(ev(-10, 20), now)).toBe(true);
    expect(isJoinable(ev(11, 40), now)).toBe(false);
    expect(isJoinable(ev(-40, -1), now)).toBe(false);
    expect(isJoinable(ev(-10, 20, true), now)).toBe(false);
  });

  it("labels timing", () => {
    expect(startsInLabel(ev(4.4, 30), now)).toBe("Starts in 4 min");
    expect(startsInLabel(ev(-5, 25), now)).toBe("Now · 25 min left");
  });
});

describe("dayKeys", () => {
  const local = (d: number, h = 0) => new Date(2026, 9, d, h).getTime();
  const from = local(19);
  const to = local(27);
  it("keys timed events by local day", () => {
    expect(dayKeys({ start: new Date(local(20, 9)).toISOString(), end: new Date(local(20, 10)).toISOString(), allDay: false }, from, to)).toEqual([local(20)]);
  });
  it("spreads multi-day events but not past midnight-exact ends", () => {
    expect(dayKeys({ start: new Date(local(20)).toISOString(), end: new Date(local(22)).toISOString(), allDay: true }, from, to)).toEqual([local(20), local(21)]);
  });
  it("clips to the window", () => {
    expect(dayKeys({ start: new Date(local(10)).toISOString(), end: new Date(local(20, 12)).toISOString(), allDay: false }, from, to)).toEqual([local(19), local(20)]);
  });
});

describe("matchesJoinQuery", () => {
  it("matches join/meet prefixes and near-empty queries", () => {
    for (const q of ["", "j", "jo", "join", "meet", "meeting", "join standup"]) expect(matchesJoinQuery(q)).toBe(true);
    for (const q of ["safari", "xy"]) expect(matchesJoinQuery(q)).toBe(false);
  });
});
