// View command with onSearchTextChange: Glide forwards the (debounced) search text; we fetch and re-render.
const { List, Detail, Action, getPreferenceValues } = require("@glide/api");

const fmt = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n));

module.exports = async function searchRepositories(ctx) {
  const { token } = getPreferenceValues();
  let current = 0;
  let controller;
  let lastItems = [];

  const search = async (text) => {
    const q = text.trim();
    const mine = ++current;
    controller?.abort();
    if (!q) {
      ctx.render(List({ searchPlaceholder: "Search repositories…", onSearchTextChange: search, emptyText: "Type to search GitHub repositories", items: [] }));
      return;
    }
    controller = new AbortController();
    ctx.render(List({ searchPlaceholder: "Search repositories…", onSearchTextChange: search, isLoading: true, items: lastItems }));
    try {
      const url = `https://api.github.com/search/repositories?per_page=25&q=${encodeURIComponent(q)}`;
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { accept: "application/vnd.github+json", "user-agent": "Glide-Extension", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      });
      const body = await res.json();
      if (mine !== current) return;
      if (!res.ok) throw new Error(body.message || `HTTP ${res.status}`);
      lastItems = body.items.map(toItem);
      ctx.render(List({ searchPlaceholder: "Search repositories…", onSearchTextChange: search, emptyText: `No repositories match "${q}"`, items: lastItems }));
    } catch (err) {
      if (err.name === "AbortError" || mine !== current) return;
      lastItems = [];
      ctx.render(List({ searchPlaceholder: "Search repositories…", onSearchTextChange: search, emptyText: `GitHub error: ${err.message}`, items: [] }));
    }
  };

  const toItem = (r) => ({
    id: String(r.id),
    title: r.full_name,
    subtitle: r.description ? r.description.slice(0, 90) : "",
    icon: r.owner?.avatar_url || "📦",
    accessories: [...(r.language ? [{ tag: r.language }] : []), { text: `★ ${fmt(r.stargazers_count)}` }],
    actions: [
      Action.OpenInBrowser(r.html_url),
      Action.Push("Show Details", () =>
        Detail({
          title: r.full_name,
          markdown: `# ${r.full_name}\n\n${r.description || "_No description_"}\n\n- **Stars:** ${r.stargazers_count}\n- **Forks:** ${r.forks_count}\n- **Open issues:** ${r.open_issues_count}\n- **Default branch:** \`${r.default_branch}\`\n\n\`\`\`\ngit clone ${r.clone_url}\n\`\`\``,
          metadata: [
            { label: "Language", text: r.language || "—" },
            { label: "License", text: r.license?.spdx_id || "—" },
            { label: "Updated", text: new Date(r.pushed_at).toLocaleDateString() },
            { label: "Homepage", text: r.homepage || "—", link: r.homepage || undefined },
          ],
          actions: [Action.OpenInBrowser(r.html_url), Action.CopyToClipboard(r.clone_url, { title: "Copy Clone URL" })],
        }), { shortcut: "⌘D" }),
      Action.CopyToClipboard(r.clone_url, { title: "Copy Clone URL", shortcut: "⇧⌘C" }),
      Action.CopyToClipboard(r.html_url, { title: "Copy URL" }),
    ],
  });

  await search(ctx.arguments.query || "");
};
