// editnote RSS Feed - Cloudflare Pages Function
// 從 GitHub Contents API 抓 pages/ 底下的檔案清單，逐一抓內容解析標題/描述，組成 RSS 2.0 XML
// 注意：本檔案只用 // 單行註解，不使用 /* */ 區塊註解，避免中文說明文字裡意外出現 */ 提前截斷程式碼

const OWNER = "apply-git";
const REPO = "editnote";
const BRANCH = "main";
const SITE = "https://editnote.pages.dev";
const MAX_FULL_ITEMS = 30; // 最多只對最新 30 個檔案抓內容做完整 RSS item，避免逐一 fetch 太慢或超過 CPU 限制

export async function onRequestGet(context) {
  try {
    const files = await listPageFiles();
    const xml = await buildRss(files);
    return new Response(xml, {
      status: 200,
      headers: { "Content-Type": "application/rss+xml; charset=utf-8" },
    });
  } catch (e) {
    return new Response(emptyRss(), {
      status: 200,
      headers: { "Content-Type": "application/rss+xml; charset=utf-8" },
    });
  }
}

// 列出 pages/ 底下所有 .html 檔名，用檔名字母排序後反轉，當作「近似新到舊」（不額外呼叫 commits API 增加負擔）
async function listPageFiles() {
  const url = `https://api.github.com/repos/${OWNER}/${REPO}/contents/pages`;
  const r = await fetch(url, {
    headers: {
      "Accept": "application/vnd.github+json",
      "User-Agent": "editnote-pages-functions",
    },
  });
  if (!r.ok) throw new Error("GitHub 回應 " + r.status);
  const list = await r.json();
  if (!Array.isArray(list)) throw new Error("GitHub 回傳格式不正確");
  return list
    .filter((f) => f && f.type === "file" && /\.html?$/i.test(f.name))
    .map((f) => f.name)
    .sort()
    .reverse();
}

async function buildRss(files) {
  const top = files.slice(0, MAX_FULL_ITEMS);
  const rest = files.slice(MAX_FULL_ITEMS);

  // 平行抓取最新 30 篇的內容，加速（不用做到完美排序）
  const topItems = await Promise.all(top.map(fetchItem));
  const restItems = rest.map((name) => {
    const slug = name.replace(/\.html?$/i, "");
    return { title: slug, link: `${SITE}/pages/${slug}`, description: "" };
  });

  const items = topItems.concat(restItems);
  const itemsXml = items
    .map(
      (it) =>
        "  <item>\n" +
        "    <title>" + escapeXml(it.title) + "</title>\n" +
        "    <link>" + escapeXml(it.link) + "</link>\n" +
        "    <description>" + escapeXml(it.description) + "</description>\n" +
        "    <guid>" + escapeXml(it.link) + "</guid>\n" +
        "  </item>"
    )
    .join("\n");

  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<rss version="2.0"><channel>' +
    "<title>editnote 網頁</title>" +
    "<link>" + SITE + "</link>" +
    "<description>editnote 已發佈網頁的最新動態</description>\n" +
    itemsXml + "\n" +
    "</channel></rss>"
  );
}

// 抓單一檔案的原始 HTML，解析 <title> 與 meta description；抓取失敗就退回只用檔名當標題，不讓單一檔案錯誤拖垮整個 feed
async function fetchItem(name) {
  const slug = name.replace(/\.html?$/i, "");
  const link = `${SITE}/pages/${slug}`;
  try {
    const raw = `https://raw.githubusercontent.com/${OWNER}/${REPO}/${BRANCH}/pages/${encodeURIComponent(name)}`;
    const r = await fetch(raw, { headers: { "User-Agent": "editnote-pages-functions" } });
    if (!r.ok) throw new Error("raw 回應 " + r.status);
    const html = await r.text();

    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const descMatch = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([\s\S]*?)["']/i);

    const title = titleMatch ? decodeEntities(titleMatch[1].trim()) : slug;
    const description = descMatch ? decodeEntities(descMatch[1].trim()) : "";

    return { title: title || slug, link, description };
  } catch (e) {
    return { title: slug, link, description: "" };
  }
}

function decodeEntities(str) {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function escapeXml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function emptyRss() {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<rss version="2.0"><channel><title>editnote 網頁</title><link>' +
    SITE +
    "</link><description>暫時無法取得清單</description></channel></rss>"
  );
}
