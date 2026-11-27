// 每月更新零件價格：用 OpenAI + 網路搜尋查本月價格，驗證後寫回 data/prices.json。
// 用法：
//   node scripts/update-prices.mjs              查所有有 track 設定的零件並寫檔
//   node scripts/update-prices.mjs --dry-run    只查不寫
//   node scripts/update-prices.mjs --only=ram   只查某個零件
// 需要環境變數 OPENAI_API_KEY；可用 OPENAI_MODEL 換模型。

import fs from "node:fs";
import OpenAI from "openai";
import { z } from "zod";
import { zodTextFormat } from "openai/helpers/zod";

const FILE = new URL("../data/prices.json", import.meta.url);
const MODEL = process.env.OPENAI_MODEL || "gpt-5.5";
const DRY = process.argv.includes("--dry-run");
const ONLY = process.argv.find((a) => a.startsWith("--only="))?.slice(7);

// 以台灣時間決定「本月」
const twNow = new Date(Date.now() + 8 * 3600 * 1000);
const TODAY = twNow.toISOString().slice(0, 10);
const MONTH = TODAY.slice(0, 7);

const client = new OpenAI();

const Result = z.object({
  found: z.boolean(),
  price: z.number(),
  observed_date: z.string(),
  product: z.string(),
  source_url: z.string(),
  source_title: z.string(),
  reason: z.string(),
});

const normUrl = (u) => {
  try {
    const x = new URL(u);
    return (x.host.replace(/^www\./, "") + x.pathname).replace(/\/+$/, "").toLowerCase();
  } catch {
    return "";
  }
};

// 存檔前拿掉 utm_ 追蹤參數（OpenAI 引用網址會加上 utm_source=openai）
const cleanUrl = (u) => {
  try {
    const x = new URL(u);
    for (const k of [...x.searchParams.keys()]) if (k.startsWith("utm_")) x.searchParams.delete(k);
    return x.toString();
  } catch {
    return u;
  }
};

async function research(part) {
  const currency = part.cur === "TWD" ? "新台幣（TWD）" : "美元（USD）";
  const last = part.pts[part.pts.length - 1];
  const prompt = `今天是 ${TODAY}。請用網路搜尋查出這個價格，只要真實查得到的數字，不要估計：

${part.track.query}

規格說明：${part.spec}
幣別：${currency}
目前資料庫最後一筆：${last.date} = ${last.value}（${last.note}）

要求：
- 價格必須來自最近 30 天內發布或更新的網頁，並寫出該網頁的 URL、標題與價格觀察日期。
- 優先用官方網站、主要零售通路或知名科技媒體的價格追蹤文章。
- 如果查不到最近 30 天的可靠價格，就明白說查不到，不要拿舊資料或推測值充數。
- 最後用一小段話總結：價格、日期、產品名稱、來源 URL。`;

  const resp = await client.responses.create({
    model: MODEL,
    reasoning: { effort: "medium" },
    tools: [{ type: "web_search" }],
    include: ["web_search_call.action.sources"],
    input: prompt,
  });

  // 收集搜尋實際回傳過的網址，用來確認來源不是編出來的
  const urls = new Set();
  for (const item of resp.output) {
    if (item.type === "web_search_call") {
      const a = item.action;
      for (const s of a?.sources ?? []) if (s.url) urls.add(normUrl(s.url));
      if (a?.url) urls.add(normUrl(a.url));
    }
    if (item.type === "message") {
      for (const c of item.content) {
        for (const ann of c.annotations ?? []) if (ann.type === "url_citation") urls.add(normUrl(ann.url));
      }
    }
  }
  const text = resp.output_text;
  return { text, urls };
}

async function extract(part, notes) {
  const resp = await client.responses.parse({
    model: MODEL,
    reasoning: { effort: "low" },
    text: { format: zodTextFormat(Result, "price_result") },
    input: [
      {
        role: "user",
        content: `以下是查價筆記。請整理成指定欄位。
- found：筆記中有沒有最近 30 天、附來源 URL 的明確價格。沒有就填 false，price 填 0。
- price：單一數字，幣別 ${part.cur}，不含符號與千分位。若筆記給的是區間，取最低的實際售價。
- observed_date：價格觀察日期，格式 YYYY-MM-DD。
- product：實際產品名稱。
- source_url、source_title：價格來源網頁。
- reason：一句話說明判斷依據。

<notes>
${notes}
</notes>`,
      },
    ],
  });
  if (!resp.output_parsed) throw new Error("無法解析查價結果");
  return resp.output_parsed;
}

function validate(part, r, urls) {
  const last = part.pts[part.pts.length - 1];
  if (!r.found) return "查不到最近 30 天的可靠價格：" + r.reason;
  if (!(r.price > 0)) return "價格不是正數";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(r.observed_date)) return "日期格式錯誤：" + r.observed_date;
  const age = (Date.parse(TODAY) - Date.parse(r.observed_date)) / 86400000;
  if (!(age >= -1 && age <= 45)) return `價格日期 ${r.observed_date} 不在最近 45 天內`;
  if (!urls.has(normUrl(r.source_url))) return "來源網址沒有出現在搜尋結果中：" + r.source_url;
  const ratio = r.price / last.value;
  if (ratio < 1 / 3 || ratio > 3) return `價格變動過大（${last.value} → ${r.price}），需人工確認`;
  return null;
}

const db = JSON.parse(fs.readFileSync(FILE, "utf8"));
const report = [];
let changed = 0;

for (const [m, machine] of Object.entries(db.machines)) {
  for (const [id, part] of Object.entries(machine.parts)) {
    if (!part.track || !part.pts?.length) continue;
    if (ONLY && ONLY !== id) continue;
    const label = `${machine.label.split("・").pop()}／${part.name}`;
    if (part.pts.some((p) => p.date === MONTH)) {
      report.push([label, "略過", `${MONTH} 已有資料`]);
      continue;
    }
    try {
      const { text, urls } = await research(part);
      const r = await extract(part, text);
      const err = validate(part, r, urls);
      if (err) {
        report.push([label, "未更新", err]);
        continue;
      }
      const key = `auto-${id}-${MONTH}`;
      db.sources[key] = { title: r.source_title, url: cleanUrl(r.source_url) };
      part.pts.push({ date: MONTH, value: Math.round(r.price * 100) / 100, note: `${part.track.note}：${r.product}`, source: key });
      part.src = [...new Set([...(part.src ?? []), key])];
      changed++;
      report.push([label, "已更新", `${r.price} ${part.cur}（${r.observed_date}）${r.source_url}`]);
    } catch (e) {
      if (e instanceof OpenAI.AuthenticationError) throw new Error("OPENAI_API_KEY 無效或沒有設定");
      report.push([label, "錯誤", e instanceof OpenAI.APIError ? `API ${e.status}：${e.message}` : String(e.message ?? e)]);
    }
  }
}

db.checked = TODAY;
if (!DRY) fs.writeFileSync(FILE, JSON.stringify(db, null, 2) + "\n");

const md = [`### 價格更新 ${TODAY}${DRY ? "（試跑，未寫檔）" : ""}`, "", "| 零件 | 結果 | 說明 |", "|---|---|---|",
  ...report.map((r) => `| ${r.map((c) => String(c).replace(/\|/g, "\\|").replace(/\n/g, " ")).join(" | ")} |`),
  "", `新增 ${changed} 筆資料點。`].join("\n");
console.log(md);
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + "\n");
