// 部署前檢查 data/prices.json 結構，壞掉就讓 workflow 失敗，避免把壞資料發佈出去。
import fs from "node:fs";

const db = JSON.parse(fs.readFileSync(new URL("../data/prices.json", import.meta.url), "utf8"));
const errors = [];
if (!/^\d{4}-\d{2}-\d{2}$/.test(db.checked ?? "")) errors.push("checked 日期格式錯誤");
for (const [k, s] of Object.entries(db.sources ?? {})) {
  if (!s.title || !/^https?:\/\//.test(s.url ?? "")) errors.push(`來源 ${k} 缺標題或網址`);
}
for (const [m, machine] of Object.entries(db.machines ?? {})) {
  for (const [id, p] of Object.entries(machine.parts ?? {})) {
    const where = `${m}/${id}`;
    if (p.noData) continue;
    if (!["USD", "TWD"].includes(p.cur)) errors.push(`${where} 幣別錯誤`);
    if (!Array.isArray(p.pts) || !p.pts.length) { errors.push(`${where} 沒有資料點`); continue; }
    let prev = "";
    for (const pt of p.pts) {
      if (!/^\d{4}-\d{2}$/.test(pt.date)) errors.push(`${where} 日期格式錯誤：${pt.date}`);
      if (pt.date < prev) errors.push(`${where} 日期沒有照順序：${pt.date}`);
      if (!(pt.value > 0)) errors.push(`${where} 價格錯誤：${pt.value}`);
      if (pt.source && !db.sources[pt.source]) errors.push(`${where} 找不到來源 ${pt.source}`);
      prev = pt.date;
    }
    for (const k of p.src ?? []) if (!db.sources[k]) errors.push(`${where} 找不到來源 ${k}`);
  }
}
if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log("prices.json OK");
