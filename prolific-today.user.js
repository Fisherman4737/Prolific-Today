// ==UserScript==
// @name         Prolific Today Earnings — Market-Ready (tooltips)
// @namespace    https://prolific.today
// @version      3.8
// @description  Sums today's Approved + Awaiting Review (Reward + Adjustment, £→$ with live or manual FX). Pagination (early stop). Sleek draggable UI, dark mode, TZ picker, goals with progress (persistent), week sparkline w/ weekday labels & hover tooltips, CSV export. Local-only.
// @match        https://app.prolific.com/submissions*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @downloadURL https://raw.githubusercontent.com/Fisherman4737/Prolific-Today/main/prolific-today.user.js
// @updateURL   https://raw.githubusercontent.com/Fisherman4737/Prolific-Today/main/prolific-today.user.js
// @connect      api.exchangerate.host
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  // -------- constants / storage keys
  const DEFAULT_GBP_USD = 1.3;
  const STORAGE_KEY_LAST = 'prolific_today_last';
  const STORAGE_KEY_LOG  = 'prolific_today_log';
  const STORAGE_KEY_MIN  = 'prolific_today_minimized';
  const STORAGE_KEY_TZ   = 'prolific_today_timezone';
  const STORAGE_KEY_POS  = 'prolific_today_position';

  const STORAGE_KEY_FX_RATE = 'prolific_fx_rate';
  const STORAGE_KEY_FX_AT   = 'prolific_fx_synced_at';
  const STORAGE_KEY_FX_MODE = 'prolific_fx_mode'; // 'auto'|'manual'

  const STORAGE_KEY_GOAL_D  = 'prolific_goal_daily';
  const STORAGE_KEY_GOAL_W  = 'prolific_goal_weekly';

  const MAX_PAGES=20, PAGE_WAIT_MS=20000, POLL_MS=250;

  const ROW_SELECTORS = [
    'section.submissions-table div.flex-table.row[role="row"]',
    'section.submissions-table [data-testid*="submission"][role="row"]',
    'section.submissions-table [role="row"]'
  ];

  // -------- state
  let CUR_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Chicago';
  let FX_MODE = 'auto';
  let FX_RATE = DEFAULT_GBP_USD;
  let FX_AT   = null;

  let panelEl=null, mounted=false, mounting=false;
  let progressEl=null, spinnerEl=null, toastEl=null;
  let goalSaveTimer=null;

  // -------- boot
  ensureMounted();
  setTimeout(ensureMounted, 600);
  addEventListener('pageshow', ensureMounted);
  addEventListener('DOMContentLoaded', ensureMounted);

  async function ensureMounted(){
    if(mounted||mounting) return;
    mounting=true;

    const savedTZ = await GM_getValue(STORAGE_KEY_TZ, null);
    if(savedTZ && isValidTimeZone(savedTZ)) CUR_TZ = savedTZ;

    FX_MODE = (await GM_getValue(STORAGE_KEY_FX_MODE,'auto')) || 'auto';
    FX_RATE = Number(await GM_getValue(STORAGE_KEY_FX_RATE, DEFAULT_GBP_USD)) || DEFAULT_GBP_USD;
    FX_AT   = await GM_getValue(STORAGE_KEY_FX_AT, null);

    await waitForBody();
    injectStyles();
    panelEl = buildPanel();
    document.body.appendChild(panelEl);
    attachHandlers();
    mounted=true; mounting=false;

    new MutationObserver(()=>{ if(!document.body.contains(panelEl)){ mounted=false; ensureMounted(); } })
      .observe(document.body,{childList:true,subtree:true});

    new MutationObserver(applyTheme).observe(document.documentElement,{
      attributes:true, attributeFilter:['class','data-darkreader-mode','data-darkreader-scheme']
    });
    applyTheme();

    const isMin = await GM_getValue(STORAGE_KEY_MIN,false);
    setMinimized(isMin);
    setTZLabel(CUR_TZ);
    setFxLabel();

    await restorePosition();

    await renderGoalsFromStorage();
    restoreLast();
    renderHistorySparkline(); // with hover tooltips
  }

  // -------- small helpers
  function waitForBody(timeout=15000){ return new Promise(res=>{ if(document.body) return res(document.body); const t0=Date.now(); const i=setInterval(()=>{ if(document.body){ clearInterval(i); res(document.body); } else if(Date.now()-t0>timeout){ clearInterval(i); res(document.documentElement); } },25); }); }
  function qs(s){ return panelEl.querySelector(s); }
  function toast(msg){ const b=document.createElement('div'); b.className='bubble'; b.textContent=msg; toastEl.appendChild(b); setTimeout(()=>b.remove(),2800); }
  function setMsg(s){ const el=qs('#pt-msg'); if(!el)return; el.textContent=s||''; if(!s)return; setTimeout(()=>{ if(el.textContent===s) el.textContent=''; },3500); }
  function setProgress(p){ if(progressEl) progressEl.style.width=Math.max(0,Math.min(100,p|0))+'%'; }
  function showSpinner(s){ if(spinnerEl) spinnerEl.style.display=s?'inline-block':'none'; }

  // -------- styles / theme
  function applyTheme(){
    if(!panelEl) return;
    const de=document.documentElement;
    const isDarkReader = de.getAttribute('data-darkreader-mode')==='dynamic' || de.getAttribute('data-darkreader-scheme')==='dark';
    const isSiteDark   = de.classList.contains('dark');
    const bodyDark     = (getComputedStyle(document.body).colorScheme||'').includes('dark');
    const isDark = isDarkReader || isSiteDark || bodyDark;
    panelEl.classList.toggle('dark', isDark);
    panelEl.classList.toggle('auto-dark', !isDark);
  }

  function injectStyles(){
    GM_addStyle(`
      :root { --pt-accent:#4f46e5; --pt-green:#22c55e; --pt-danger:#ef4444; }
      #prolific-today-panel{
        --bg: rgba(255,255,255,.82); --fg:#0f172a; --muted:#5b6b85; --border:rgba(15,23,42,.12);
        --btnbg:rgba(255,255,255,.96); --btnfg:#0f172a; --shadow:0 10px 40px rgba(2,6,23,.12);
        position:fixed; right:16px; bottom:24px; z-index:2147483647;
        background:var(--bg); color:var(--fg);
        border:1px solid var(--border); border-radius:14px;
        padding:12px; width:390px; max-width:95vw;
        box-shadow:var(--shadow); font:13px system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial;
        backdrop-filter:saturate(140%) blur(10px); user-select:none; max-height:calc(100vh - 48px); overflow:hidden;
      }
      #prolific-today-panel .drag-handle{cursor:move;}
      #prolific-today-panel .toprow{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px;flex-wrap:wrap;}
      #prolific-today-panel .title{font-weight:700;display:flex;align-items:center;gap:8px;}
      #prolific-today-panel .title .dot{width:10px;height:10px;border-radius:999px;background:var(--pt-accent);box-shadow:0 0 0 4px rgba(79,70,229,.15);}
      #prolific-today-panel .muted{color:var(--muted);}
      #prolific-today-panel .big{font-size:22px;font-weight:800;}
      #prolific-today-panel .row{display:flex;justify-content:space-between;gap:8px;margin:8px 0;align-items:center;flex-wrap:wrap;min-height:22px;}
      #prolific-today-panel .tiny{font-size:11px;}

      /* buttons */
      #prolific-today-panel .btn{
        padding:7px 12px;border-radius:10px;border:1px solid var(--border);
        background:var(--btnbg);color:var(--btnfg);cursor:pointer;
        display:inline-flex;align-items:center;gap:8px;min-height:32px;white-space:nowrap;
      }
      #prolific-today-panel .btn .ico{font-size:14px;line-height:0;}
      #prolific-today-panel .btn .label{display:inline-block;}
      #prolific-today-panel .btn.primary{border-color:rgba(79,70,229,.35);background:linear-gradient(180deg, rgba(255,255,255,.97), rgba(79,70,229,.08)); min-width:130px;}
      #prolific-today-panel .btn.success{border-color:rgba(34,197,94,.35);background:linear-gradient(180deg, rgba(255,255,255,.97), rgba(34,197,94,.10)); min-width:96px;}
      #prolific-today-panel .btn.warn{border-color:rgba(239,68,68,.35);background:linear-gradient(180deg, rgba(255,255,255,.97), rgba(239,68,68,.08)); min-width:86px;}
      #prolific-today-panel .btn.icon{padding:6px; width:34px; justify-content:center; }
      #prolific-today-panel .btn.icon .label{display:none;}
      #prolific-today-panel .btn:hover{transform:translateY(-1px);border-color:rgba(79,70,229,.35);}

      /* progress */
      #pt-progress-wrap{position:relative;height:6px;background:rgba(2,6,23,.08);border-radius:999px;overflow:hidden;margin:6px 0 4px;border:1px solid var(--border);}
      #pt-progress{position:absolute;left:0;top:0;height:100%;width:0%;background:linear-gradient(90deg, var(--pt-accent), #7c3aed);transition:width .28s ease;}
      #pt-spinner{display:none;margin-left:6px;width:14px;height:14px;border-radius:50%;border:2px solid rgba(79,70,229,.25);border-top-color:var(--pt-accent);animation:spin .9s linear infinite;}
      @keyframes spin{to{transform:rotate(360deg)}}

      /* minimized state */
      #prolific-today-panel.collapsed{ width:340px; padding:10px 12px; }
      #prolific-today-panel.collapsed .hide-when-collapsed{ display:none !important; }
      #prolific-today-panel .minbtn{border-radius:10px;display:inline-flex;align-items:center;gap:6px;}
      #prolific-today-panel .minbtn .chev{font-weight:700;}

      /* tz overlay */
      #pt-tz-overlay{position:absolute; right:8px; top:46px; width:320px; background:var(--bg); color:var(--fg); border:1px solid var(--border); border-radius:12px; box-shadow:var(--shadow); padding:10px; z-index:2147483647; display:none; backdrop-filter:saturate(140%) blur(8px);}
      #pt-tz-filter,#pt-tz-select{ width:100%; }
      #pt-tz-filter{ padding:8px 10px; border:1px solid var(--border); border-radius:10px; background:rgba(255,255,255,.96);}
      #pt-tz-select{ padding:6px 8px; border:1px solid var(--border); border-radius:10px; height:190px; background:rgba(255,255,255,.96);}

      /* goals */
      .pt-section{border-top:1px dashed var(--border); padding-top:6px; margin-top:6px;}
      .pt-input{width:120px;padding:6px 8px;border:1px solid var(--border);border-radius:8px;background:rgba(255,255,255,.96); color: var(--fg);}
      .pt-bar{position:relative;height:7px;background:rgba(2,6,23,.08);border-radius:999px;overflow:hidden;border:1px solid var(--border);}
      .pt-fill{position:absolute;left:0;top:0;height:100%;width:0%;background:linear-gradient(90deg, var(--pt-green), #16a34a);transition:width .25s ease;}
      .pt-barlabel{margin-left:8px;}
      #pt-history{ display:none; margin-top:6px; }
      #pt-history.open{ display:block; }
      #pt-spark{ width:100%; height:36px; }
      #pt-spark-labels{ display:grid; grid-template-columns: repeat(7,1fr); gap:2px; margin-top:4px; }
      #pt-spark-labels .lab{ text-align:center; font-size:10px; color:var(--muted); padding-top:2px; }
      #pt-spark-labels .is-today{ font-weight:700; color:var(--fg); }
      #pt-spark-labels .is-today::after{ content:'•'; margin-left:3px; }

      /* toast */
      #pt-toast{position:fixed; right:18px; bottom:18px; z-index:2147483647; pointer-events:none;}
      #pt-toast .bubble{background:rgba(15,23,42,.92); color:#e5e7eb; padding:10px 12px; border-radius:12px; margin-top:8px; box-shadow:0 14px 40px rgba(2,6,23,.35); max-width:360px; font:13px system-ui,-apple-system,Segoe UI,Roboto;}

      /* dark theme base */
      #prolific-today-panel.dark{ --bg: rgba(11,18,32,.86); --fg:#e6edf6; --muted:#9fb0c7; --border:rgba(148,163,184,.18); --btnbg:rgba(15,22,41,.95); }
      #prolific-today-panel.auto-dark{ --bg: rgba(11,18,32,.86); --fg:#e6edf6; --muted:#9fb0c7; --border:rgba(148,163,184,.18); --btnbg:rgba(15,22,41,.95); }

      /* dark-mode input visibility */
      #prolific-today-panel.dark .pt-input,
      #prolific-today-panel.auto-dark .pt-input{
        background: var(--btnbg);
        color: var(--fg);
        border-color: var(--border);
        caret-color: var(--fg);
      }
      #prolific-today-panel.dark .pt-input::placeholder,
      #prolific-today-panel.auto-dark .pt-input::placeholder{
        color: var(--muted);
        opacity: .9;
      }
      #prolific-today-panel.dark .pt-input::-webkit-inner-spin-button,
      #prolific-today-panel.dark .pt-input::-webkit-outer-spin-button,
      #prolific-today-panel.auto-dark .pt-input::-webkit-inner-spin-button,
      #prolific-today-panel.auto-dark .pt-input::-webkit-outer-spin-button{
        filter: invert(1);
      }
    `);
  }

  // -------- UI
  function buildPanel(){
    const wrap=document.createElement('div');
    wrap.id='prolific-today-panel';
    wrap.style.position='fixed';
    wrap.innerHTML = `
      <div class="toprow">
        <div class="title drag-handle"><span class="dot"></span> Prolific Today</div>
        <div style="display:flex;align-items:center;gap:6px;">
          <div id="pt-tz-label" class="muted tiny">—</div>
          <button id="pt-tz" class="btn icon" title="Choose Time Zone" aria-label="Choose Time Zone">🕒</button>
          <button id="pt-min" class="btn minbtn" aria-label="Minimize"><span class="chev" id="pt-min-ico">▾</span><span class="label" id="pt-min-label">Minimize</span></button>
        </div>
      </div>

      <div id="pt-progress-wrap" class="hide-when-collapsed" aria-hidden="true"><div id="pt-progress"></div></div>

      <div class="row"><div class="muted">Last saved total</div><div id="pt-total" class="big">$0.00</div></div>

      <div class="hide-when-collapsed">
        <div class="row muted"><div>Updated</div><div id="pt-updated">—</div></div>
        <div class="row muted"><div>Breakdown</div><div id="pt-breakdown">Approved 0 • Awaiting 0</div></div>

        <div class="row muted" style="gap:10px;">
          <label style="display:flex;gap:8px;align-items:center;">
            <input id="pt-all" type="checkbox" checked> Include paginated pages (early stop)
          </label>
          <div style="display:flex;align-items:center;margin-left:auto;">
            <div id="pt-pages" class="tiny muted">—</div>
            <div id="pt-spinner"></div>
          </div>
        </div>

        <div class="row" style="gap:8px;">
          <div class="muted">GBP→USD</div>
          <div id="pt-fx-label" class="tiny muted" style="flex:1;min-width:120px;">—</div>
          <button id="pt-fx-sync" class="btn icon" title="Sync live rate" aria-label="Sync FX">🔄</button>
          <button id="pt-fx-edit" class="btn icon" title="Set manual rate" aria-label="Set FX">✎</button>
        </div>

        <div id="pt-fx-editor" class="row" style="display:none;">
          <div class="muted">Manual rate</div>
          <div style="display:flex; align-items:center; gap:6px;">
            <input id="pt-fx-input" class="pt-input" type="number" min="0" step="0.0001" placeholder="e.g. 1.3000">
            <button id="pt-fx-save" class="btn success"><span class="label">Save</span></button>
            <button id="pt-fx-cancel" class="btn"><span class="label">Cancel</span></button>
          </div>
        </div>

        <div class="pt-section">
          <div class="row"><div><strong>Goals</strong></div><div class="tiny muted">Optional</div></div>
          <div class="row"><div>Daily goal</div><div style="display:flex;gap:6px;align-items:center;"><span class="tiny muted">$</span><input id="pt-goal-d" class="pt-input" type="number" min="0" step="0.01" placeholder="e.g. 25"></div></div>
          <div class="row" style="align-items:center;"><div class="pt-bar" style="flex:1;"><div id="pt-d-fill" class="pt-fill"></div></div><div id="pt-d-label" class="tiny muted pt-barlabel">—</div></div>
          <div class="row"><div>Weekly goal</div><div style="display:flex;gap:6px;align-items:center;"><span class="tiny muted">$</span><input id="pt-goal-w" class="pt-input" type="number" min="0" step="0.01" placeholder="e.g. 150"></div></div>
          <div class="row" style="align-items:center;"><div class="pt-bar" style="flex:1;"><div id="pt-w-fill" class="pt-fill"></div></div><div id="pt-w-label" class="tiny muted pt-barlabel">—</div></div>
        </div>

        <div class="pt-section">
          <div class="row"><span id="pt-history-toggle" style="cursor:pointer;color:#4f46e5;font-weight:600;">History ▸</span><div class="tiny muted">Week sparkline</div></div>
          <div id="pt-history">
            <svg id="pt-spark" viewBox="0 0 100 36" preserveAspectRatio="none" aria-label="Weekly totals sparkline"></svg>
            <div id="pt-spark-labels" aria-hidden="false"></div>
          </div>
        </div>
      </div>

      <div class="btns" style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;">
        <button id="pt-sum" class="btn primary" title="Shift+S to run"><span class="ico">∑</span><span class="label">Sum & Save</span></button>
        <button id="pt-export" class="btn success" title="Export CSV log"><span class="ico">⬇️</span><span class="label">Export</span></button>
        <button id="pt-clear" class="btn warn" title="Clear saved totals"><span class="ico">🗑️</span><span class="label">Clear</span></button>
      </div>

      <div id="pt-msg" class="tiny muted" style="margin-top:6px;"></div>

      <div class="row tiny muted hide-when-collapsed" style="justify-content:center;gap:8px;margin-top:6px;">
        <span>Local-only • No data leaves your browser</span> •
        <a id="pt-donate" href="https://paypal.me/fishermanstipjar/5" target="_blank" rel="noopener" style="text-decoration:underline;">Support via PayPal ❤️</a>
      </div>

      <div id="pt-tz-overlay" role="dialog" aria-label="Select Time Zone" style="display:none;">
        <div class="row"><strong>Choose time zone</strong></div>
        <div class="row"><input id="pt-tz-filter" type="text" placeholder="Search (e.g., Chicago, London, Tokyo)"></div>
        <div class="row"><select id="pt-tz-select" size="8"></select></div>
        <div style="display:flex; gap:8px; justify-content:flex-end; margin-top:8px;">
          <button id="pt-tz-cancel" class="btn"><span class="label">Cancel</span></button>
          <button id="pt-tz-apply" class="btn primary"><span class="label">Apply</span></button>
        </div>
      </div>
    `;
    toastEl=document.createElement('div'); toastEl.id='pt-toast'; document.body.appendChild(toastEl);
    progressEl=wrap.querySelector('#pt-progress'); spinnerEl=wrap.querySelector('#pt-spinner');
    return wrap;
  }

  // -------- handlers
  function attachHandlers(){
    makeDraggable();

    qs('#pt-min').addEventListener('click', async ()=>{
      const nowMin = !panelEl.classList.contains('collapsed');
      setMinimized(nowMin);
      await GM_setValue(STORAGE_KEY_MIN, nowMin);
    });

    document.addEventListener('keydown',(e)=>{
      if(e.shiftKey && /[sS]/.test(e.key)) runAndSave();
      if(e.shiftKey && /[mM]/.test(e.key)) qs('#pt-min').click();
      if(e.key==='Escape') closeTZOverlay();
    });

    qs('#pt-sum').addEventListener('click', runAndSave);
    qs('#pt-export').addEventListener('click', exportCSV);
    qs('#pt-clear').addEventListener('click', clearSaved);

    // FX
    qs('#pt-fx-sync').addEventListener('click', syncFxRate);
    qs('#pt-fx-edit').addEventListener('click', ()=>toggleFxEditor(true));
    qs('#pt-fx-save').addEventListener('click', saveManualFx);
    qs('#pt-fx-cancel').addEventListener('click', ()=>toggleFxEditor(false));
    qs('#pt-fx-input').addEventListener('keydown', (e)=>{ if(e.key==='Enter') saveManualFx(); });

    // Goals — persist while typing, on blur, and on Enter
    const gd=qs('#pt-goal-d'), gw=qs('#pt-goal-w');
    const scheduleSave=()=>{ clearTimeout(goalSaveTimer); goalSaveTimer=setTimeout(saveGoals, 400); };
    gd.addEventListener('input', scheduleSave);
    gw.addEventListener('input', scheduleSave);
    gd.addEventListener('change', saveGoals);
    gw.addEventListener('change', saveGoals);
    gd.addEventListener('keydown',(e)=>{ if(e.key==='Enter') saveGoals(); });
    gw.addEventListener('keydown',(e)=>{ if(e.key==='Enter') saveGoals(); });

    // History
    qs('#pt-history-toggle').addEventListener('click', ()=>{
      const box=qs('#pt-history');
      box.classList.toggle('open');
      qs('#pt-history-toggle').textContent = box.classList.contains('open') ? 'History ▾' : 'History ▸';
      if(box.classList.contains('open')) renderHistorySparkline();
    });

    // TZ
    qs('#pt-tz').addEventListener('click', openTZOverlay);
    qs('#pt-tz-cancel').addEventListener('click', closeTZOverlay);
    qs('#pt-tz-apply').addEventListener('click', applyTZOverlay);
    qs('#pt-tz-filter').addEventListener('input', filterTZOptions);
    qs('#pt-tz-select').addEventListener('change', applyTZImmediate);

    // Menu
    GM_registerMenuCommand('Prolific: Sum & Save Today', runAndSave);
    GM_registerMenuCommand('Prolific: Minimize/Expand Panel', ()=>qs('#pt-min').click());
    GM_registerMenuCommand('Prolific: Set Time Zone…', ()=>openTZOverlay(true));

    // dblclick title resets position
    panelEl.querySelector('.title').addEventListener('dblclick', async ()=>{
      await GM_setValue(STORAGE_KEY_POS, null);
      panelEl.style.left='';
      panelEl.style.top='';
      panelEl.style.right='16px';
      panelEl.style.bottom='24px';
      toast('Position reset');
    });

    buildTZOptions();
  }

  function setMinimized(min){
    panelEl.classList.toggle('collapsed', !!min);
    const ico=document.getElementById('pt-min-ico');
    const lab=document.getElementById('pt-min-label');
    if(ico) ico.textContent=min?'▴':'▾';
    if(lab) lab.textContent=min?'Expand':'Minimize';
  }

  // -------- TZ overlay
  let allTZ=[];
  function buildTZOptions(){
    const select=qs('#pt-tz-select'); const filter=qs('#pt-tz-filter');
    allTZ=getAllTimeZones();
    const fav=['America/Chicago','America/New_York','America/Denver','America/Los_Angeles','Europe/London','Europe/Berlin','Europe/Paris','Asia/Tokyo','Asia/Singapore','Asia/Kolkata','Australia/Sydney'];
    const scored=allTZ.map(z=>({z,score:(z===CUR_TZ?0:(fav.includes(z)?1:2))})).sort((a,b)=>a.score-b.score||a.z.localeCompare(b.z));
    select.innerHTML=scored.map(o=>`<option value="${o.z}" ${o.z===CUR_TZ?'selected':''}>${o.z}</option>`).join('');
    filter.value='';
  }
  function openTZOverlay(){ const o=qs('#pt-tz-overlay'); o.style.display='block'; const f=qs('#pt-tz-filter'); f.value=''; f.focus(); const s=qs('#pt-tz-select'); const opt=[...s.options].find(o=>o.value===CUR_TZ); if(opt){ s.value=CUR_TZ; s.scrollTop=opt.index*20; } }
  function closeTZOverlay(){ qs('#pt-tz-overlay').style.display='none'; }
  async function applyTZOverlay(){ const s=qs('#pt-tz-select'); const tz=s.value; if(!tz||!isValidTimeZone(tz)){ toast('Choose a valid time zone'); return; } CUR_TZ=tz; setTZLabel(CUR_TZ); await GM_setValue(STORAGE_KEY_TZ,CUR_TZ); closeTZOverlay(); toast(`Time zone → ${CUR_TZ}`); runAndSave(); }
  async function applyTZImmediate(){ const s=qs('#pt-tz-select'); const tz=s.value; if(!tz||!isValidTimeZone(tz)){ toast('Choose a valid time zone'); return; } CUR_TZ=tz; setTZLabel(CUR_TZ); await GM_setValue(STORAGE_KEY_TZ,CUR_TZ); closeTZOverlay(); toast(`Time zone → ${CUR_TZ}`); runAndSave(); }
  function filterTZOptions(){ const q=(qs('#pt-tz-filter').value||'').trim().toLowerCase(); const s=qs('#pt-tz-select'); const list=!q?allTZ:allTZ.filter(z=>z.toLowerCase().includes(q)); const cur=CUR_TZ; s.innerHTML=list.map(z=>`<option value="${z}" ${z===cur?'selected':''}>${z}</option>`).join(''); }
  function setTZLabel(tz){ const el=qs('#pt-tz-label'); if(el) el.textContent=tz; }
  function getAllTimeZones(){ try{ const a=(Intl.supportedValuesOf && Intl.supportedValuesOf('timeZone'))||[]; if(a.length) return a.slice(); }catch{} return ['UTC','America/Chicago','America/New_York','America/Denver','America/Los_Angeles','America/Phoenix','America/Toronto','America/Vancouver','America/Mexico_City','America/Sao_Paulo','Europe/London','Europe/Dublin','Europe/Berlin','Europe/Paris','Europe/Madrid','Europe/Rome','Europe/Amsterdam','Europe/Zurich','Europe/Warsaw','Europe/Athens','Europe/Moscow','Africa/Cairo','Africa/Johannesburg','Africa/Lagos','Africa/Nairobi','Asia/Dubai','Asia/Kolkata','Asia/Dhaka','Asia/Jakarta','Asia/Singapore','Asia/Hong_Kong','Asia/Shanghai','Asia/Tokyo','Asia/Seoul','Asia/Manila','Asia/Bangkok','Australia/Perth','Australia/Adelaide','Australia/Melbourne','Australia/Sydney','Pacific/Auckland']; }
  function isValidTimeZone(tz){ try{ new Intl.DateTimeFormat('en-US',{timeZone:tz}).format(); return true; }catch{ return false; } }

  // -------- FX
  function setFxLabel(){
    const el=qs('#pt-fx-label'); if(!el) return;
    if(FX_MODE==='manual'){
      el.textContent = `${Number(FX_RATE||DEFAULT_GBP_USD).toFixed(4)} (manual)`;
    }else{
      const when = FX_AT ? formatYMD(FX_AT) : '—';
      el.textContent = `${Number(FX_RATE||DEFAULT_GBP_USD).toFixed(4)} (auto${when!=='—'?' • '+when:''})`;
    }
  }
  function toggleFxEditor(show){
    qs('#pt-fx-editor').style.display = show ? '' : 'none';
    if(show){ const i=qs('#pt-fx-input'); i.value = Number(FX_RATE||DEFAULT_GBP_USD).toFixed(4); i.focus(); i.select(); }
  }
  async function saveManualFx(){
    const input = qs('#pt-fx-input');
    const val = Number(input.value);
    if(!val || val<=0 || !isFinite(val)){ toast('Enter a positive number'); return; }
    FX_MODE = 'manual'; FX_RATE = val; FX_AT='manual';
    await GM_setValue(STORAGE_KEY_FX_MODE, FX_MODE);
    await GM_setValue(STORAGE_KEY_FX_RATE, FX_RATE);
    await GM_setValue(STORAGE_KEY_FX_AT,   FX_AT);
    setFxLabel(); toggleFxEditor(false); toast(`Manual FX set: ${FX_RATE.toFixed(4)}`);
  }
  function syncFxRate(){
    FX_MODE='auto'; GM_SetValueSafe(STORAGE_KEY_FX_MODE, FX_MODE);
    showSpinner(true);
    GM_xmlhttpRequest({
      method:'GET',
      url:'https://api.exchangerate.host/latest?base=GBP&symbols=USD',
      headers:{'Accept':'application/json'},
      onload: async (res)=>{
        showSpinner(false);
        try{
          const data = JSON.parse(res.responseText||'{}');
          const rate = Number(data?.rates?.USD);
          if(rate && isFinite(rate)){
            FX_RATE=rate; FX_AT=data.date||new Date().toISOString();
            await GM_SetValueSafe(STORAGE_KEY_FX_RATE, FX_RATE);
            await GM_SetValueSafe(STORAGE_KEY_FX_AT,   FX_AT);
            setFxLabel(); toast(`FX synced: £1 = $${FX_RATE.toFixed(4)}`);
          }else toast('FX sync failed (no rate). Using last rate.');
        }catch{ toast('FX sync parse error. Using last rate.'); }
      },
      onerror: ()=>{ showSpinner(false); toast('FX sync failed (network). Using last rate.'); }
    });
  }
  function formatYMD(dt){ try{ return new Date(dt).toISOString().slice(0,10); }catch{return '—';} }

  // -------- goals (persist across refresh)
  async function renderGoalsFromStorage(){
    const dRaw = await GM_getValue(STORAGE_KEY_GOAL_D, null);
    const wRaw = await GM_getValue(STORAGE_KEY_GOAL_W, null);
    if (dRaw !== null && dRaw !== undefined) qs('#pt-goal-d').value = String(dRaw);
    if (wRaw !== null && wRaw !== undefined) qs('#pt-goal-w').value = String(wRaw);
    updateProgressBars();
  }
  async function saveGoals(){
    const d = qs('#pt-goal-d').value.trim();
    const w = qs('#pt-goal-w').value.trim();
    const dNum = d === '' ? null : Number(d);
    const wNum = w === '' ? null : Number(w);
    await GM_setValue(STORAGE_KEY_GOAL_D, (dNum===null || isNaN(dNum)) ? null : dNum);
    await GM_setValue(STORAGE_KEY_GOAL_W, (wNum===null || isNaN(wNum)) ? null : wNum);
    updateProgressBars();
  }
  async function updateProgressBars(){
    const last = await GM_getValue(STORAGE_KEY_LAST,null);
    const todayUSD = last && last.date===ymd(new Date(),CUR_TZ) ? Number(last.totalUSD||0) : 0;

    const dStored = await GM_getValue(STORAGE_KEY_GOAL_D, null);
    const wStored = await GM_getValue(STORAGE_KEY_GOAL_W, null);

    const dHas = dStored !== null && !isNaN(Number(dStored));
    const wHas = wStored !== null && !isNaN(Number(wStored));

    const dGoal = dHas ? Number(dStored) : 0;
    const wGoal = wHas ? Number(wStored) : 0;
    const wk = await computeCurrentWeekTotal();

    const dPct = dHas && dGoal>0 ? Math.min(100,(todayUSD/dGoal)*100) : 0;
    const wPct = wHas && wGoal>0 ? Math.min(100,(wk/wGoal)*100) : 0;

    qs('#pt-d-fill').style.width = dHas && dGoal>0 ? `${dPct|0}%` : '0%';
    qs('#pt-w-fill').style.width = wHas && wGoal>0 ? `${wPct|0}%` : '0%';

    qs('#pt-d-label').textContent = dHas
      ? (dGoal>0 ? `$${todayUSD.toFixed(2)} / $${dGoal.toFixed(2)} (${(dPct|0)}%)` : `$${todayUSD.toFixed(2)} / $0.00`)
      : '—';

    qs('#pt-w-label').textContent = wHas
      ? (wGoal>0 ? `$${wk.toFixed(2)} / $${wGoal.toFixed(2)} (${(wPct|0)}%)` : `$${wk.toFixed(2)} / $0.00`)
      : '—';
  }

  async function computeCurrentWeekTotal(){
    const log=(await GM_getValue(STORAGE_KEY_LOG,[]))||[];
    const {weekDates} = getWeekDatesSunToSat(new Date(), CUR_TZ);
    let sum=0;
    for(const dt of weekDates){
      const y=ymd(dt,CUR_TZ);
      const row=log.find(e=>e.date===y);
      if(row && typeof row.totalUSD==='number') sum += row.totalUSD;
    }
    return sum;
  }

  // -------- history sparkline with hover tooltips
  async function renderHistorySparkline(){
    const svg=qs('#pt-spark'); if(!svg) return;
    const labelsBox=qs('#pt-spark-labels'); if(!labelsBox) return;

    const log=(await GM_getValue(STORAGE_KEY_LOG,[]))||[];
    const {weekDates, todayIdx, weekNames} = getWeekDatesSunToSat(new Date(), CUR_TZ);

    const totals=weekDates.map(dt=>{
      const y=ymd(dt,CUR_TZ);
      const row=log.find(e=>e.date===y);
      return row ? Number(row.totalUSD||0) : 0;
    });

    const max=Math.max(1,...totals);
    const pts=totals.map((v,idx)=>{ const x=(idx/6)*100; const y=36-(v/max)*32-2; return `${x.toFixed(2)},${y.toFixed(2)}`; }).join(' ');
    const todayX=((todayIdx)/6)*100;
    const todayY=36-(totals[todayIdx]/max)*32-2;

    // Draw line + points + today's marker
    const pointCircles = totals.map((v, i) => {
      const cx=((i)/6)*100;
      const cy=36-(v/max)*32-2;
      const ymdStr = ymd(weekDates[i], CUR_TZ);
      const lab = `${weekNames[i]} ${ymdStr}: $${v.toFixed(2)}`;
      return `<circle cx="${cx}" cy="${cy}" r="1.3" fill="currentColor" opacity="0.8"><title>${lab}</title></circle>`;
    }).join('');

    // Hit zones covering each day slice (so you can hover anywhere over that day's column)
    const hitRects = totals.map((v, i) => {
      const x = (i/7)*100;
      const w = (1/7)*100;
      const ymdStr = ymd(weekDates[i], CUR_TZ);
      const lab = `${weekNames[i]} ${ymdStr}: $${v.toFixed(2)}`;
      return `<rect x="${x}" y="0" width="${w}" height="36" fill="transparent"><title>${lab}</title></rect>`;
    }).join('');

    svg.innerHTML = `
      <g>
        <polyline points="${pts}" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.9"></polyline>
        ${pointCircles}
        <circle cx="${todayX}" cy="${todayY}" r="1.9" fill="currentColor" opacity="0.95"><title>${weekNames[todayIdx]} ${ymd(weekDates[todayIdx], CUR_TZ)}: $${totals[todayIdx].toFixed(2)}</title></circle>
      </g>
      <g>${hitRects}</g>
    `;

    // Labels: Sun..Sat, mark today
    labelsBox.innerHTML = '';
    weekNames.forEach((name, i)=>{
      const sp=document.createElement('div');
      sp.className='lab' + (i===todayIdx ? ' is-today' : '');
      sp.textContent=name;
      labelsBox.appendChild(sp);
    });
  }

  // Build week dates array starting on Sunday in CUR_TZ
  function getWeekDatesSunToSat(anchorDate, tz){
    const wnames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    const dow = getDowInTZ(anchorDate, tz); // 0..6 Sun..Sat
    const start = new Date(anchorDate.getTime() - dow*24*3600*1000);
    const weekDates=[];
    for(let i=0;i<7;i++){
      const d = new Date(start.getTime() + i*24*3600*1000);
      const y = ymd(d, tz);
      const parts = y.split('-').map(Number);
      const safe = new Date(Date.UTC(parts[0], parts[1]-1, parts[2], 12, 0, 0));
      weekDates.push(safe);
    }
    const todayIdx = getDowInTZ(anchorDate, tz);
    return {weekDates, todayIdx, weekNames: wnames};
  }

  function getDowInTZ(date, tz){
    const wd = new Intl.DateTimeFormat('en-US', {timeZone: tz, weekday:'short'}).format(date);
    const map = {Sun:0, Mon:1, Tue:2, Wed:3, Thu:4, Fri:5, Sat:6};
    return map[wd] ?? 0;
  }

  // -------- actions
  async function runAndSave(){
    setMsg('Summing…'); showSpinner(true); setProgress(8);
    const includeAll = qs('#pt-all') ? qs('#pt-all').checked : true;
    const result = includeAll ? await sumTodayAcrossPages() : sumTodayFromCurrentDoc();
    showSpinner(false); setProgress(100); setTimeout(()=>setProgress(0),500);
    if(!result){ toast('No rows found for today'); return; }
    const last={ date:result.date, totalUSD:round2(result.totalUSD), approvedCount:result.byStatus.APPROVED||0, awaitingCount:result.byStatus['AWAITING REVIEW']||0, countedRows:result.counted, pages:result.pages, savedAt:new Date().toISOString() };
    await GM_setValue(STORAGE_KEY_LAST,last);
    const log=(await GM_getValue(STORAGE_KEY_LOG,[]))||[]; const idx=log.findIndex(e=>e.date===last.date); if(idx>=0) log[idx]=last; else log.push(last);
    await GM_setValue(STORAGE_KEY_LOG,log);
    renderLast(last); await updateProgressBars(); renderHistorySparkline();
    toast(`Saved — $${last.totalUSD.toFixed(2)} (p${last.pages})`);
  }

  async function exportCSV(){
    const log=(await GM_getValue(STORAGE_KEY_LOG,[]))||[];
    if(!log.length){ toast('No data to export'); return; }
    const csv=toCSV(log);
    downloadBlob(`prolific-today-${new Date().toISOString().slice(0,10)}.csv`, csv, 'text/csv');
    toast('CSV exported');
  }

  async function clearSaved(){
    await GM_setValue(STORAGE_KEY_LAST,null);
    await GM_setValue(STORAGE_KEY_LOG,[]);
    renderLast(null); await updateProgressBars(); renderHistorySparkline();
    toast('Cleared');
  }

  // -------- scan
  function sumTodayFromCurrentDoc(){ return sumFromDoc(document,1); }
  function getRows(doc){ for(const sel of ROW_SELECTORS){ const list=[...doc.querySelectorAll(sel)]; const rows=list.filter(r=>!r.querySelector('[role="columnheader"]')); if(rows.length) return rows; } return []; }
  function sumFromDoc(doc,pagesCountSoFar){
    const rows=getRows(doc); if(!rows.length) return null;
    let totalUSD=0, counted=0; const byStatus={APPROVED:0,'AWAITING REVIEW':0};
    for(const row of rows){
      const when=readDate(row); if(!when||!isToday(when, CUR_TZ)) continue;
      const status=readStatus(row); if(!status) continue;
      const usd=readRewardUSD(row); if(!Number.isFinite(usd)) continue;
      totalUSD+=usd; counted++; byStatus[status]=(byStatus[status]||0)+1;
    }
    const date=ymd(new Date(),CUR_TZ);
    return {date,totalUSD,counted,byStatus,pages:pagesCountSoFar};
  }
  async function sumTodayAcrossPages(){
    let agg=sumFromDoc(document,1); let pages=1; let ok=!!agg;
    updatePages('1');
    const iframe=getOrCreateIframe();
    while(ok && pages<MAX_PAGES){
      const next=pages+1;
      const url=new URL(location.href); url.searchParams.set('page', String(next));
      setProgress(Math.min(90,(next-1)*(100/MAX_PAGES)));
      const doc=await loadDoc(iframe,url.toString()).catch(()=>null); if(!doc) break;
      await nudgeLayout(doc); const {ok:ready}=await waitRows(doc, PAGE_WAIT_MS); if(!ready) break;
      const part=sumFromDoc(doc,next);
      if(part && part.counted===0){ pages=next; updatePages(`${pages} (stopped)`); break; }
      if(part){
        agg.totalUSD+=part.totalUSD; agg.counted+=part.counted;
        agg.byStatus.APPROVED=(agg.byStatus.APPROVED||0)+(part.byStatus.APPROVED||0);
        agg.byStatus['AWAITING REVIEW']=(agg.byStatus['AWAITING REVIEW']||0)+(part.byStatus['AWAITING REVIEW']||0);
        pages=next; agg.pages=pages; updatePages(String(pages));
      } else break;
    }
    try{ iframe.remove(); }catch{}
    return agg;
  }
  function updatePages(txt){ const el=qs('#pt-pages'); if(el) el.textContent=`Pages: ${txt}`; }

  // -------- readers
  function readStatus(row){
    const statusCell=row.querySelector('.cell.study-status-cell')||row.querySelector('[data-testid*="submission-status"]')||row.querySelector('[role="status"]');
    const texts=[];
    if(statusCell){
      const pill=statusCell.querySelector('[aria-label], [title], *')||statusCell;
      const aria=pill.getAttribute && pill.getAttribute('aria-label');
      const title=pill.getAttribute && pill.getAttribute('title');
      if(aria) texts.push(aria);
      if(title) texts.push(title);
      const txt=(pill.textContent||statusCell.textContent||'').trim();
      if(txt) texts.push(txt);
    }
    if(!texts.length){
      for(const el of row.querySelectorAll('span,div,strong,b')){
        const t=(el.textContent||'').trim(); if(t) texts.push(t);
      }
    }
    for(const t of texts){ const cls=classifyStatus(t); if(cls) return cls; }
    return null;
  }
  function classifyStatus(text){
    const u=String(text||'').toUpperCase().replace(/\s+/g,' ').replace(/[^\w ]+/g,'').trim();
    if(!u) return null;
    if(/\bAPPROVED\b/.test(u)) return 'APPROVED';
    if(/\bAWAIT\w*\s+(REVIEW|APPROV\w*)\b/.test(u) || /\b(PENDING|UNDER|IN)\s+REVIEW\b/.test(u) || /\bSUBMITTED\b/.test(u)) return 'AWAITING REVIEW';
    return null;
  }
  function readDate(row){
    const timeEl=row.querySelector('time[datetime]');
    if(timeEl && timeEl.getAttribute('datetime')) return timeEl.getAttribute('datetime');
    const dateCell=row.querySelector('.cell.study-date-cell')||row.querySelector('[data-testid*="date"]')||row;
    const raw=(dateCell.textContent||'').trim().replace(/\u00a0/g,' ');
    const m=raw.match(/\b(\d{1,2}\s+[A-Za-z]{3}\s+\d{4})(?:,\s*(\d{1,2}:\d{2}))?/);
    if(m) return m[2]?`${m[1]}, ${m[2]}`:m[1];
    const cut=raw.split(/Approved|Read more|Payment|Status/i)[0].trim();
    if(cut) return cut;
    return null;
  }
  function readRewardUSD(row){
    const cell=row.querySelector('.cell.study-reward-cell')||row.querySelector('[data-testid*="reward"], [data-testid*="payment"]')||row;
    const text=(cell.textContent||'').replace(/\u00a0/g,' ').trim();
    const moneyRe=/([+-]?)\s*([£$€])\s*([0-9]+(?:[.,][0-9]{1,2})?)/g;
    let m,totalUSD=0,found=false;
    while((m=moneyRe.exec(text))!==null){
      found=true; const sign=m[1]==='-'?-1:1; const curr=m[2]; const amt=parseFloat(m[3].replace(',', '.'))*sign;
      totalUSD += toUSD(amt,curr);
    }
    return found ? totalUSD : NaN;
  }

  // -------- iframe helpers
  function getOrCreateIframe(){ let f=document.getElementById('__pt_iframe'); if(f&&f.tagName==='IFRAME') return f; f=document.createElement('iframe'); f.id='__pt_iframe'; f.src='about:blank'; Object.assign(f.style,{position:'fixed',left:'0',top:'0',width:'1280px',height:'1800px',opacity:'0',pointerEvents:'none',zIndex:0,border:'0'}); document.body.appendChild(f); return f; }
  function loadDoc(frame,url){ return new Promise((resolve)=>{ const done=()=>{ frame.removeEventListener('load',done); resolve(frame.contentDocument||frame.contentWindow?.document||null); }; frame.addEventListener('load',done,{once:true}); frame.src=url; setTimeout(done,9000); }); }
  async function nudgeLayout(doc){ await sleep(80); try{ const win=doc.defaultView||doc.parentWindow; win.focus(); win.dispatchEvent(new Event('resize')); await sleep(80); win.scrollTo(0,0); await sleep(80); win.scrollTo(0,1400); await sleep(80); win.scrollTo(0,0);}catch{} }
  async function waitRows(doc,timeoutMs){ const t0=Date.now(); while(Date.now()-t0<timeoutMs){ const rows=getRows(doc); if(rows.length>0) return {ok:true, rowsFound:rows.length}; await sleep(POLL_MS);} return {ok:false, rowsFound:0}; }

  // -------- drag / position (free drag)
  function makeDraggable(){
    const grip=panelEl.querySelector('.drag-handle'); if(!grip) return;
    let dragging=false,sx=0,sy=0,sl=0,st=0;
    grip.addEventListener('mousedown', onDown);
    grip.addEventListener('touchstart', (e)=>onDown(e.touches[0]), {passive:true});
    function onDown(e){ dragging=true; sx=e.clientX; sy=e.clientY; const r=panelEl.getBoundingClientRect(); sl=r.left; st=r.top; addEventListener('mousemove', onMove); addEventListener('mouseup', onUp, {once:true}); addEventListener('touchmove', onTouchMove, {passive:false}); addEventListener('touchend', onTouchEnd, {once:true}); }
    function onMove(e){ if(!dragging) return; e.preventDefault(); place(sl+(e.clientX-sx), st+(e.clientY-sy)); }
    function onTouchMove(e){ if(!dragging) return; const t=e.touches[0]; place(sl+(t.clientX-sx), st+(t.clientY-sy)); }
    async function onUp(){ dragging=false; removeEventListener('mousemove', onMove); removeEventListener('touchmove', onTouchMove); await savePosition(); }
    function onTouchEnd(){ onUp(); }
    function place(L,T){ panelEl.style.left=L+'px'; panelEl.style.top=T+'px'; panelEl.style.right='auto'; panelEl.style.bottom='auto'; }
  }
  async function savePosition(){ const r=panelEl.getBoundingClientRect(); await GM_setValue(STORAGE_KEY_POS,{left:r.left, top:r.top}); }
  async function restorePosition(){
    const p = await GM_GetValueSafe(STORAGE_KEY_POS, null);
    if(!p){ panelEl.style.right='16px'; panelEl.style.bottom='24px'; return; }
    panelEl.style.left=p.left+'px'; panelEl.style.top=p.top+'px'; panelEl.style.right='auto'; panelEl.style.bottom='auto';
  }
  async function GM_GetValueSafe(k, dflt){ try{ return await GM_getValue(k, dflt); }catch{ return dflt; } }
  async function GM_SetValueSafe(k, v){ try{ return await GM_setValue(k, v); }catch{ return; } }

  // -------- utils
  function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }
  function ymd(d,tz){
    const parts=new Intl.DateTimeFormat('en-CA',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(d).reduce((a,p)=>(a[p.type]=p.value,a),{});
    return `${parts.year}-${parts.month}-${parts.day}`;
  }
  function isToday(text,tz){
    const t=(text||'').trim();
    if(/^today\b/i.test(t)) return true;
    if(/^yesterday\b/i.test(t)) return false;
    const d=new Date(t||Date.now());
    if(isNaN(d.getTime())) return false;
    return ymd(d,tz)===ymd(new Date(),tz);
  }
  function toUSD(amount,currency){
    if(currency==='£') return amount*(Number(FX_RATE)||DEFAULT_GBP_USD);
    if(currency==='$'||currency==null) return amount;
    return amount;
  }
  function round2(n){ return Math.round(n*100)/100; }
  function renderLast(last){
    const tot=qs('#pt-total'), upd=qs('#pt-updated'), brk=qs('#pt-breakdown'), pg=qs('#pt-pages');
    if(!last){ if(tot) tot.textContent='$0.00'; if(upd) upd.textContent='—'; if(brk) brk.textContent='Approved 0 • Awaiting 0'; if(pg) pg.textContent='—'; return; }
    if(tot) tot.textContent=`$${Number(last.totalUSD||0).toFixed(2)}`;
    const when=new Date(last.savedAt||Date.now());
    if(upd) upd.textContent=`${last.date} • ${when.toLocaleTimeString()}`;
    if(brk) brk.textContent=`Approved ${last.approvedCount} • Awaiting ${last.awaitingCount}`;
    if(pg)  pg.textContent=`Pages: ${last.pages||1}`;
  }
  function toCSV(rows){
    const header=['date','totalUSD','approvedCount','awaitingCount','countedRows','pages','savedAt'];
    const esc=v=>`"${String(v ?? '').replace(/"/g,'""')}"`;
    const lines=[header.join(',')];
    for(const r of rows){
      lines.push([r.date, r.totalUSD?.toFixed?.(2) ?? r.totalUSD, r.approvedCount, r.awaitingCount, r.countedRows, r.pages, r.savedAt].map(esc).join(','));
    }
    return lines.join('\n');
  }
  function downloadBlob(filename,data,mime){ const blob=new Blob([data],{type:mime||'text/plain'}); const url=URL.createObjectURL(blob); const a=document.createElement('a'); a.href=url; a.download=filename; a.click(); URL.revokeObjectURL(url); }
})();
