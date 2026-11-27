# 零件行情儀

點 Windows 桌機或 MacBook 剖面裡的零件，看它 2020 年以來的真實價格紀錄與來源。

- 網站：`index.html`，資料在 `data/prices.json`
- 每月 1 日台灣時間 09:00，GitHub Actions 會用 Claude（`claude-opus-5-5` + 網路搜尋）查有設定 `track` 的零件本月價格，通過檢查才寫入，接著重新部署到 GitHub Pages。

## 第一次設定

1. **Settings → Pages → Build and deployment → Source** 選 **GitHub Actions**。
2. **Settings → Secrets and variables → Actions → New repository secret**，名稱 `ANTHROPIC_API_KEY`，值填你的 Anthropic API key（到 https://platform.claude.com 申請）。
3. 到 **Actions → 更新價格並部署 → Run workflow** 手動跑一次，確認查價與部署都正常。

## 自動更新的檢查規則

查到的價格必須同時符合下面條件才會寫入，否則在該次執行的 Summary 標示「未更新」與原因：

- 有明確的來源網址，而且這個網址真的出現在搜尋結果裡
- 價格日期在最近 45 天內
- 和上一筆相比沒有暴漲或暴跌三倍以上（避免查錯型號）
- 本月還沒有資料

## 本機執行

```bash
npm ci
ANTHROPIC_API_KEY=... node scripts/update-prices.mjs --dry-run     # 只查不寫
ANTHROPIC_API_KEY=... node scripts/update-prices.mjs --only=ram    # 只查記憶體
node scripts/validate-data.mjs
```

## 費用

每次約查 7 個零件，每個零件一次含網路搜尋的 Claude 呼叫加一次整理呼叫，按 Anthropic API 用量計費。
