// Render the editable Markdown through the same escaped renderer as the browser.
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const sandbox = {window:{}};
vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../docs/report-renderer.js'),'utf8'),sandbox);
const esc = s => String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const markdown=input.markdown.replace(/^#\s+[^\n]+\n/, '');
let count=0;
let body=sandbox.window.ReportMarkdown.render(markdown).replace(/<h2>/g,()=>`<h2 id="section-${count++}">`);
const sections=[...body.matchAll(/<h2 id="([^"]+)">([^<]+)<\/h2>/g)];
const nav=sections.map(([_,id,title],i)=>`<a href="#${id}" title="${esc(title)}">${['本月重點','金控','壽險','銀行','證券','資料說明'][i]||title}</a>`).join('');
const nf=new Intl.NumberFormat('zh-TW',{minimumFractionDigits:1,maximumFractionDigits:1});
let cards='';
if (!input.meta.data_changed) {
  for(const [kind,label] of [['holding','金控'],['life','壽險'],['bank','銀行'],['securities','證券']]){
    const {n,current,base,pct}=input.totals[kind];
    cards+=`<div class="kpi"><span class="k-label">${n}家可比${label}單月合計</span><span class="k-value">${n?nf.format(current):'—'}</span><span class="k-delta ${pct>=0?'up':'down'}">${pct===null?'—':(pct>0?'+':'')+nf.format(pct)+'%'} MoM</span><span class="k-foot">前月：${n?nf.format(base):'—'}</span></div>`;
  }
}
const status=input.meta.data_changed?'原始資料已有更新，本文保留人工修訂':input.meta.ai_status==='fallback'?'新聞分析暫未完成，先提供數字趨勢':input.meta.manual?'人工修訂版':'依公開數據與新聞自動產製';
const title=esc(input.markdown.match(/^#\s+([^\n]+)/)?.[1]||`${input.period} 金控自結獲利分析`);
process.stdout.write(`<!DOCTYPE html><html lang="zh-Hant" data-theme="light"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><link rel="stylesheet" href="../report-design.css"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Noto+Serif+TC:wght@500;700&family=Noto+Sans+TC:wght@400;500;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap"></head><body><main class="wrap"><div class="preview-tools"><a href="../index.html">← 返回金控月報</a><button onclick="window.print()">列印／存成 PDF</button></div><header class="masthead"><p class="eyebrow">TAIWAN FINANCIAL HOLDINGS · ${esc(input.period)}</p><h1>${title}</h1><div class="meta"><span class="chip">${input.pack.coverage.available}／13 家已公告</span><span>單位：新台幣億元</span><span>來源：MOPS 月自結</span></div><p class="status-note">${status}</p></header>${cards?'<div class="kpis">'+cards+'</div>':''}<nav aria-label="報告章節">${nav}</nav><div class="report-menu" id="report-menu"></div><article class="report-body">${body}</article><footer class="disclaimer">資料來源：MOPS 月自結、公開財經報導與公司新聞稿、Yahoo Finance、TWSE。© 2026 Mandy Chao</footer></main><script src="../report-navigation.js"></script></body></html>`);
