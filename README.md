# editnote

線上 HTML 記事本編輯器 + 一鍵發佈。

## 結構

```
editnote/
├── index.html      編輯器本身（editnote.pages.dev）
├── pages/          發佈出去的網頁（editnote.pages.dev/pages/xxx.html）
└── worker/         發佈後端（Cloudflare Worker，收 HTML → commit 到 GitHub）
```

## 發佈流程

編輯器編輯 → 點「發佈」→ Worker 驗證密碼 → 用 GitHub API commit 到 `pages/`
→ Cloudflare Pages 自動部署 → 網頁上線。

手機、電腦都能發佈。
