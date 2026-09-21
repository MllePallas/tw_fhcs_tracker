/* Shared escaped Markdown renderer for published reports. */
window.ReportMarkdown = (() => {
const escapeHtml = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\"/g,'&quot;').replace(/'/g,'&#39;');
function render(md) {
  const src = String(md || '').replace(/\r\n?/g, '\n');
  const lines = src.split('\n');
  const out = [];
  let i = 0;

  const inline = (t) => escapeHtml(t)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*\\])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    // 反斜線跳脫（報告常用 \* 當註記符號）→ 還原為字元本身
    .replace(/\\([*_|`\\])/g, '$1');

  const isTableSep = (s) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(s);
  const splitRow = (s) => s.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(c => c.trim());
  // 純粹的帶正負號數字（含 % 與 *、† 註記符）→ 沿用站內方向色，讓報告表格與總表讀起來一致
  const signClass = (cell) => {
    const m = /^([+-])[\d,.]+\s*%?\s*[*†]?$/.exec(cell);
    return m ? (m[1] === '-' ? ' num-neg' : ' num-pos') : '';
  };

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) { i++; continue; }

    // 分隔線
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { out.push('<hr>'); i++; continue; }

    // 標題（頁面 h1 由報告標題提供 → # 與 ## 皆對應 h2）
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const lv = Math.min(Math.max(h[1].length, 2), 5);
      out.push(`<h${lv}>${inline(h[2].trim())}</h${lv}>`);
      i++;
      continue;
    }

    // 表格
    if (line.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const head = splitRow(line);
      const aligns = splitRow(lines[i + 1]).map(s => {
        const l = s.startsWith(':'), r = s.endsWith(':');
        return r && !l ? 'right' : (l && r ? 'center' : '');
      });
      i += 2;
      const body = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        body.push(splitRow(lines[i])); i++;
      }
      const th = head.map((cell, k) =>
        `<th${aligns[k] ? ` class="ta-${aligns[k]}"` : ''}>${inline(cell)}</th>`).join('');
      const tr = body.map(row =>
        `<tr>${row.map((cell, k) => {
          const cls = `${aligns[k] ? `ta-${aligns[k]}` : ''}${signClass(cell)}`.trim();
          return `<td${cls ? ` class="${cls}"` : ''}>${inline(cell)}</td>`;
        }).join('')}</tr>`).join('');
      out.push(`<div class="report-table-wrap"><table class="report-table"><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table></div>`);
      continue;
    }

    // 引言（連續 > 行合併）
    if (/^\s*>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s?/, '')); i++;
      }
      out.push(`<blockquote>${buf.map(inline).join('<br>')}</blockquote>`);
      continue;
    }

    // 清單（- / * / 數字）
    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\.\s+/.test(line);
      const items = [];
      while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i])) {
        let text = lines[i].replace(/^\s*([-*+]|\d+\.)\s+/, '');
        i++;
        // 續行（縮排且非新項目）併入同一項
        while (i < lines.length && lines[i].trim() && !/^\s*([-*+]|\d+\.)\s+/.test(lines[i])
               && !/^#{1,4}\s/.test(lines[i]) && /^\s{2,}/.test(lines[i])) {
          text += ' ' + lines[i].trim(); i++;
        }
        items.push(`<li>${inline(text)}</li>`);
      }
      out.push(`<${ordered ? 'ol' : 'ul'}>${items.join('')}</${ordered ? 'ol' : 'ul'}>`);
      continue;
    }

    // 段落（連續非空行合併）
    const para = [];
    while (i < lines.length && lines[i].trim()
           && !/^#{1,4}\s/.test(lines[i]) && !/^\s*>\s?/.test(lines[i])
           && !/^\s*([-*+]|\d+\.)\s+/.test(lines[i])
           && !/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(lines[i])
           && !(lines[i].includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1]))) {
      para.push(lines[i]); i++;
    }
    if (para.length) {
      const html = para.map(inline).join('<br>');
      // 整段都是斜體 → 視為單位／口徑說明的小字說明列
      const capt = /^<em>([\s\S]*)<\/em>$/.exec(html);
      out.push(capt ? `<p class="report-caption">${capt[1]}</p>` : `<p>${html}</p>`);
    }
  }

  return out.join('\n');
}

return {render};
})();
