// editnote 發佈後端 Worker
// 收到編輯器送來的 HTML → 驗證密碼 → 用 GitHub API commit 到 pages/
// 機密（GITHUB_TOKEN / PUBLISH_PASSWORD）放 Worker Secret，絕不寫在這裡

const OWNER = "apply-git";
const REPO = "editnote";
const BRANCH = "main";
const SITE = "https://editnote.pages.dev";

// 只允許這些來源呼叫（零信任 CORS）
const ALLOWED = [
  "https://editnote.pages.dev",
  "http://localhost:8080",
  "http://127.0.0.1:8080",
];

function cors(origin) {
  const allow = ALLOWED.includes(origin) ? origin : ALLOWED[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

// 檔名消毒：擋掉 ../ 這類路徑穿越，只准安全字元，強制 .html
function sanitize(name) {
  let n = (name || "").toString().trim();
  n = n.replace(/\.html?$/i, "");
  n = n.replace(/[^a-zA-Z0-9._一-鿿-]/g, "-");
  n = n.replace(/^[.\-]+/, "").replace(/\.+/g, ".");
  n = n.slice(0, 60);
  if (!n) n = "page";
  return n + ".html";
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const h = cors(origin);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: h });
    if (request.method !== "POST") return json({ error: "只接受 POST" }, 405, h);

    let body;
    try { body = await request.json(); } catch { return json({ error: "資料格式錯誤" }, 400, h); }

    const { filename, html, password } = body || {};

    if (!env.PUBLISH_PASSWORD || password !== env.PUBLISH_PASSWORD)
      return json({ error: "密碼錯誤" }, 401, h);
    if (typeof html !== "string" || !html.trim())
      return json({ error: "沒有內容可發佈" }, 400, h);

    const safe = sanitize(filename);
    const path = `pages/${safe}`;

    try {
      const sha = await getSha(env, path);
      await putFile(env, path, html, sha);
      return json({ ok: true, url: `${SITE}/pages/${safe}`, filename: safe }, 200, h);
    } catch (e) {
      return json({ error: "發佈失敗：" + e.message }, 500, h);
    }
  },
};

function json(obj, status, h) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...h } });
}

const GH = "https://api.github.com";
function ghHeaders(env) {
  return {
    "Authorization": `Bearer ${env.GITHUB_TOKEN}`,
    "Accept": "application/vnd.github+json",
    "User-Agent": "editnote-worker",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

async function getSha(env, path) {
  const r = await fetch(`${GH}/repos/${OWNER}/${REPO}/contents/${encodeURIComponent(path).replace(/%2F/g, "/")}?ref=${BRANCH}`, { headers: ghHeaders(env) });
  if (r.status === 200) return (await r.json()).sha;
  if (r.status === 404) return null;
  throw new Error("讀取檔案狀態失敗 " + r.status);
}

async function putFile(env, path, content, sha) {
  const body = { message: `Publish ${path}`, content: b64(content), branch: BRANCH };
  if (sha) body.sha = sha;
  const r = await fetch(`${GH}/repos/${OWNER}/${REPO}/contents/${encodeURIComponent(path).replace(/%2F/g, "/")}`, {
    method: "PUT", headers: ghHeaders(env), body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(r.status + " " + (await r.text()).slice(0, 200));
  return r.json();
}

// UTF-8 安全 base64（中文不會壞）
function b64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
