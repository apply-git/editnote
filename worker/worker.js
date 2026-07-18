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
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Auth-Password",
    "Access-Control-Max-Age": "86400",
  };
}

// /view（POST，公開回報瀏覽數）專用 CORS：任何已發佈頁面的來源都要放行，不能只給白名單
function corsPublic() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Auth-Password",
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
    const url = new URL(request.url);

    // /view 與 /unlock 的 OPTIONS 預檢要用公開版 CORS（任意來源），不能被白名單擋掉
    if (request.method === "OPTIONS" && (url.pathname === "/view" || url.pathname === "/unlock")) return new Response(null, { status: 204, headers: corsPublic() });
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: h });

    // 瀏覽數：公開頁面載入時自己回報一次，任何來源都能打（零信任但不需密碼，只做基本檔名消毒防濫用）
    if (request.method === "POST" && url.pathname === "/view") {
      const hPub = corsPublic();
      let vbody;
      try { vbody = await request.json(); } catch { return json({ error: "資料格式錯誤" }, 400, hPub); }

      const vsafe = sanitize(vbody && vbody.filename);
      const vkey = "views:" + vsafe;

      try {
        const cur = parseInt(await env.EDITNOTE_KV.get(vkey)) || 0;
        const next = cur + 1;
        await env.EDITNOTE_KV.put(vkey, String(next));
        return json({ ok: true, count: next }, 200, hPub);
      } catch (e) {
        return json({ error: "記錄瀏覽數失敗：" + e.message }, 500, hPub);
      }
    }

    // 瀏覽數：作者在編輯器內查詢目前次數，需要密碼保護
    if (request.method === "GET" && url.pathname === "/view") {
      const filename = url.searchParams.get("filename") || "";
      const password = request.headers.get("X-Auth-Password") || url.searchParams.get("password") || "";

      if (!env.PUBLISH_PASSWORD || password !== env.PUBLISH_PASSWORD)
        return json({ error: "密碼錯誤" }, 401, h);

      const vsafe = sanitize(filename);
      const vkey = "views:" + vsafe;

      try {
        const cur = parseInt(await env.EDITNOTE_KV.get(vkey)) || 0;
        return json({ ok: true, count: cur }, 200, h);
      } catch (e) {
        return json({ error: "讀取瀏覽數失敗：" + e.message }, 500, h);
      }
    }

    // 刪除已發佈頁：DELETE（任何路徑）或 POST /delete，沿用發佈同一把密碼驗證
    if (request.method === "DELETE" || (request.method === "POST" && url.pathname === "/delete")) {
      let dbody;
      try { dbody = await request.json(); } catch { return json({ error: "資料格式錯誤" }, 400, h); }

      const { filename, password } = dbody || {};

      if (!env.PUBLISH_PASSWORD || password !== env.PUBLISH_PASSWORD)
        return json({ error: "密碼錯誤" }, 401, h);

      const dsafe = sanitize(filename);
      const dpath = `pages/${dsafe}`;

      try {
        const sha = await getSha(env, dpath);
        if (!sha) return json({ error: "找不到該網頁：" + dsafe }, 404, h);
        await deleteFile(env, dpath, sha);
        return json({ ok: true, filename: dsafe }, 200, h);
      } catch (e) {
        return json({ error: "刪除失敗：" + e.message }, 500, h);
      }
    }

    // 刪除已發佈頁 + 孤兒圖清理：刪掉 pages/X.html，並清掉「只有這頁用到、其他頁都沒引用」的 images/ 圖片
    if (request.method === "POST" && url.pathname === "/delete-page") {
      let dpbody;
      try { dpbody = await request.json(); } catch { return json({ error: "資料格式錯誤" }, 400, h); }

      const { filename, password } = dpbody || {};
      if (!env.PUBLISH_PASSWORD || password !== env.PUBLISH_PASSWORD)
        return json({ error: "密碼錯誤" }, 401, h);

      const dpsafe = sanitize(filename);
      const dppath = `pages/${dpsafe}`;

      try {
        const sha = await getSha(env, dppath);
        if (!sha) return json({ error: "找不到該網頁：" + dpsafe }, 404, h);

        // 刪除前先抓這頁內容，記下它引用了哪些 images/
        let usedByThis = [];
        try { usedByThis = extractImageNames(await getContentAt(env, dppath, BRANCH)); } catch (_) {}

        await deleteFile(env, dppath, sha);

        // 孤兒圖清理（best-effort）：掃「其餘所有已發佈頁」，這頁用到的圖若沒別人用就一起刪。
        // ⚠️ 清圖若中途失敗，絕不能讓整個請求變成錯誤（否則前端會以為「頁面沒刪成功」而卡在重複詢問）。
        // 所以整段用 try 包住：頁面已經刪掉了，就一定回 ok，清圖成敗只反映在 deletedImages / cleanupFailed。
        let deletedImages = [], cleanupFailed = false;
        try {
          if (usedByThis.length) {
            const stillUsed = await collectUsedImages(env, dpsafe);
            for (const img of usedByThis) {
              if (stillUsed.has(img)) continue;
              const isha = await getSha(env, `images/${img}`);
              if (isha) { await deleteFile(env, `images/${img}`, isha); deletedImages.push(img); }
            }
          }
        } catch (_) { cleanupFailed = true; }

        return json({ ok: true, filename: dpsafe, deletedImages, cleanupFailed }, 200, h);
      } catch (e) {
        return json({ error: "刪除失敗：" + e.message }, 500, h);
      }
    }

    // 版本記錄：列出某已發佈頁在 GitHub 上的 commit 歷史（最近 20 筆）
    if (request.method === "GET" && url.pathname === "/history") {
      const filename = url.searchParams.get("filename") || "";
      const password = request.headers.get("X-Auth-Password") || url.searchParams.get("password") || "";

      if (!env.PUBLISH_PASSWORD || password !== env.PUBLISH_PASSWORD)
        return json({ error: "密碼錯誤" }, 401, h);

      const hsafe = sanitize(filename);
      const hpath = `pages/${hsafe}`;

      try {
        const history = await getHistory(env, hpath);
        return json({ ok: true, history }, 200, h);
      } catch (e) {
        return json({ error: "讀取版本記錄失敗：" + e.message }, 500, h);
      }
    }

    // 版本記錄：取回某一次 commit 當下的檔案內容，供預覽／復原使用
    if (request.method === "GET" && url.pathname === "/history-content") {
      const filename = url.searchParams.get("filename") || "";
      const sha = url.searchParams.get("sha") || "";
      const password = request.headers.get("X-Auth-Password") || url.searchParams.get("password") || "";

      if (!env.PUBLISH_PASSWORD || password !== env.PUBLISH_PASSWORD)
        return json({ error: "密碼錯誤" }, 401, h);
      if (!sha) return json({ error: "缺少版本 sha" }, 400, h);

      const csafe = sanitize(filename);
      const cpath = `pages/${csafe}`;

      try {
        const content = await getContentAt(env, cpath, sha);
        return json({ ok: true, content, sha }, 200, h);
      } catch (e) {
        return json({ error: "讀取該版本內容失敗：" + e.message }, 500, h);
      }
    }

    // 受保護頁面發佈：真實內容只存進私有 KV，GitHub public repo 只 commit 一個純密碼表單的樁頁面
    // 這樣就算有人直接翻 GitHub repo 或用 raw.githubusercontent.com，也看不到真實內容
    if (request.method === "POST" && url.pathname === "/publish-protected") {
      let pbody;
      try { pbody = await request.json(); } catch { return json({ error: "資料格式錯誤" }, 400, h); }

      const { filename, html, pagePassword, password } = pbody || {};

      if (!env.PUBLISH_PASSWORD || password !== env.PUBLISH_PASSWORD)
        return json({ error: "密碼錯誤" }, 401, h);
      if (typeof html !== "string" || !html.trim())
        return json({ error: "沒有內容可發佈" }, 400, h);
      if (typeof pagePassword !== "string" || !pagePassword)
        return json({ error: "受保護頁面必須設定頁面密碼" }, 400, h);

      // sanitize() 一律正規化成「安全字元 + .html」，不管傳進來時有沒有副檔名，
      // 這裡跟 /unlock 都要各自呼叫 sanitize() 才能保證組出來的 KV key 完全一致
      const psafe = sanitize(filename);
      const pkey = "protected:" + psafe;
      const ppath = `pages/${psafe}`;

      try {
        const passwordHash = await hashPassword(pagePassword);
        await env.EDITNOTE_KV.put(pkey, JSON.stringify({ html, passwordHash, updatedAt: Date.now() }));

        const slug = psafe.replace(/\.html?$/i, "");
        const stub = protectedStubHtml(slug);
        const sha = await getSha(env, ppath);
        await putFile(env, ppath, stub, sha);

        return json({ ok: true, url: `${SITE}/pages/${psafe}`, filename: psafe }, 200, h);
      } catch (e) {
        return json({ error: "發佈失敗：" + e.message }, 500, h);
      }
    }

    // 訪客解鎖受保護頁面：不需要站台密碼，任何人都能呼叫，但要頁面密碼對才拿得到內容
    if (request.method === "POST" && url.pathname === "/unlock") {
      const hPub = corsPublic();
      let ubody;
      try { ubody = await request.json(); } catch { return json({ error: "資料格式錯誤" }, 400, hPub); }

      const { slug, pagePassword } = ubody || {};

      // slug 傳進來時通常不含副檔名，sanitize() 會正規化成跟 /publish-protected 存 KV 時一致的 key
      const usafe = sanitize(slug);
      const ukey = "protected:" + usafe;

      try {
        const raw = await env.EDITNOTE_KV.get(ukey);
        if (!raw) return json({ error: "找不到此受保護頁面" }, 404, hPub);

        const rec = JSON.parse(raw);
        const hash = await hashPassword(pagePassword || "");
        if (hash !== rec.passwordHash) return json({ error: "密碼錯誤" }, 401, hPub);

        return json({ ok: true, html: rec.html }, 200, hPub);
      } catch (e) {
        return json({ error: "解鎖失敗：" + e.message }, 500, hPub);
      }
    }

    // 圖片上傳（#24）：發佈時把內嵌 base64 圖片存到 repo 的 images/，回傳公開 URL，讓發佈頁不用塞肥大的 base64。
    // 用「內容雜湊」當檔名 → 同一張圖只會存一份（天然去重），也不會被人塞爆 repo。站台密碼保護，不給陌生人上傳。
    if (request.method === "POST" && url.pathname === "/upload-image") {
      let ibody;
      try { ibody = await request.json(); } catch { return json({ error: "資料格式錯誤" }, 400, h); }

      const { dataUrl, password } = ibody || {};

      if (!env.PUBLISH_PASSWORD || password !== env.PUBLISH_PASSWORD)
        return json({ error: "密碼錯誤" }, 401, h);
      if (typeof dataUrl !== "string")
        return json({ error: "沒有圖片可上傳" }, 400, h);

      const mm = dataUrl.match(/^data:image\/([a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/);
      if (!mm) return json({ error: "圖片格式不支援（需 base64 data URL）" }, 400, h);

      let ext = mm[1].toLowerCase();
      if (ext === "jpeg") ext = "jpg";
      if (ext === "svg+xml") ext = "svg";
      const ALLOWED_EXT = ["jpg", "png", "gif", "webp", "svg", "bmp", "avif"];
      if (!ALLOWED_EXT.includes(ext))
        return json({ error: "不支援的圖片類型：" + ext }, 400, h);

      const b64content = mm[2];
      // 內容雜湊當檔名（取前 24 碼）：同一張圖重複上傳落在同路徑，等於自動去重
      const hashHex = await hashPassword(b64content);
      const iname = hashHex.slice(0, 24) + "." + ext;
      const ipath = `images/${iname}`;

      try {
        // 已存在就不重傳（省 GitHub API 呼叫、也避免無謂 commit）
        const existing = await getSha(env, ipath);
        if (!existing) await putFileRaw(env, ipath, b64content);
        return json({ ok: true, url: `${SITE}/images/${iname}` }, 200, h);
      } catch (e) {
        return json({ error: "圖片上傳失敗：" + e.message }, 500, h);
      }
    }

    // 草稿雲端同步（#27）：把整包分頁草稿（docs+active+trash+updatedAt）存進 KV，站台密碼保護。
    // 單一使用者、共用一把發佈密碼，所以全部裝置共用同一個 key「drafts:main」。
    if (request.method === "POST" && url.pathname === "/draft-push") {
      let sbody;
      try { sbody = await request.json(); } catch { return json({ error: "資料格式錯誤" }, 400, h); }
      const { password, bundle } = sbody || {};
      if (!env.PUBLISH_PASSWORD || password !== env.PUBLISH_PASSWORD)
        return json({ error: "密碼錯誤" }, 401, h);
      if (!bundle || typeof bundle !== "object")
        return json({ error: "沒有草稿可上傳" }, 400, h);
      try {
        await env.EDITNOTE_KV.put("drafts:main", JSON.stringify(bundle));
        return json({ ok: true, updatedAt: bundle.updatedAt || 0 }, 200, h);
      } catch (e) {
        return json({ error: "上傳草稿失敗：" + e.message }, 500, h);
      }
    }
    if (request.method === "POST" && url.pathname === "/draft-pull") {
      let sbody;
      try { sbody = await request.json(); } catch { return json({ error: "資料格式錯誤" }, 400, h); }
      const { password } = sbody || {};
      if (!env.PUBLISH_PASSWORD || password !== env.PUBLISH_PASSWORD)
        return json({ error: "密碼錯誤" }, 401, h);
      try {
        const raw = await env.EDITNOTE_KV.get("drafts:main");
        if (!raw) return json({ ok: true, empty: true }, 200, h);
        return json({ ok: true, bundle: JSON.parse(raw) }, 200, h);
      } catch (e) {
        return json({ error: "取回草稿失敗：" + e.message }, 500, h);
      }
    }

    // AI 助手：潤稿／續寫／改語氣／翻譯／摘要，會呼叫 Claude API 花錢，一定要密碼保護，不能讓陌生人濫用
    if (request.method === "POST" && url.pathname === "/ai") {
      let abody;
      try { abody = await request.json(); } catch { return json({ error: "資料格式錯誤" }, 400, h); }

      const { text, action, password, extra } = abody || {};

      if (!env.PUBLISH_PASSWORD || password !== env.PUBLISH_PASSWORD)
        return json({ error: "密碼錯誤" }, 401, h);

      if (typeof text !== "string" || !text.trim())
        return json({ error: "沒有內容可處理" }, 400, h);
      // 成本與延遲控制：選取內容太長就直接擋掉，不送去 Claude API
      if (text.length > 4000)
        return json({ error: "內容太長，請選取少一點文字再試（上限 4000 字）" }, 400, h);

      const AI_ACTIONS = ["proofread", "continue", "tone", "translate", "summarize", "generatepage"];
      if (!AI_ACTIONS.includes(action))
        return json({ error: "不支援的操作類型" }, 400, h);
      if (action === "tone" && (typeof extra !== "string" || !extra.trim()))
        return json({ error: "請提供目標語氣" }, 400, h);
      if (action === "translate" && (typeof extra !== "string" || !extra.trim()))
        return json({ error: "請提供目標語言" }, 400, h);

      // OPENAI_API_KEY 是 Worker Secret，使用者要自己另外用 wrangler secret put 設定；還沒設定時不能讓 Worker 丟未捕捉例外
      if (!env.OPENAI_API_KEY)
        return json({ error: "AI 功能尚未設定完成，請聯繫管理者設定 OPENAI_API_KEY" }, 503, h);

      // 頻率限制：站台密碼萬一外流，這道防線擋住有人拿去狂打 Claude API 燒錢。放在真正呼叫 API 之前、所有格式驗證之後，讓格式錯的請求不佔用額度
      const rl = await checkAiRateLimit(env, request);
      if (!rl.ok) return json({ error: rl.error }, 429, h);

      const aiPrompt = buildAiPrompt(action, text, extra);

      try {
        // 改用 OpenAI Chat Completions（模型 gpt-4.1-mini）。之後要換模型只改這裡的 model 字串即可。
        const ar = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
          },
          body: JSON.stringify({
            model: "gpt-4.1-mini",
            max_completion_tokens: action === "generatepage" ? 4000 : 1024,
            messages: [{ role: "user", content: aiPrompt }],
          }),
        });

        if (!ar.ok) {
          const errText = (await ar.text()).slice(0, 300);
          return json({ error: "AI 服務錯誤：" + errText }, 502, h);
        }

        const adata = await ar.json();
        // OpenAI 回應結構是 choices[0].message.content（跟 Anthropic 的 content[0].text 不同）
        const result = adata && adata.choices && adata.choices[0] && adata.choices[0].message && adata.choices[0].message.content;
        if (typeof result !== "string")
          return json({ error: "AI 服務錯誤：回應格式不正確" }, 502, h);

        return json({ ok: true, result }, 200, h);
      } catch (e) {
        return json({ error: "AI 服務連線失敗：" + e.message }, 502, h);
      }
    }

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

