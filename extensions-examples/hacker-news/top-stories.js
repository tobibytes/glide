// View command: a loading list, then stories with a detail pane and a pushed Detail with top comments.
const { List, Detail, Action, getPreferenceValues } = require("@glide/api");

const API = "https://hacker-news.firebaseio.com/v0";
const getJson = async (path) => {
  const res = await fetch(`${API}/${path}.json`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`Hacker News API: HTTP ${res.status}`);
  return res.json();
};

const ENTITIES = { "&quot;": '"', "&#x27;": "'", "&#39;": "'", "&amp;": "&", "&lt;": "<", "&gt;": ">", "&#x2F;": "/", "&nbsp;": " " };
const htmlToText = (html = "") =>
  html
    .replace(/<p>/g, "\n\n")
    .replace(/<a [^>]*href="([^"]+)"[^>]*>[^<]*<\/a>/g, "$1")
    .replace(/<\/?[^>]+>/g, "")
    .replace(/&[#\w]+;/g, (e) => ENTITIES[e] ?? e);

const ago = (unix) => {
  const m = Math.round((Date.now() / 1000 - unix) / 60);
  return m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
};
const hostOf = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "news.ycombinator.com";
  }
};

function storyMarkdown(s) {
  const lines = [`# ${s.title}`, "", `**${s.score}** points by **${s.by}** · ${ago(s.time)} ago · ${s.descendants ?? 0} comments`];
  if (s.url) lines.push("", `[${hostOf(s.url)}](${s.url})`);
  if (s.text) lines.push("", htmlToText(s.text));
  return lines.join("\n");
}

function commentsView(story) {
  return async (nav) => {
    const kids = (story.kids ?? []).slice(0, 8);
    Promise.all(kids.map((id) => getJson(`item/${id}`).catch(() => null))).then((comments) => {
      const body = comments
        .filter((c) => c && !c.deleted && !c.dead)
        .map((c) => `### ${c.by} · ${ago(c.time)} ago\n\n${htmlToText(c.text)}`)
        .join("\n\n---\n\n");
      nav.render(detail(story, body || "_No comments yet._", false));
    }, (err) => nav.render(detail(story, `Could not load comments: ${err.message}`, false)));
    return detail(story, "_Loading comments…_", true);
  };
}

function detail(story, comments, isLoading) {
  const discussion = `https://news.ycombinator.com/item?id=${story.id}`;
  return Detail({
    title: story.title,
    isLoading,
    markdown: `${storyMarkdown(story)}\n\n## Top comments\n\n${comments}`,
    metadata: [
      { label: "Points", text: String(story.score) },
      { label: "Author", text: story.by, link: `https://news.ycombinator.com/user?id=${story.by}` },
      { label: "Comments", text: String(story.descendants ?? 0), link: discussion },
    ],
    actions: [Action.OpenInBrowser(story.url || discussion), Action.OpenInBrowser(discussion, { title: "Open Comments" }), Action.CopyToClipboard(story.url || discussion, { title: "Copy Link" })],
  });
}

module.exports = async function topStories(ctx) {
  const count = Number(getPreferenceValues().count) || 30;
  ctx.render(List({ isLoading: true, searchPlaceholder: "Filter stories…", items: [] }));
  let stories;
  try {
    const ids = (await getJson("topstories")).slice(0, count);
    stories = (await Promise.all(ids.map((id) => getJson(`item/${id}`).catch(() => null)))).filter(Boolean);
  } catch (err) {
    ctx.render(List({ items: [], emptyText: `Could not load stories: ${err.message}` }));
    return;
  }
  ctx.render(
    List({
      searchPlaceholder: "Filter stories…",
      items: stories.map((s, i) => {
        const discussion = `https://news.ycombinator.com/item?id=${s.id}`;
        return {
          id: String(s.id),
          title: s.title,
          subtitle: hostOf(s.url || discussion),
          icon: i < 10 ? "🔶" : "🔸",
          keywords: [s.by, hostOf(s.url || "")],
          accessories: [{ text: `▲ ${s.score}` }, { text: `💬 ${s.descendants ?? 0}` }, { text: ago(s.time) }],
          detail: { markdown: storyMarkdown(s), metadata: [{ label: "Points", text: String(s.score) }, { label: "Author", text: s.by }] },
          actions: [
            Action.OpenInBrowser(s.url || discussion),
            Action.Push("Show Comments", commentsView(s), { shortcut: "⌘D" }),
            Action.OpenInBrowser(discussion, { title: "Open Comments in Browser", shortcut: "⌘O" }),
            Action.CopyToClipboard(s.url || discussion, { title: "Copy Link", shortcut: "⇧⌘C" }),
          ],
        };
      }),
    }),
  );
};
