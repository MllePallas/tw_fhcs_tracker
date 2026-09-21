// Report archive navigation is index-driven; archived pre-2026/06 reports are not listed.
fetch('./index.json').then(r=>r.ok?r.json():{reports:[]}).then(index=>{
  const menu=document.getElementById('report-menu');
  for(const entry of index.reports||[]){
    if(!/^202\d\/\d{2}$/.test(entry.period)||entry.period<'2026/06')continue;
    const link=document.createElement('a');
    link.textContent=entry.period;
    link.href=entry.html_file&&/^\d{4}-\d{2}\.html$/.test(entry.html_file)?'./'+entry.html_file:'../report.html?period='+entry.period.replace('/','-');
    menu.append(link);
  }
}).catch(()=>{});