// AI 頻率限制設定：每 IP 每分鐘上限、全站每日總上限。改這兩個數字就能調鬆緊
const AI_RATE_PER_IP_PER_MIN = 10;
const AI_RATE_GLOBAL_PER_DAY = 200;

// AI 頻率限制：用 KV 記「每 IP 每分鐘」與「全站每日」兩個計數，超過就擋。
// KV 是最終一致（非強一致），高併發下計數可能略有誤差，但對個人工具的成本防護已足夠，不追求精準到個位數。
// key 一律用 ratelimit: 前綴，跟 views: / protected: 不會互撞。
async function checkAiRateLimit(env, request) {
  // KV 沒綁好也不要讓 AI 整個掛掉：try 包住，出錯就放行（fail-open），避免限流機制本身變成故障點
  try {
    const now = Date.now();
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    const minuteWindow = Math.floor(now / 60000); // 每 60 秒換一個窗
    // 用台灣時間（UTC+8）算日期，讓「每日」在台灣午夜歸零，比 UTC 午夜（早上 8 點）直覺
    const dayKey = new Date(now + 8 * 3600 * 1000).toISOString().slice(0, 10);

    const ipKey = "ratelimit:ai:ip:" + ip + ":" + minuteWindow;
    const globalKey = "ratelimit:ai:global:" + dayKey;

    const [ipCurRaw, globalCurRaw] = await Promise.all([
      env.EDITNOTE_KV.get(ipKey),
      env.EDITNOTE_KV.get(globalKey),
    ]);
    const ipCur = parseInt(ipCurRaw) || 0;
    const globalCur = parseInt(globalCurRaw) || 0;

    if (ipCur >= AI_RATE_PER_IP_PER_MIN)
      return { ok: false, error: "AI 使用太頻繁，請稍等一分鐘再試（每分鐘上限 " + AI_RATE_PER_IP_PER_MIN + " 次）" };
    if (globalCur >= AI_RATE_GLOBAL_PER_DAY)
      return { ok: false, error: "今日 AI 用量已達全站上限，請明天再試（每日上限 " + AI_RATE_GLOBAL_PER_DAY + " 次）" };

    // 通過就各自 +1；TTL 讓 key 自動過期（分鐘窗 60 秒＝KV 最小 TTL；每日窗 86400 秒）
    await Promise.all([
      env.EDITNOTE_KV.put(ipKey, String(ipCur + 1), { expirationTtl: 60 }),
      env.EDITNOTE_KV.put(globalKey, String(globalCur + 1), { expirationTtl: 86400 }),
    ]);

    return { ok: true };
  } catch (e) {
    return { ok: true };
  }
}

