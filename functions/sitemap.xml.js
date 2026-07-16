// editnote Sitemap - Cloudflare Pages Function
// 從 GitHub Contents API 抓 pages/ 底下的檔案清單（只需要檔名，不抓內容，沒有效能疑慮），組成 sitemap.xml
// 注意：本檔案只用 // 單行註解，不使用 /* */ 區塊註解，避免中文說明文字裡意外出現 */ 提前截斷程式碼
// 這個檔案刻意跟 rss.xml.js 各自獨立寫一份清單邏輯，不共用模組，簡化 Pages Functions 的匯入疑慮

const OWNER = "apply-git";
const REPO = "editnote";
const SITE = "https://editnote.pages.dev";

export async function onRequestGet(context) {
  try {
    const slugs = await listPageSlugs();
    const xml = buildSitemap(slugs);
    return new Response(xml, {
      status: 200,
      headers: { "Content-Type": "application/xml; charset=utf-8" },
    });
  } catch (e) {
    return new Response(emptySitemap(), {
      status: 200,
      headers: { "Content-Type": "application/xml; charset=utf-8" },
    });
  }
}

async function listPageSlugs() {
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
    .map((f) => f.name.replace(/\.html?$/i, ""))
    .sort();
}

function buildSitemap(slugs) {
  const home = "  <url>\n    <loc>" + escapeXml(SITE + "/") + "</loc>\n  </url>";
  const pageUrls = slugs
    .map((slug) => "  <url>\n    <loc>" + escapeXml(SITE + "/pages/" + slug) + "</loc>\n  </url>")
    .join("\n");

  const body = pageUrls ? home + "\n" + pageUrls : home;

  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    body +
    "\n</urlset>"
  );
}

function escapeXml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function emptySitemap() {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>' +
    SITE +
    "/</loc></url></urlset>"
  );
}
