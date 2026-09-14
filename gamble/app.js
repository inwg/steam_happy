/* ============================================================
   Case Simulator - application logic
   Native JS, no build step. Reads window.CASE_DATA from data.js.
   Multi-case opening (1/3/5), analytic reel timing, Web Audio SFX.
   ============================================================ */
(function(){
  'use strict';

  /* ---------- rarity + odds model ---------- */
  const RARITIES = {
    'Mil-Spec':      { key:'milspec',     color:'var(--r-milspec)',     hex:'#4b69ff', tier:1, srcKey:'Mil-Spec Skins' },
    'Restricted':    { key:'restricted',  color:'var(--r-restricted)',  hex:'#8847ff', tier:2, srcKey:'Restricted Skins' },
    'Classified':    { key:'classified',  color:'var(--r-classified)',  hex:'#d32ce6', tier:3, srcKey:'Classified Skins' },
    'Covert':        { key:'covert',      color:'var(--r-covert)',      hex:'#eb4b4b', tier:4, srcKey:'Covert Skins' },
    'Rare Special':  { key:'rare',        color:'var(--r-rare)',        hex:'#ffd700', tier:5, srcKey:'Rare Special Items' }
  };

  // Authentic drop odds
  const ODDS = [
    { rar:'Mil-Spec',     p:0.7992 },
    { rar:'Restricted',   p:0.1598 },
    { rar:'Classified',   p:0.0320 },
    { rar:'Covert',       p:0.0064 },
    { rar:'Rare Special', p:0.0026 }
  ];

  const STATTRAK_CHANCE = 0.10;

  const WEAR_ORDER   = ['Factory New','Minimal Wear','Field-Tested','Well-Worn','Battle-Scarred'];
  const WEAR_WEIGHTS = { 'Factory New':10, 'Minimal Wear':20, 'Field-Tested':40, 'Well-Worn':18, 'Battle-Scarred':12 };
  const WEAR_MULT    = { 'Factory New':1.6, 'Minimal Wear':1.28, 'Field-Tested':1.0, 'Well-Worn':0.82, 'Battle-Scarred':0.66, 'Vanilla':1.45 };
  const WEAR_SHORT   = { 'Factory New':'FN', 'Minimal Wear':'MW', 'Field-Tested':'FT', 'Well-Worn':'WW', 'Battle-Scarred':'BS', 'Vanilla':'Vanilla' };

  // simulated price bands per rarity [min,max], log-uniform
  const PRICE_BANDS = {
    'Mil-Spec':      [1, 18],
    'Restricted':    [4, 55],
    'Classified':    [15, 165],
    'Covert':        [50, 720],
    'Rare Special':  [130, 2800]
  };

  const KEY_COST = 2.50;
  const TOPUP    = 500;
  const START_WALLET = 500;

  const NEXT_TIER = { 'Mil-Spec':'Restricted', 'Restricted':'Classified', 'Classified':'Covert' };
  const CONTRACT_RARITIES = ['Mil-Spec','Restricted','Classified'];

  const WIN_INDEX = 50;
  const REEL_LEN  = 56;

  /* Spin feel: a per-row stagger so a batch lands one row after another
     instead of all at once. Base duration is user-selectable (Fast/Normal/Slow). */
  const SPIN_SPEEDS  = { fast:4.5, normal:9.5, slow:14.5 }; // seconds, first row
  let   spinSpeed    = 'normal';
  const SPIN_STAGGER = 0.55;  // extra seconds per additional row
  const SPIN_EASE    = [0.08, 0.75, 0.14, 1]; // must match the CSS cubic-bezier
  function spinDuration(){ return SPIN_SPEEDS[spinSpeed] || SPIN_SPEEDS.normal; }

  /* ---------- state ---------- */
  let CASES = [];
  let selectedCaseId = 0;
  let inventory = [];
  let history = [];
  let wallet = START_WALLET;
  let opens = 0;
  let muted = false;
  let spinning = false;
  let currentReveal = [];      // items currently shown in the reveal overlay
  let lastFocus = null;        // element to restore when reveal closes

  let contractPick = [];       // array of inventory item ids
  let contractRarity = null;   // rarity of current selection / filter

  /* ---------- storage ---------- */
  const K = { inv:'cs.inv', hist:'cs.hist', wallet:'cs.wallet', opens:'cs.opens', muted:'cs.muted', speed:'cs.speed' };
  function load(){
    try{ inventory = JSON.parse(localStorage.getItem(K.inv)) || []; }catch(e){ inventory=[]; }
    try{ history   = JSON.parse(localStorage.getItem(K.hist)) || []; }catch(e){ history=[]; }
    const w = parseFloat(localStorage.getItem(K.wallet)); wallet = isNaN(w) ? START_WALLET : w;
    const o = parseInt(localStorage.getItem(K.opens),10); opens = isNaN(o) ? 0 : o;
    muted = localStorage.getItem(K.muted) === '1';
    const sp = localStorage.getItem(K.speed);
    if(sp && SPIN_SPEEDS[sp]) spinSpeed = sp;
  }
  const save = {
    inv(){ try{ localStorage.setItem(K.inv, JSON.stringify(inventory)); }catch(e){} },
    hist(){ try{ localStorage.setItem(K.hist, JSON.stringify(history)); }catch(e){} },
    wallet(){ try{ localStorage.setItem(K.wallet, String(wallet)); }catch(e){} },
    opens(){ try{ localStorage.setItem(K.opens, String(opens)); }catch(e){} },
    muted(){ try{ localStorage.setItem(K.muted, muted?'1':'0'); }catch(e){} },
    speed(){ try{ localStorage.setItem(K.speed, spinSpeed); }catch(e){} }
  };

  /* ---------- utils ---------- */
  const $ = (id)=>document.getElementById(id);
  function esc(s){ return String(s).replace(/[&<>"']/g, c=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }
  function randInt(n){ return Math.floor(Math.random()*n); }
  function uid(){ return Date.now().toString(36) + Math.random().toString(36).slice(2,7); }
  function money(n){ return '$' + Number(n).toLocaleString('en-US',{ minimumFractionDigits:2, maximumFractionDigits:2 }); }
  function hashStr(s){ let h=2166136261>>>0; for(let i=0;i<s.length;i++){ h^=s.charCodeAt(i); h=Math.imul(h,16777619); } return h>>>0; }
  function seededUnit(s){ return (hashStr(s)%100000)/100000; }
  function weightedPick(items, weights){
    const total = weights.reduce((a,b)=>a+b,0);
    let r = Math.random()*total;
    for(let i=0;i<items.length;i++){ r-=weights[i]; if(r<0) return items[i]; }
    return items[items.length-1];
  }

  /* Cubic bezier solver. Mirrors the CSS transition timing function so the
     tick loop can compute reel positions analytically with zero layout reads. */
  function cubicBezier(x1, y1, x2, y2){
    const cx = 3*x1, bx = 3*(x2-x1)-cx, ax = 1-cx-bx;
    const cy = 3*y1, by = 3*(y2-y1)-cy, ay = 1-cy-by;
    const sampleX = t => ((ax*t+bx)*t+cx)*t;
    const sampleY = t => ((ay*t+by)*t+cy)*t;
    const sampleD = t => (3*ax*t+2*bx)*t+cx;
    return function(x){
      let t = x;
      for(let i=0;i<8;i++){
        const d = sampleD(t);
        if(Math.abs(d) < 1e-6) break;
        t -= (sampleX(t)-x)/d;
      }
      if(t<0 || t>1 || Math.abs(sampleX(t)-x) > 1e-4){
        let lo=0, hi=1; t=x;
        for(let i=0;i<24;i++){
          const cur = sampleX(t);
          if(Math.abs(cur-x) < 1e-5) break;
          if(cur<x) lo=t; else hi=t;
          t=(lo+hi)/2;
        }
      }
      return sampleY(t<0?0:(t>1?1:t));
    };
  }

  /* ---------- normalisation ---------- */
  function parseName(fullName){
    const parts = String(fullName).split('|').map(s=>s.trim());
    let weapon = parts[0] || fullName;
    let skin = parts.slice(1).join(' | ');
    if(/\(vanilla\)/i.test(skin)) skin = 'Vanilla';
    if(!skin) skin = weapon;
    return { weapon, skin };
  }
  function normalize(raw){
    return raw.map((c, ci)=>{
      const buckets = {};
      for(const rar in RARITIES){
        const arr = (c.content && c.content[RARITIES[rar].srcKey]) || [];
        buckets[rar] = arr.map(it=>{
          const nm = parseName(it.name);
          return {
            weapon:nm.weapon, skin:nm.skin, fullName:it.name,
            wears: it.wears || {}, canStat: !!it.can_be_stattrak,
            rarity:rar, rarityKey:RARITIES[rar].key, color:RARITIES[rar].color, hex:RARITIES[rar].hex
          };
        });
      }
      return { id:ci, name:c.name, img:c.image_url, buckets };
    });
  }

  /* ---------- rolling ---------- */
  function rollRarity(){
    const r = Math.random(); let acc=0;
    for(const o of ODDS){ acc+=o.p; if(r<acc) return o.rar; }
    return 'Mil-Spec';
  }
  function rollRaw(caseId, forceRarity){
    const c = CASES[caseId];
    let rarity = forceRarity || rollRarity();
    let bucket = c.buckets[rarity];
    if(!bucket || !bucket.length){
      const order = ['Rare Special','Covert','Classified','Restricted','Mil-Spec'];
      const start = order.indexOf(rarity);
      for(let i=Math.max(0,start); i<order.length; i++){
        if(c.buckets[order[i]] && c.buckets[order[i]].length){ bucket=c.buckets[order[i]]; break; }
      }
      if(!bucket || !bucket.length){ for(const r of order){ if(c.buckets[r] && c.buckets[r].length){ bucket=c.buckets[r]; break; } } }
    }
    return bucket[randInt(bucket.length)];
  }
  function pickWear(raw){
    const keys = Object.keys(raw.wears || {});
    if(!keys.length) return { wear:'Vanilla', img:'' };
    if(keys.length===1 && /vanilla/i.test(keys[0])) return { wear:'Vanilla', img:raw.wears[keys[0]] };
    const present = WEAR_ORDER.filter(w=>raw.wears[w]);
    if(!present.length){ const k=keys[0]; return { wear:k, img:raw.wears[k] }; }
    const w = weightedPick(present, present.map(x=>WEAR_WEIGHTS[x]||1));
    return { wear:w, img:raw.wears[w] };
  }
  function priceFor(p){
    const band = PRICE_BANDS[p.rarity] || [1,10];
    const u = seededUnit(p.weapon + '|' + p.skin);
    const base = band[0] * Math.pow(band[1]/band[0], u);
    const mult = (WEAR_MULT[p.wear]||1) * (p.stattrak?1.4:1);
    return Math.round(base*mult*100)/100;
  }
  function makePull(raw, caseId){
    const w = pickWear(raw);
    const pull = {
      id:uid(), caseId, caseName:CASES[caseId].name,
      weapon:raw.weapon, skin:raw.skin, name:raw.fullName,
      rarity:raw.rarity, rarityKey:raw.rarityKey, color:raw.color, hex:raw.hex,
      wear:w.wear, img:w.img,
      stattrak: !!raw.canStat && Math.random() < STATTRAK_CHANCE,
      ts: Date.now()
    };
    pull.price = priceFor(pull);
    return pull;
  }

  /* ---------- audio (Web Audio API) ---------- */
  let actx = null;
  function ensureAudio(){
    if(!actx){ try{ actx = new (window.AudioContext||window.webkitAudioContext)(); }catch(e){ actx=null; } }
    if(actx && actx.state==='suspended') actx.resume();
    if(actx) loadRealSounds(); // stream the real game sounds once audio unlocks
    return actx;
  }
  // attack/decay envelope shared by every voice
  function env(g, t, peak, dur, atk){
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t+atk);
    g.gain.exponentialRampToValueAtTime(0.0001, t+dur);
  }
  // single oscillator with optional pitch sweep and filter
  function tone(freq, dur, o){
    o = o || {};
    const a = ensureAudio(); if(!a || muted) return;
    const t = a.currentTime + (o.at||0);
    const osc = a.createOscillator(), g = a.createGain();
    osc.type = o.type || 'sine';
    osc.frequency.setValueAtTime(freq, t);
    if(o.to) osc.frequency.exponentialRampToValueAtTime(o.to, t+dur);
    env(g, t, o.gain || 0.08, dur, o.atk || 0.008);
    let node = osc;
    if(o.filter){
      const f = a.createBiquadFilter();
      f.type = o.filter; f.frequency.value = o.cut || 1200;
      node.connect(f); node = f;
    }
    node.connect(g).connect(a.destination);
    osc.start(t); osc.stop(t+dur+0.05);
  }
  // band-passed white noise burst with a frequency sweep (whooshes, cash)
  function noise(dur, f0, f1, peak, at){
    const a = ensureAudio(); if(!a || muted) return;
    const t = a.currentTime + (at||0);
    const len = Math.max(1, Math.floor(a.sampleRate*dur));
    const buf = a.createBuffer(1, len, a.sampleRate);
    const d = buf.getChannelData(0);
    for(let i=0;i<len;i++) d[i] = Math.random()*2-1;
    const src = a.createBufferSource(); src.buffer = buf;
    const f = a.createBiquadFilter(); f.type='bandpass'; f.Q.value=1.1;
    f.frequency.setValueAtTime(f0, t);
    f.frequency.exponentialRampToValueAtTime(f1, t+dur);
    const g = a.createGain(); env(g, t, peak, dur, dur*0.3);
    src.connect(f).connect(g).connect(a.destination);
    src.start(t); src.stop(t+dur+0.05);
  }
  function playChord(notes, dur, type){
    const a = ensureAudio(); if(!a || muted) return;
    const t0 = a.currentTime;
    notes.forEach((f, i)=>{
      const t = t0 + i*0.06;
      const o = a.createOscillator(), g = a.createGain();
      o.type = type || 'triangle'; o.frequency.setValueAtTime(f, t);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.16, t+0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t+dur);
      o.connect(g).connect(a.destination); o.start(t); o.stop(t+dur+0.05);
    });
  }
  function shimmer(){
    const a = ensureAudio(); if(!a || muted) return;
    const t = a.currentTime;
    const o = a.createOscillator(), g = a.createGain();
    o.type='sine'; o.frequency.setValueAtTime(1760, t);
    o.frequency.exponentialRampToValueAtTime(2637, t+0.5);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.09, t+0.05);
    g.gain.exponentialRampToValueAtTime(0.0001, t+0.9);
    o.connect(g).connect(a.destination); o.start(t); o.stop(t+1);
  }

  /* Real CS:GO UI sounds: the actual wav files extracted from the game,
     streamed from a CDN mirror (sourcesounds/csgo). Every synth voice below
     stays as a fallback until its real buffer has arrived. */
  const CDN_BASE = 'https://cdn.jsdelivr.net/gh/sourcesounds/csgo@master/sound/ui/';
  const REAL_SRC = {
    tick:     'csgo_ui_crate_item_scroll.wav', // the reel tick
    open:     'csgo_ui_crate_open.wav',        // case cracked open
    drop1:    'item_drop1_common.wav',         // Mil-Spec ding
    drop2:    'item_drop2_uncommon.wav',       // Restricted ding
    drop3:    'item_drop3_rare.wav',           // Classified ding
    drop4:    'item_drop4_mythical.wav',       // Covert ding
    drop6:    'item_drop6_ancient.wav',        // knife / gold ding
    knife:    'item_showcase_knife_01.wav',    // knife showcase layer
    click:    'buttonclick.wav',
    hover:    'buttonrollover.wav',
    back:     'menu_back.wav',
    cantbuy:  'weapon_cant_buy.wav',           // the "not enough funds" buzz
    seal:     'csgo_ui_contract_seal.wav',     // trade-up seal
    purchase: 'store_item_purchased.wav'       // money chime
  };
  const DROP_BY_TIER = { 1:'drop1', 2:'drop2', 3:'drop3', 4:'drop4', 5:'drop6' };
  const realBufs = {};
  let realLoadStarted = false;
  function fetchReal(name){
    fetch(CDN_BASE + REAL_SRC[name])
      .then(r=>{ if(!r.ok) throw new Error(r.status); return r.arrayBuffer(); })
      .then(b=> new Promise(res=>{ actx.decodeAudioData(b, res, ()=>res(null)); }))
      .then(buf=>{ if(buf) realBufs[name] = buf; })
      .catch(()=>{ /* synth fallback keeps working */ });
  }
  function loadRealSounds(){
    if(realLoadStarted || !actx || !window.fetch) return;
    realLoadStarted = true;
    // phase 1: everything the very first spin needs
    ['tick','open','drop1','drop2','click','hover','cantbuy'].forEach(fetchReal);
    // phase 2: the heavy hero sounds follow shortly after
    setTimeout(()=>{
      ['drop3','drop4','drop6','knife','seal','purchase','back'].forEach(fetchReal);
    }, 1500);
  }
  function realReady(){ return !!realBufs.tick; }
  function playReal(name, vol, rate){
    if(muted) return true; // handled: nothing should play
    const a = ensureAudio(); if(!a) return false;
    const buf = realBufs[name]; if(!buf) return false;
    const src = a.createBufferSource();
    src.buffer = buf;
    if(rate) src.playbackRate.value = rate;
    const g = a.createGain();
    g.gain.value = vol;
    src.connect(g).connect(a.destination);
    try{ src.start(); }catch(e){ return false; }
    return true;
  }

  /* Sound effects palette */
  const SFX = {
    tick(){
      if(playReal('tick', 0.3, 0.94 + Math.random()*0.12)) return;
      tone(880 + Math.random()*260, 0.045, { type:'square', gain:0.05 });
    },
    whoosh(){
      if(playReal('open', 0.75)) return;
      noise(0.55, 2200, 240, 0.16);
    },
    land(tier){
      if(playReal(DROP_BY_TIER[tier] || 'drop1', 0.8)) return;
      tone(150, 0.16, { to:58, gain:0.15 + tier*0.03, filter:'lowpass', cut:900 });
      tone(1200, 0.03, { type:'square', gain:0.03 });
    },
    tension(){ if(realReady()) return; tone(196, 1.15, { to:784, gain:0.045, atk:0.7 }); },
    pop(i){ if(realReady()) return; tone(500 + (i||0)*40, 0.07, { type:'triangle', gain:0.05 }); },
    sell(){
      if(playReal('purchase', 0.6)) return;
      tone(1318, 0.09, { type:'triangle', gain:0.1 });
      tone(1760, 0.18, { type:'triangle', gain:0.1, at:0.09 });
      noise(0.12, 5200, 3400, 0.05, 0.02);
    },
    topup(){
      if(playReal('purchase', 0.55)) return;
      tone(988, 0.08, { type:'triangle', gain:0.09 });
      tone(1319, 0.16, { type:'triangle', gain:0.09, at:0.08 });
    },
    tab(){
      if(playReal('back', 0.45)) return;
      tone(440, 0.035, { type:'square', gain:0.03 });
    },
    select(){
      if(playReal('click', 0.5)) return;
      tone(523, 0.07, { type:'triangle', gain:0.06 });
    },
    blip(){
      if(playReal('hover', 0.4)) return;
      tone(660, 0.05, { type:'triangle', gain:0.05 });
    },
    error(){
      if(playReal('cantbuy', 0.7)) return;
      tone(110, 0.16, { type:'sawtooth', gain:0.06, filter:'lowpass', cut:400 });
    },
    contract(){
      if(playReal('seal', 0.8)) return;
      tone(220, 0.05, { type:'square', gain:0.05 });
      tone(165, 0.05, { type:'square', gain:0.05, at:0.09 });
      tone(110, 0.1,  { type:'square', gain:0.06, at:0.18 });
    },
    reveal(rarity, opts){
      const tier = RARITIES[rarity] ? RARITIES[rarity].tier : 1;
      if(realReady()){
        // rows already played their own rarity ding during finishSpin
        if(!opts || !opts.noReal) playReal(DROP_BY_TIER[tier] || 'drop1', 0.8);
        if(tier >= 5) playReal('knife', 0.5); // gold pull: knife showcase layer
        return;
      }
      const map = {
        'Mil-Spec':     { n:[392,523],          d:0.5, t:'triangle' },
        'Restricted':   { n:[440,587,740],      d:0.6, t:'triangle' },
        'Classified':   { n:[523,659,784],      d:0.7, t:'triangle' },
        'Covert':       { n:[523,659,784,1047], d:0.85,t:'sawtooth' },
        'Rare Special': { n:[659,784,988,1319], d:1.0, t:'sawtooth', s:true }
      };
      const m = map[rarity] || map['Mil-Spec'];
      playChord(m.n, m.d, m.t);
      if(m.s) shimmer();
    }
  };

  /* ---------- rendering: case grid + opener ---------- */
  function renderCaseGrid(){
    const grid = $('caseGrid');
    grid.innerHTML = CASES.map(c=>(
      '<button class="case-card' + (c.id===selectedCaseId?' is-selected':'') + '" data-case="' + c.id + '" type="button">' +
        '<img src="' + c.img + '" alt="' + esc(c.name) + '" loading="lazy" width="172" height="96">' +
        '<div class="case-name">' + esc(c.name) + '</div>' +
      '</button>'
    )).join('');
    $('caseCount').textContent = CASES.length + ' cases';
  }
  function renderOddsStrip(){
    $('oddsStrip').innerHTML = ODDS.map(o=>{
      const pct = (o.p*100).toFixed(2);
      return '<span class="odds-dot" style="--c:' + RARITIES[o.rar].color + '" title="' + esc(o.rar) + ' ' + pct + '%"></span>';
    }).join('');
  }
  function selectCase(id, silent){
    if(spinning) return;
    selectedCaseId = id;
    const c = CASES[id];
    $('openerThumb').src = c.img;
    $('openerThumb').alt = c.name;
    $('openerTitle').textContent = c.name;
    document.querySelectorAll('.case-card').forEach(el=>{
      el.classList.toggle('is-selected', Number(el.dataset.case)===id);
    });
    renderIdleReel();
    updateWallet();
    if(!silent) SFX.select();
  }

  /* ---------- reel ---------- */
  function buildReelTiles(caseId, winner){
    const cells = [];
    for(let i=0;i<REEL_LEN;i++){
      if(winner && i===WIN_INDEX){ cells.push({ img:winner.img, color:winner.color }); continue; }
      const raw = rollRaw(caseId);
      const w = pickWear(raw);
      cells.push({ img:w.img, color:raw.color });
    }
    return cells.map(c=>(
      '<div class="reel-item" style="--rc:' + c.color + '"><img src="' + c.img + '" alt=""></div>'
    )).join('');
  }
  // one quiet preview row so the panel is never empty before the first spin
  function renderIdleReel(){
    if(spinning) return;
    const host = $('reelRows');
    host.className = 'reel-rows n1 is-idle';
    host.innerHTML =
      '<div class="reel-row">' +
        '<div class="reel-track" style="transform:translateX(-42%)">' + buildReelTiles(selectedCaseId, null) + '</div>' +
        '<div class="reel-marker" aria-hidden="true"></div>' +
        '<div class="reel-fade reel-fade-l"></div>' +
        '<div class="reel-fade reel-fade-r"></div>' +
      '</div>';
    $('reelHint').hidden = false;
  }

  function getBatch(){
    const el = document.querySelector('input[name="batch"]:checked');
    return el ? Number(el.value) : 1;
  }

  /* Tick loop driven by the analytic easing curve: no getComputedStyle,
     no layout reads per frame, works for every row simultaneously. */
  function startTicks(rows, totalMs){
    const ease = cubicBezier(SPIN_EASE[0], SPIN_EASE[1], SPIN_EASE[2], SPIN_EASE[3]);
    const t0 = performance.now();
    let lastTickAt = -999;
    let tensionPlayed = false;
    function frame(now){
      if(!spinning) return;
      const el = now - t0;
      let crossed = false;
      for(const r of rows){
        const p = Math.min(1, el / r.dur);
        const tx = ease(p) * r.target;
        const idx = Math.floor((r.vpCenter - tx) / r.step);
        if(idx !== r.lastIdx){ r.lastIdx = idx; crossed = true; }
      }
      if(crossed && now - lastTickAt > 42){ lastTickAt = now; SFX.tick(); }
      if(!tensionPlayed && totalMs - el < 1300 && totalMs - el > 0){ tensionPlayed = true; SFX.tension(); }
      if(el < totalMs + 250) requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }

  function spin(){
    if(spinning) return;
    const batch = getBatch();
    const cost = KEY_COST * batch;
    if(wallet < cost){
      walletShake(); SFX.error();
      toast('Not enough funds. Tap the wallet to top up.','bad');
      return;
    }
    charge(cost);
    ensureAudio();
    SFX.whoosh();

    spinning = true;
    $('opener').classList.add('is-spinning');
    $('btnOpen').disabled = true;
    $('reelHint').hidden = true;

    const caseId = selectedCaseId;
    const winners = [];
    for(let i=0;i<batch;i++) winners.push(makePull(rollRaw(caseId), caseId));

    // build N rows
    const host = $('reelRows');
    host.className = 'reel-rows n' + batch;
    host.innerHTML = winners.map(w=>(
      '<div class="reel-row">' +
        '<div class="reel-track">' + buildReelTiles(caseId, w) + '</div>' +
        '<div class="reel-marker" aria-hidden="true"></div>' +
        '<div class="reel-fade reel-fade-l"></div>' +
        '<div class="reel-fade reel-fade-r"></div>' +
      '</div>'
    )).join('');

    const rows = [];
    const rowEls = host.querySelectorAll('.reel-row');
    rowEls.forEach((row, i)=>{
      const track = row.querySelector('.reel-track');
      track.style.transition = 'none';
      track.style.transform = 'translateX(0)';
    });
    void host.offsetWidth; // single reflow before measuring

    rowEls.forEach((row, i)=>{
      const track = row.querySelector('.reel-track');
      const winEl = track.children[WIN_INDEX];
      const vpCenter = row.clientWidth / 2;
      const itemW = winEl.offsetWidth;
      const jitter = (Math.random()*2 - 1) * (itemW*0.34);
      const target = vpCenter - (winEl.offsetLeft + itemW/2) - jitter;
      rows.push({ track, winEl, item:winners[i], target, step:itemW + 8, vpCenter, lastIdx:-1 });
    });

    const baseDur = spinDuration();

    const totalMs = (baseDur + SPIN_STAGGER*(batch-1)) * 1000;
    rows.forEach((r, i)=>{
      r.dur = (baseDur + SPIN_STAGGER*i) * 1000;
    });

    // Double rAF: guarantees the reset transform (translateX(0)) has been
    // PAINTED before the transition is declared. Without this frame boundary
    // the browser can coalesce the reset and the target into one style
    // recalc on freshly-inserted nodes, and the reel jumps instantly.
    requestAnimationFrame(()=>{ requestAnimationFrame(()=>{
      if(!spinning) return;
      rows.forEach((r)=>{
        r.track.style.transition = 'transform ' + (r.dur/1000) + 's cubic-bezier(' + SPIN_EASE.join(',') + ')';
        r.track.style.transform = 'translateX(' + r.target + 'px)';
      });
      startTicks(rows, totalMs);

      // finish when the LAST row settles
      const last = rows[rows.length-1];
      const done = (e)=>{
        if(e.propertyName !== 'transform') return;
        last.track.removeEventListener('transitionend', done);
        finishSpin(rows);
      };
      last.track.addEventListener('transitionend', done);
      // safety fallback
      setTimeout(()=>{ if(spinning) finishSpin(rows); }, totalMs + 900);
    }); });
  }

  function finishSpin(rows){
    if(!spinning) return;
    spinning = false;
    let landed = 0;
    rows.forEach((r, i)=>{
      r.track.style.transition = 'none';
      r.track.style.transform = 'translateX(' + r.target + 'px)';
      if(r.winEl) r.winEl.classList.add('is-winner');
      // stagger the landing thuds to match the row order
      const tier = RARITIES[r.item.rarity] ? RARITIES[r.item.rarity].tier : 1;
      setTimeout(()=>{ SFX.land(tier); SFX.pop(i); }, i*220);
      landed++;
    });
    $('opener').classList.remove('is-spinning');

    rows.forEach(r=>{
      addToInventory(r.item);
      addToHistory(r.item);
    });
    opens += landed; save.opens();
    updateTabCounts();

    // best rarity of the batch drives the reveal fanfare
    let best = rows[0].item;
    for(const r of rows){ if(RARITIES[r.item.rarity].tier > RARITIES[best.rarity].tier) best = r.item; }
    SFX.reveal(best.rarity, { noReal:true });
    showReveal(rows.map(r=>r.item), { again:true });
    updateWallet();
  }

  /* ---------- reveal overlay ---------- */
  function showReveal(items, opts){
    opts = opts || {};
    currentReveal = items;
    lastFocus = document.activeElement;

    const n = items.length;
    $('revealTitle').textContent = 'You unboxed ' + n + (n===1 ? ' item' : ' items');

    const grid = $('revealGrid');
    grid.className = 'reveal-grid n' + n;
    grid.innerHTML = items.map((it, i)=>(
      '<div class="rv-item" style="--rc:' + it.color + ';--i:' + i + '">' +
        '<span class="rv-rarity">' + esc(it.rarity) + '</span>' +
        '<img class="rv-img" src="' + it.img + '" alt="' + esc(it.name) + '" width="200" height="64">' +
        '<div class="rv-weapon">' + esc(it.weapon) + '</div>' +
        '<div class="rv-skin">' + esc(it.skin) + '</div>' +
        '<div class="rv-tags">' +
          '<span class="tag">' + esc(it.wear) + '</span>' +
          (it.stattrak ? '<span class="tag tag-st">StatTrak\u2122</span>' : '') +
        '</div>' +
        '<div class="rv-price">' + money(it.price) + '</div>' +
      '</div>'
    )).join('');

    const sum = $('revealSummary');
    if(n > 1){
      const total = items.reduce((s,i)=>s+i.price, 0);
      sum.hidden = false;
      sum.innerHTML =
        '<span>Best pull <b style="color:' + (bestItem(items).hex) + '">' + esc(bestItem(items).skin) + '</b></span>' +
        '<span class="sum-total">' + money(total) + '</span>';
    } else {
      sum.hidden = true;
      sum.innerHTML = '';
    }

    const total = items.reduce((s,i)=>s+i.price, 0);
    $('btnSellAll').textContent = (n>1 ? 'Sell all for ' : 'Sell for ') + money(total);
    $('btnAgain').hidden = !opts.again;

    $('reveal').hidden = false;
    $('btnKeep').focus();
  }
  function bestItem(items){
    let best = items[0];
    for(const it of items){
      if(RARITIES[it.rarity].tier > RARITIES[best.rarity].tier ||
         (RARITIES[it.rarity].tier === RARITIES[best.rarity].tier && it.price > best.price)) best = it;
    }
    return best;
  }
  function closeReveal(){
    $('reveal').hidden = true;
    currentReveal = [];
    if(lastFocus && lastFocus.focus) lastFocus.focus();
    lastFocus = null;
  }

  /* ---------- economy ---------- */
  function charge(n){ wallet = Math.round((wallet-n)*100)/100; save.wallet(); updateWallet(); }
  function topUp(){
    wallet = Math.round((wallet+TOPUP)*100)/100; save.wallet(); updateWallet();
    SFX.topup();
    toast('Added ' + money(TOPUP) + ' to your wallet','good');
  }
  function updateWallet(){
    const batch = getBatch();
    const cost = KEY_COST * batch;
    $('walletAmount').textContent = money(wallet);
    $('btnOpen').disabled = spinning || wallet < cost;
    $('btnOpenCost').textContent = money(cost);
    const label = $('btnOpen').querySelector('.btn-open-label');
    if(label) label.textContent = batch > 1 ? 'Open ' + batch + ' Cases' : 'Open Case';
    const sub = $('openerSub');
    if(sub) sub.textContent = batch > 1 ? batch + 'x ' + CASES[selectedCaseId].name : 'Selected case';
  }
  function walletShake(){ const w=$('wallet'); w.classList.remove('shake'); void w.offsetWidth; w.classList.add('shake'); }

  function sellItem(id){
    const i = inventory.findIndex(x=>x.id===id);
    if(i<0) return;
    const it = inventory[i];
    wallet = Math.round((wallet+it.price)*100)/100; save.wallet(); updateWallet();
    inventory.splice(i,1); save.inv();
    contractPick = contractPick.filter(x=>x!==id);
    updateTabCounts(); renderInventory(); renderContracts();
    SFX.sell();
    toast('Sold ' + it.skin + ' for ' + money(it.price),'good');
  }
  function sellReveal(){
    const items = currentReveal.slice();
    if(!items.length) return;
    const total = items.reduce((s,i)=>s+i.price, 0);
    const ids = items.map(i=>i.id);
    inventory = inventory.filter(it=>ids.indexOf(it.id)<0);
    contractPick = contractPick.filter(id=>ids.indexOf(id)<0);
    wallet = Math.round((wallet+total)*100)/100; save.wallet(); save.inv();
    closeReveal();
    updateWallet(); updateTabCounts(); renderInventory(); renderContracts();
    SFX.sell();
    toast('Sold ' + items.length + (items.length===1?' item':' items') + ' for ' + money(total),'good');
  }

  /* ---------- inventory + history ---------- */
  function addToInventory(item){ inventory.push(item); save.inv(); }
  function addToHistory(item){
    history.unshift({ weapon:item.weapon, skin:item.skin, wear:item.wear, rarity:item.rarity,
      color:item.color, hex:item.hex, img:item.img, price:item.price, caseName:item.caseName, stattrak:item.stattrak, ts:item.ts });
    if(history.length>60) history.length = 60;
    save.hist();
  }
  function updateTabCounts(){ $('tabInvCount').textContent = inventory.length; }

  function invSorted(){
    const mode = $('invSort').value;
    const arr = inventory.slice();
    if(mode==='price') arr.sort((a,b)=>b.price-a.price);
    else if(mode==='rarity') arr.sort((a,b)=> (RARITIES[b.rarity].tier-RARITIES[a.rarity].tier) || (b.price-a.price));
    else arr.sort((a,b)=>b.ts-a.ts);
    return arr;
  }
  function renderInventory(){
    const grid = $('invGrid'), empty = $('invEmpty');
    updateTabCounts();
    if(!inventory.length){ grid.innerHTML=''; empty.classList.add('show'); }
    else empty.classList.remove('show');

    grid.innerHTML = invSorted().map(it=>(
      '<div class="item-card" style="--rc:' + it.color + '">' +
        '<div class="item-badges">' + (it.stattrak?'<span class="badge-st">ST\u2122</span>':'') + '</div>' +
        '<img class="item-img" src="' + it.img + '" alt="' + esc(it.name) + '" loading="lazy">' +
        '<div class="item-weapon">' + esc(it.weapon) + '</div>' +
        '<div class="item-skin">' + esc(it.skin) + '</div>' +
        '<div class="item-foot"><span class="item-price">' + money(it.price) + '</span>' +
          '<span class="item-wear">' + esc(WEAR_SHORT[it.wear]||it.wear) + '</span></div>' +
        '<button class="item-sell" data-sell="' + it.id + '" type="button">Sell</button>' +
      '</div>'
    )).join('');

    // stats
    const total = inventory.reduce((s,i)=>s+i.price,0);
    $('statCount').textContent = inventory.length;
    $('statValue').textContent = money(total);
    $('statOpens').textContent = opens;
    let best = null;
    for(const it of inventory){ if(!best || it.price>best.price) best = it; }
    const be = $('statBest');
    if(best){ be.textContent = best.skin; be.style.color = best.hex || best.color; be.title = best.name + ' \u00b7 ' + money(best.price); }
    else { be.textContent = 'None'; be.style.color=''; be.title=''; }

    renderHistory();
  }
  function renderHistory(){
    const el = $('history');
    if(!history.length){
      el.innerHTML = '<li class="hist-empty">Nothing yet. Your opened items appear here.</li>';
      return;
    }
    el.innerHTML = history.map(h=>{
      const d = new Date(h.ts);
      const time = d.toLocaleDateString([], {month:'short', day:'numeric'}) + ' ' + d.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
      return '<li class="hist-row" style="--rc:' + h.color + '">' +
        '<img class="hist-img" src="' + h.img + '" alt="" loading="lazy" width="44" height="34">' +
        '<div class="hist-body">' +
          '<div class="hist-name"><span class="hist-weapon">' + esc(h.weapon) + '</span> ' + esc(h.skin) +
          (h.stattrak?' <span style="color:var(--warning);font-size:11px;">ST\u2122</span>':'') + '</div>' +
          '<div class="hist-case">' + esc(h.caseName) + ' \u00b7 ' + esc(WEAR_SHORT[h.wear]||h.wear) + '</div>' +
        '</div>' +
        '<div class="hist-meta"><div class="hist-price">' + money(h.price) + '</div><div class="hist-time">' + time + '</div></div>' +
      '</li>';
    }).join('');
  }

  /* ---------- contracts (trade up) ---------- */
  function eligibleInventory(){ return inventory.filter(it=>CONTRACT_RARITIES.indexOf(it.rarity)>=0); }
  function renderContracts(){
    const pool = $('contractPool'), empty = $('contractEmpty');
    const elig = eligibleInventory();
    if(!elig.length){
      empty.classList.add('show');
      pool.innerHTML='';
      $('contractHint').textContent='';
      contractPick = []; contractRarity = null;
      renderContractSlots();
      return;
    }
    empty.classList.remove('show');

    // rarity filter chips
    const counts = {};
    CONTRACT_RARITIES.forEach(r=>counts[r]=0);
    elig.forEach(it=>counts[it.rarity]++);
    renderRarityFilter(counts);

    // pool items (filtered to contractRarity if set)
    const shown = elig.filter(it=>!contractRarity || it.rarity===contractRarity);
    pool.innerHTML = shown.map(it=>{
      const picked = contractPick.indexOf(it.id)>=0;
      const dim = contractRarity && it.rarity!==contractRarity ? ' dim' : '';
      return '<div class="pool-item' + (picked?' is-picked':'') + dim + '" data-pick="' + it.id + '" style="--rc:' + it.color + '">' +
        '<img src="' + it.img + '" alt="" loading="lazy" width="144" height="70">' +
        '<div class="pi-skin">' + esc(it.skin) + '</div>' +
        '<div class="pi-price">' + money(it.price) + '</div>' +
      '</div>';
    }).join('');

    renderContractSlots();
  }
  function renderRarityFilter(counts){
    const host = $('contractHint');
    const chips = CONTRACT_RARITIES.map(r=>{
      const on = contractRarity===r;
      const style = on ? ('background:' + RARITIES[r].color + ';border-color:' + RARITIES[r].color + ';') : '';
      return '<button class="rf-chip' + (on?' is-on':'') + '" data-rar="' + r + '" style="' + style + '" type="button">' + r + ' (' + counts[r] + ')</button>';
    }).join('');
    host.innerHTML = '<span class="rarity-filter">' + chips + '</span>';
  }
  function renderContractSlots(){
    const slots = $('contractSlots');
    let html='';
    for(let i=0;i<10;i++){
      const id = contractPick[i];
      const it = id ? inventory.find(x=>x.id===id) : null;
      if(it){
        html += '<div class="slot filled" style="--rc:' + it.color + '">' +
          '<span class="slot-num">' + (i+1) + '</span>' +
          '<button class="slot-x" data-unpick="' + it.id + '" type="button" aria-label="Remove ' + esc(it.skin) + '">\u00d7</button>' +
          '<img src="' + it.img + '" alt=""></div>';
      } else {
        html += '<div class="slot"><span class="slot-num">' + (i+1) + '</span></div>';
      }
    }
    slots.innerHTML = html;

    const target = $('contractTarget'), btn = $('btnTradeUp');
    if(contractPick.length===10 && contractRarity && NEXT_TIER[contractRarity]){
      const nt = NEXT_TIER[contractRarity];
      target.innerHTML = '1 <b style="--tc:' + RARITIES[nt].color + '">' + nt + '</b> item';
      btn.disabled = false;
    } else {
      const need = contractRarity ? (10 - contractPick.length) + ' more ' + contractRarity : '10 matching items';
      target.textContent = 'Select ' + need;
      btn.disabled = true;
    }
  }
  function togglePick(id){
    const it = inventory.find(x=>x.id===id); if(!it) return;
    if(contractRarity && it.rarity!==contractRarity){
      // switch selection to the new rarity
      contractRarity = it.rarity; contractPick = [id]; renderContracts(); return;
    }
    if(!contractRarity) contractRarity = it.rarity;
    const idx = contractPick.indexOf(id);
    if(idx>=0){ contractPick.splice(idx,1); if(!contractPick.length) contractRarity = null; }
    else { if(contractPick.length>=10){ SFX.error(); toast('A contract uses exactly 10 items','bad'); return; } contractPick.push(id); }
    SFX.blip();
    renderContracts();
  }
  function setRarityFilter(r){
    if(contractRarity===r){ contractRarity=null; contractPick=[]; }
    else { contractRarity=r; contractPick = contractPick.filter(id=>{ const it=inventory.find(x=>x.id===id); return it && it.rarity===r; }); }
    renderContracts();
  }
  function doTradeUp(){
    if(contractPick.length!==10 || !contractRarity) return;
    const nt = NEXT_TIER[contractRarity]; if(!nt) return;
    SFX.contract();
    // remove the 10 items
    const ids = contractPick.slice();
    inventory = inventory.filter(it=>ids.indexOf(it.id)<0);
    // roll output from a random case that has the next tier
    const pool = CASES.filter(c=>c.buckets[nt] && c.buckets[nt].length);
    const c = pool[randInt(pool.length)];
    const result = makePull(rollRaw(c.id, nt), c.id);
    inventory.push(result); save.inv();
    addToHistory(result);
    contractPick = []; contractRarity = null;
    updateTabCounts(); renderContracts(); renderInventory();
    SFX.reveal(result.rarity);
    showReveal([result], { contract:true });
    toast('Contract complete','good');
  }

  /* ---------- views ---------- */
  function switchView(name){
    document.querySelectorAll('.tab').forEach(t=>t.classList.toggle('is-active', t.dataset.view===name));
    document.querySelectorAll('.view').forEach(v=>{ v.hidden = (v.id !== 'view-'+name); });
    if(name==='inventory') renderInventory();
    if(name==='contracts') renderContracts();
    SFX.tab();
    window.scrollTo({ top:0, behavior:'smooth' });
  }

  /* ---------- toast ---------- */
  let toastTimer=null;
  function toast(msg, kind){
    const el = $('toast');
    el.textContent = msg;
    el.className = 'toast show' + (kind?(' '+kind):'');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(()=>{ el.className='toast'; }, 2200);
  }

  /* ---------- mute ---------- */
  function updateMuteBtn(){ $('muteBtn').setAttribute('aria-pressed', muted?'true':'false'); }
  function toggleMute(){
    muted = !muted; save.muted(); updateMuteBtn();
    if(!muted){ ensureAudio(); SFX.blip(); }
  }

  /* ---------- events ---------- */
  function bindEvents(){
    document.querySelectorAll('.tab').forEach(t=>t.addEventListener('click', ()=>switchView(t.dataset.view)));
    document.addEventListener('click', (e)=>{
      const goto = e.target.closest('[data-goto]'); if(goto){ switchView(goto.dataset.goto); return; }
      const card = e.target.closest('[data-case]'); if(card){ selectCase(Number(card.dataset.case)); return; }
      const sell = e.target.closest('[data-sell]'); if(sell){ sellItem(sell.dataset.sell); return; }
      const pick = e.target.closest('[data-pick]'); if(pick){ togglePick(pick.dataset.pick); return; }
      const unpick = e.target.closest('[data-unpick]'); if(unpick){ e.stopPropagation(); togglePick(unpick.dataset.unpick); return; }
      const rar = e.target.closest('[data-rar]'); if(rar){ setRarityFilter(rar.dataset.rar); return; }
    });

    $('btnOpen').addEventListener('click', spin);
    $('wallet').addEventListener('click', topUp);
    $('muteBtn').addEventListener('click', toggleMute);

    $('btnAgain').addEventListener('click', ()=>{ closeReveal(); spin(); });
    $('btnKeep').addEventListener('click', closeReveal);
    $('btnSellAll').addEventListener('click', sellReveal);
    $('revealBackdrop').addEventListener('click', closeReveal);

    // batch size changes update the open cost and button state
    document.querySelectorAll('input[name="batch"]').forEach(r=>{
      r.addEventListener('change', ()=>{ updateWallet(); SFX.blip(); });
    });

    // spin speed is a pure preference, but lock it while a spin is running
    document.querySelectorAll('input[name="speed"]').forEach(r=>{
      r.addEventListener('change', ()=>{
        if(spinning){ r.checked = false; document.querySelector('input[name="speed"][value="' + spinSpeed + '"]').checked = true; return; }
        if(SPIN_SPEEDS[r.value]){ spinSpeed = r.value; save.speed(); SFX.blip(); }
      });
    });
    $('invSort').addEventListener('change', renderInventory);

    $('btnClearInv').addEventListener('click', ()=>{
      if(!inventory.length) return;
      if(confirm('Clear your entire inventory and history? This cannot be undone.')){
        inventory=[]; history=[]; contractPick=[]; contractRarity=null;
        save.inv(); save.hist(); updateTabCounts(); renderInventory(); renderContracts();
        toast('Inventory cleared');
      }
    });
    $('btnTradeUp').addEventListener('click', doTradeUp);

    document.addEventListener('keydown', (e)=>{
      if(e.key==='Escape' && !$('reveal').hidden) closeReveal();
      if(e.code==='Space' && !spinning && $('reveal').hidden){
        const active = document.querySelector('.view:not([hidden])');
        if(active && active.id==='view-cases' && document.activeElement.tagName!=='BUTTON'){ e.preventDefault(); spin(); }
      }
    });
  }

  /* ---------- init ---------- */
  function init(){
    if(!window.CASE_DATA || !window.CASE_DATA.length){
      $('main').innerHTML = '<p style="color:var(--body);padding:40px 0;">Case data failed to load. Make sure data.js is present.</p>';
      return;
    }
    CASES = normalize(window.CASE_DATA);
    load();
    const spEl = document.querySelector('input[name="speed"][value="' + spinSpeed + '"]');
    if(spEl) spEl.checked = true;
    renderCaseGrid();
    renderOddsStrip();
    selectCase(0, true);
    updateWallet();
    updateMuteBtn();
    updateTabCounts();
    renderInventory();
    bindEvents();
  }

  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
