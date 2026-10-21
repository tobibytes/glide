// View command with local filtering: Glide filters items by title/subtitle/keywords as you type.
const { List, Action, LocalStorage, showToast, getPreferenceValues } = require("@glide/api");

const CITIES = [
  ["San Francisco", "America/Los_Angeles", "USA"], ["Denver", "America/Denver", "USA"], ["Chicago", "America/Chicago", "USA"],
  ["New York", "America/New_York", "USA"], ["Toronto", "America/Toronto", "Canada"], ["Mexico City", "America/Mexico_City", "Mexico"],
  ["São Paulo", "America/Sao_Paulo", "Brazil"], ["Buenos Aires", "America/Argentina/Buenos_Aires", "Argentina"], ["Reykjavík", "Atlantic/Reykjavik", "Iceland"],
  ["London", "Europe/London", "UK"], ["Lisbon", "Europe/Lisbon", "Portugal"], ["Lagos", "Africa/Lagos", "Nigeria"], ["Paris", "Europe/Paris", "France"],
  ["Berlin", "Europe/Berlin", "Germany"], ["Stockholm", "Europe/Stockholm", "Sweden"], ["Cairo", "Africa/Cairo", "Egypt"],
  ["Johannesburg", "Africa/Johannesburg", "South Africa"], ["Nairobi", "Africa/Nairobi", "Kenya"], ["Istanbul", "Europe/Istanbul", "Türkiye"],
  ["Moscow", "Europe/Moscow", "Russia"], ["Dubai", "Asia/Dubai", "UAE"], ["Karachi", "Asia/Karachi", "Pakistan"], ["Mumbai", "Asia/Kolkata", "India"],
  ["Dhaka", "Asia/Dhaka", "Bangladesh"], ["Bangkok", "Asia/Bangkok", "Thailand"], ["Jakarta", "Asia/Jakarta", "Indonesia"],
  ["Singapore", "Asia/Singapore", "Singapore"], ["Hong Kong", "Asia/Hong_Kong", "China"], ["Shanghai", "Asia/Shanghai", "China"],
  ["Seoul", "Asia/Seoul", "South Korea"], ["Tokyo", "Asia/Tokyo", "Japan"], ["Sydney", "Australia/Sydney", "Australia"],
  ["Auckland", "Pacific/Auckland", "New Zealand"], ["Honolulu", "Pacific/Honolulu", "USA"], ["UTC", "UTC", "Coordinated Universal Time"],
];

function offsetLabel(tz, now) {
  const part = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "shortOffset" }).formatToParts(now).find((p) => p.type === "timeZoneName");
  return part ? part.value.replace("GMT", "UTC") : "";
}

module.exports = async function worldClocks(ctx) {
  const { hourCycle } = getPreferenceValues();
  let pinned = (await LocalStorage.getItem("pinned")) || [];

  const render = () => {
    const now = new Date();
    const localDay = now.toLocaleDateString("en-CA");
    const items = CITIES.map(([city, tz, country]) => {
      const time = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle }).format(now);
      const day = now.toLocaleDateString("en-CA", { timeZone: tz });
      const dayTag = day > localDay ? "Tomorrow" : day < localDay ? "Yesterday" : undefined;
      const isPinned = pinned.includes(city);
      return {
        id: city,
        title: city,
        subtitle: `${country} · ${tz}`,
        icon: isPinned ? "📌" : "🕒",
        section: isPinned ? "Pinned" : "Cities",
        keywords: [country, tz, offsetLabel(tz, now)],
        accessories: [...(dayTag ? [{ tag: dayTag }] : []), { text: offsetLabel(tz, now) }, { text: time }],
        actions: [
          Action.CopyToClipboard(`${time} in ${city}`, { title: "Copy Time" }),
          Action.Run(isPinned ? "Unpin City" : "Pin City", async () => {
            pinned = isPinned ? pinned.filter((c) => c !== city) : [...pinned, city];
            await LocalStorage.setItem("pinned", pinned);
            await showToast({ title: isPinned ? `Unpinned ${city}` : `Pinned ${city}` });
            render();
          }, { shortcut: "⌘P" }),
        ],
      };
    }).sort((a, b) => (a.section === b.section ? 0 : a.section === "Pinned" ? -1 : 1));
    ctx.render(List({ searchPlaceholder: "Filter cities…", items }));
  };

  render();
  // Keep the clocks current while the view is open; the process is stopped when the view closes.
  setInterval(render, 15_000);
};