// AI 助手：依 action 組出送給 Claude 的 prompt，五種動作各自固定模板
function buildAiPrompt(action, text, extra) {
  if (action === "proofread")
    return "請幫我潤飾以下文字，修正錯字、語病、標點，但保留原意與語氣，只回傳修改後的文字，不要加任何說明或前後綴：\n\n" + text;
  if (action === "continue")
    return "請接續以下文字，用同樣的語氣和風格繼續寫下去，大約 100-200 字，只回傳新增的接續內容，不要重複原文，不要加任何說明：\n\n" + text;
  if (action === "tone")
    return "請把以下文字改寫成「" + extra + "」的語氣，保留原意，只回傳改寫後的文字，不要加任何說明：\n\n" + text;
  if (action === "translate")
    return "請把以下文字翻譯成" + extra + "，只回傳翻譯結果，不要加任何說明：\n\n" + text;
  if (action === "generatepage")
    return "你是專業網頁設計助手。請根據下面的描述，生成一個網頁的「內文 HTML」。嚴格要求：" +
      "(1) 只輸出 <body> 內部的內容，不要 <!doctype>、<html>、<head>、<style>、<script>，也不要 markdown 或 ``` 圍欄；" +
      "(2) 所有排版一律用 inline style（寫在各元素的 style 屬性裡），確保貼進編輯器就能正確呈現；" +
      "(3) 用繁體中文，內容要具體、豐富、可直接使用，不要出現「這裡放…」這種佔位文字；" +
      "(4) 適合手機閱讀，字級與行距舒適，善用標題、段落、清單、色塊、分隔線等排版讓版面美觀；" +
      "(5) 不要使用外部圖片或連結。只回傳 HTML 本身。\n\n描述：" + text;
  return "請用 2-3 句話摘要以下文字重點，只回傳摘要內容，不要加任何說明：\n\n" + text;
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

// 從 HTML 抽出用到的 images/ 檔名（給刪頁的孤兒圖清理用）
function extractImageNames(html) {
  const out = [], seen = {};
  const re = /images\/([A-Za-z0-9._-]+\.(?:jpe?g|png|gif|webp|svg|bmp|avif))/gi;
  let m;
  while ((m = re.exec(html)) !== null) { const n = m[1]; if (!seen[n]) { seen[n] = true; out.push(n); } }
  return out;
}

// 列出 repo 某資料夾底下的檔案清單（查不到回空陣列，不當錯誤）
async function listDir(env, dir) {
  const r = await fetch(`${GH}/repos/${OWNER}/${REPO}/contents/${dir}?ref=${BRANCH}`, { headers: ghHeaders(env) });
  if (r.status === 404) return [];
  if (!r.ok) throw new Error("GitHub 回應 " + r.status);
  const list = await r.json();
  return Array.isArray(list) ? list : [];
}

// 掃「除了 excludeName 以外」的所有 pages/*.html，收集仍被引用的 image 檔名集合（判斷孤兒圖用）
async function collectUsedImages(env, excludeName) {
  const used = new Set();
  const files = await listDir(env, "pages");
  for (const f of files) {
    if (f.type !== "file" || !/\.html?$/i.test(f.name) || f.name === excludeName) continue;
    try {
      const content = await getContentAt(env, `pages/${f.name}`, BRANCH);
      for (const img of extractImageNames(content)) used.add(img);
    } catch (_) {}
  }
  return used;
}

// 圖片用：content 已經是 base64（不像 putFile 會再 b64 一次），直接丟給 GitHub Contents API。
// 只在檔案不存在時呼叫（內容雜湊命名＝不可變），所以不需要帶 sha。
async function putFileRaw(env, path, base64Content) {
  const body = { message: `Upload ${path}`, content: base64Content, branch: BRANCH };
  const r = await fetch(`${GH}/repos/${OWNER}/${REPO}/contents/${encodeURIComponent(path).replace(/%2F/g, "/")}`, {
    method: "PUT", headers: ghHeaders(env), body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(r.status + " " + (await r.text()).slice(0, 200));
  return r.json();
}

async function deleteFile(env, path, sha) {
  const body = { message: `Delete ${path}`, sha, branch: BRANCH };
  const r = await fetch(`${GH}/repos/${OWNER}/${REPO}/contents/${encodeURIComponent(path).replace(/%2F/g, "/")}`, {
    method: "DELETE", headers: ghHeaders(env), body: JSON.stringify(body),
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

// UTF-8 安全 base64 解碼（反向對應 b64，中文不會壞）
function ub64(b64str) {
  const bin = atob((b64str || "").replace(/\s+/g, ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder("utf-8").decode(bytes);
}

// 頁面密碼雜湊：純密碼雜湊（不加 salt，輕量級個人工具用），SHA-256 轉 hex 字串方便存 KV
async function hashPassword(pw) {
  const data = new TextEncoder().encode(pw);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest)).map(function (b) { return b.toString(16).padStart(2, "0"); }).join("");
}

// 受保護頁面的樁頁面（stub）：commit 到 public repo 的 pages/{slug}.html 只放這個，不含真實內容
// 純 HTML + inline CSS + inline script，不用外部資源；深色模式跟響應式都靠 CSS media query 處理
function protectedStubHtml(slug) {
  const workerUrl = "https://editnote-api.cthouse-lee.workers.dev";
  const slugJson = JSON.stringify(slug);
  const apiJson = JSON.stringify(workerUrl + "/unlock");
  let html = "";
  html += "<!doctype html>\n";
  html += "<html lang=\"zh-Hant\">\n";
  html += "<head>\n";
  html += "<meta charset=\"utf-8\">\n";
  html += "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n";
  html += "<title>此頁面需要密碼</title>\n";
  html += "<style>\n";
  html += ":root{color-scheme:light dark;}\n";
  html += "*{box-sizing:border-box;}\n";
  html += "body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px;font-family:\"Microsoft JhengHei\",\"Segoe UI\",system-ui,sans-serif;background:#f3f4f6;color:#1f2937;}\n";
  html += ".card{width:100%;max-width:360px;background:#ffffff;border-radius:14px;box-shadow:0 8px 30px rgba(0,0,0,.12);padding:28px 24px;text-align:center;}\n";
  html += ".icon{font-size:40px;margin-bottom:10px;}\n";
  html += "h1{font-size:17px;margin:0 0 6px;}\n";
  html += "p.desc{font-size:13px;color:#6b7280;margin:0 0 18px;}\n";
  html += "input[type=password]{width:100%;padding:10px 12px;font-size:15px;border:1px solid #d1d5db;border-radius:8px;margin-bottom:10px;}\n";
  html += "button{width:100%;padding:10px 12px;font-size:15px;border:none;border-radius:8px;background:#2563eb;color:#fff;cursor:pointer;}\n";
  html += "button:disabled{opacity:.6;cursor:default;}\n";
  html += ".err{color:#dc2626;font-size:12.5px;margin-top:8px;min-height:16px;}\n";
  html += "@media (prefers-color-scheme:dark){\n";
  html += "body{background:#111827;color:#e5e7eb;}\n";
  html += ".card{background:#1f2937;box-shadow:0 8px 30px rgba(0,0,0,.5);}\n";
  html += "p.desc{color:#9ca3af;}\n";
  html += "input[type=password]{background:#111827;border-color:#374151;color:#e5e7eb;}\n";
  html += "}\n";
  html += "</style>\n";
  html += "</head>\n";
  html += "<body>\n";
  html += "<div class=\"card\">\n";
  html += "<div class=\"icon\">\u{1F512}</div>\n";
  html += "<h1>此頁面需要密碼才能檢視</h1>\n";
  html += "<p class=\"desc\">請輸入密碼以繼續</p>\n";
  html += "<input type=\"password\" id=\"pw\" placeholder=\"請輸入密碼\" autofocus>\n";
  html += "<button id=\"go\">送出</button>\n";
  html += "<div class=\"err\" id=\"err\"></div>\n";
  html += "</div>\n";
  html += "<script>\n";
  html += "(function(){\n";
  html += "var slug = " + slugJson + ";\n";
  html += "var api = " + apiJson + ";\n";
  html += "var btn = document.getElementById(\"go\");\n";
  html += "var pwEl = document.getElementById(\"pw\");\n";
  html += "var errEl = document.getElementById(\"err\");\n";
  html += "function submit(){\n";
  html += "var pw = pwEl.value;\n";
  html += "if(!pw){ errEl.textContent = \"請輸入密碼\"; return; }\n";
  html += "btn.disabled = true; btn.textContent = \"驗證中…\"; errEl.textContent = \"\";\n";
  html += "fetch(api, { method: \"POST\", headers: { \"Content-Type\": \"application/json\" }, body: JSON.stringify({ slug: slug, pagePassword: pw }) })\n";
  html += ".then(function(r){ return r.json(); })\n";
  html += ".then(function(data){\n";
  html += "if(data && data.ok){\n";
  html += "document.open(); document.write(data.html); document.close();\n";
  html += "} else {\n";
  html += "btn.disabled = false; btn.textContent = \"送出\";\n";
  html += "errEl.textContent = (data && data.error) ? data.error : \"密碼錯誤\";\n";
  html += "}\n";
  html += "})\n";
  html += ".catch(function(){\n";
  html += "btn.disabled = false; btn.textContent = \"送出\";\n";
  html += "errEl.textContent = \"連線失敗，請稍後再試\";\n";
  html += "});\n";
  html += "}\n";
  html += "btn.addEventListener(\"click\", submit);\n";
  html += "pwEl.addEventListener(\"keydown\", function(e){ if(e.key === \"Enter\") submit(); });\n";
  html += "})();\n";
  html += "</script>\n";
  html += "</body>\n";
  html += "</html>\n";
  return html;
}

// 版本記錄：取某檔案的 commit 歷史（依 path 過濾），查不到就回空陣列，不當成錯誤
async function getHistory(env, path) {
  const q = `path=${encodeURIComponent(path)}&sha=${BRANCH}&per_page=20`;
  const r = await fetch(`${GH}/repos/${OWNER}/${REPO}/commits?${q}`, { headers: ghHeaders(env) });
  if (r.status === 404) return [];
  if (!r.ok) throw new Error("GitHub 回應 " + r.status);
  const list = await r.json();
  if (!Array.isArray(list)) return [];
  return list.map(function (c) {
    const commit = c.commit || {};
    const author = commit.author || {};
    return {
      sha: c.sha,
      shortSha: (c.sha || "").slice(0, 7),
      message: commit.message || "",
      date: author.date || "",
    };
  });
}

// 版本記錄：取某次 commit 當下、Contents API 回傳的檔案內容（base64 解碼成 UTF-8 字串）
async function getContentAt(env, path, sha) {
  const encPath = encodeURIComponent(path).replace(/%2F/g, "/");
  const r = await fetch(`${GH}/repos/${OWNER}/${REPO}/contents/${encPath}?ref=${encodeURIComponent(sha)}`, { headers: ghHeaders(env) });
  if (r.status === 404) throw new Error("找不到該版本內容");
  if (!r.ok) throw new Error("GitHub 回應 " + r.status);
  const data = await r.json();
  if (!data || typeof data.content !== "string") throw new Error("內容格式不正確");
  return ub64(data.content);
}
