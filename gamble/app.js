/* ============================================================
   Case Simulator - application logic
   Native JS, no build step. Reads window.CASE_DATA from data.js.
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

  /* ---------- state ---------- */
  let CASES = [];
  let selectedCaseId = 0;
  let inventory = [];
  let history = [];
  let wallet = START_WALLET;
  let opens = 0;
  let muted = false;
  let spinning = false;
  let currentReveal = null;

  let contractPick = [];       // array of inventory item ids
  let contractRarity = null;   // rarity of current selection / filter

  /* ---------- storage ---------- */
  const K = { inv:'cs.inv', hist:'cs.hist', wallet:'cs.wallet', opens:'cs.opens', muted:'cs.muted' };
  function load(){
    try{ inventory = JSON.parse(localStorage.getItem(K.inv)) || []; }catch(e){ inventory=[]; }
    try{ history   = JSON.parse(localStorage.getItem(K.hist)) || []; }catch(e){ history=[]; }
    const w = parseFloat(localStorage.getItem(K.wallet)); wallet = isNaN(w) ? START_WALLET : w;
    const o = parseInt(localStorage.getItem(K.opens),10); opens = isNaN(o) ? 0 : o;
    muted = localStorage.getItem(K.muted) === '1';
  }
  const save = {
    inv(){ try{ localStorage.setItem(K.inv, JSON.stringify(inventory)); }catch(e){} },
    hist(){ try{ localStorage.setItem(K.hist, JSON.stringify(history)); }catch(e){} },
    wallet(){ try{ localStorage.setItem(K.wallet, String(wallet)); }catch(e){} },
    opens(){ try{ localStorage.setItem(K.opens, String(opens)); }catch(e){} },
    muted(){ try{ localStorage.setItem(K.muted, muted?'1':'0'); }catch(e){} }
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
    return actx;
  }
  function tick(){
    if(muted) return; const a = ensureAudio(); if(!a) return;
    const t = a.currentTime;
    const o = a.createOscillator(), g = a.createGain();
    o.type='square'; o.frequency.setValueAtTime(880 + Math.random()*260, t);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.06, t+0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t+0.045);
    o.connect(g).connect(a.destination); o.start(t); o.stop(t+0.06);
  }
  function playChord(notes, dur, type){
    const a = ensureAudio(); if(!a) return;
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
    const a = ensureAudio(); if(!a) return;
    const t = a.currentTime;
    const o = a.createOscillator(), g = a.createGain();
    o.type='sine'; o.frequency.setValueAtTime(1760, t);
    o.frequency.exponentialRampToValueAtTime(2637, t+0.5);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.09, t+0.05);
    g.gain.exponentialRampToValueAtTime(0.0001, t+0.9);
    o.connect(g).connect(a.destination); o.start(t); o.stop(t+1);
  }
  function revealSound(rarity){
    if(muted) return;
    const map = {
      'Mil-Spec':     { n:[392,523],        d:0.5, t:'triangle' },
      'Restricted':   { n:[440,587,740],    d:0.6, t:'triangle' },
      'Classified':   { n:[523,659,784],    d:0.7, t:'triangle' },
      'Covert':       { n:[523,659,784,1047],d:0.85,t:'sawtooth' },
      'Rare Special': { n:[659,784,988,1319],d:1.0, t:'sawtooth', s:true }
    };
    const m = map[rarity] || map['Mil-Spec'];
    playChord(m.n, m.d, m.t);
    if(m.s) shimmer();
  }

  /* ---------- rendering: case grid + opener ---------- */
  function renderCaseGrid(){
    const grid = $('caseGrid');
    grid.innerHTML = CASES.map(c=>(
      '<button class="case-card' + (c.id===selectedCaseId?' is-selected':'') + '" data-case="' + c.id + '" type="button">' +
        '<img src="' + c.img + '" alt="' + esc(c.name) + '" loading="lazy">' +
        '<div class="case-name">' + esc(c.name) + '</div>' +
      '</button>'
    )).join('');
    $('caseCount').textContent = CASES.length + ' cases';
  }
  function renderOddsStrip(){
    $('oddsStrip').innerHTML = ODDS.map(o=>{
      const pct = (o.p*100).toFixed(o.p<0.01?2:2);
      return '<span class="odds-dot" style="--c:' + RARITIES[o.rar].color + '" title="' + esc(o.rar) + ' ' + pct + '%"></span>';
    }).join('');
  }
  function selectCase(id){
    if(spinning) return;
    selectedCaseId = id;
    const c = CASES[id];
    $('openerThumb').src = c.img;
    $('openerThumb').alt = c.name;
    $('openerTitle').textContent = c.name;
    document.querySelectorAll('.case-card').forEach(el=>{
      el.classList.toggle('is-selected', Number(el.dataset.case)===id);
    });
  }

  /* ---------- reel ---------- */
  function buildReelTiles(caseId, winner){
    const cells = [];
    for(let i=0;i<REEL_LEN;i++){
      if(i===WIN_INDEX){ cells.push({ img:winner.img, color:winner.color }); continue; }
      const raw = rollRaw(caseId);
      const w = pickWear(raw);
      cells.push({ img:w.img, color:raw.color });
    }
    return cells.map(c=>(
      '<div class="reel-item" style="--rc:' + c.color + '"><img src="' + c.img + '" alt=""></div>'
    )).join('');
  }
  function parseTx(t){
    if(!t || t==='none') return 0;
    const m = t.match(/matrix.*\((.+)\)/);
    if(!m) return 0;
    const p = m[1].split(',').map(parseFloat);
    return p.length===6 ? p[4] : (p[12]||0);
  }
  function reelStep(){
    const track = $('reelTrack');
    const a = track.children[0], b = track.children[1];
    if(a && b) return b.offsetLeft - a.offsetLeft;
    return 126;
  }
  function startTicks(dur){
    const track = $('reelTrack');
    const step = reelStep();
    const vpCenter = $('reelViewport').clientWidth/2;
    let lastIdx = -1;
    const t0 = performance.now();
    function frame(now){
      if(!spinning) return;
      const tx = parseTx(getComputedStyle(track).transform);
      const idx = Math.floor((vpCenter - tx)/step);
      if(idx!==lastIdx){ lastIdx = idx; tick(); }
      if(now - t0 < dur*1000 + 150) requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }

  function spin(){
    if(spinning) return;
    if(wallet < KEY_COST){ walletShake(); toast('Not enough funds. Tap the wallet to top up.','bad'); return; }
    charge(KEY_COST);
    ensureAudio();

    spinning = true;
    const opener = $('opener'); opener.classList.add('is-spinning');
    $('btnOpen').disabled = true;
    $('reelHint').hidden = true;

    const caseId = selectedCaseId;
    const winner = makePull(rollRaw(caseId), caseId);

    const track = $('reelTrack');
    track.innerHTML = buildReelTiles(caseId, winner);
    track.style.transition = 'none';
    track.style.transform = 'translateX(0)';
    void track.offsetWidth; // reflow

    const winEl = track.children[WIN_INDEX];
    const vpCenter = $('reelViewport').clientWidth/2;
    const itemW = winEl.offsetWidth;
    const jitter = (Math.random()*2 - 1) * (itemW*0.34);
    const target = vpCenter - (winEl.offsetLeft + itemW/2) - jitter;

    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

    if(reduce){
      track.style.transition = 'transform .45s ease-out';
      track.style.transform = 'translateX(' + target + 'px)';
      setTimeout(()=>finishSpin(winner, target, winEl), 480);
      return;
    }

    const dur = 6.2;
    requestAnimationFrame(()=>{
      track.style.transition = 'transform ' + dur + 's cubic-bezier(0.08,0.75,0.14,1)';
      track.style.transform = 'translateX(' + target + 'px)';
    });
    startTicks(dur);

    const done = (e)=>{
      if(e.propertyName !== 'transform') return;
      track.removeEventListener('transitionend', done);
      finishSpin(winner, target, winEl);
    };
    track.addEventListener('transitionend', done);
    // safety fallback
    setTimeout(()=>{ if(spinning) finishSpin(winner, target, winEl); }, dur*1000 + 900);
  }

  function finishSpin(winner, target, winEl){
    if(!spinning) return;
    spinning = false;
    const track = $('reelTrack');
    track.style.transform = 'translateX(' + target + 'px)';
    if(winEl) winEl.classList.add('is-winner');
    $('opener').classList.remove('is-spinning');

    addToInventory(winner);
    addToHistory(winner);
    opens++; save.opens();
    updateTabCounts();

    revealSound(winner.rarity);
    showReveal(winner, {});
    $('btnOpen').disabled = wallet < KEY_COST;
  }

  /* ---------- reveal overlay ---------- */
  function showReveal(item, opts){
    opts = opts || {};
    currentReveal = item;
    const card = $('revealCard');
    card.style.setProperty('--glow', item.color);
    $('revealGlow').style.background = 'radial-gradient(closest-side, ' + item.color + ', transparent 72%)';
    const rr = $('revealRarity'); rr.textContent = item.rarity;
    $('revealImg').src = item.img;
    $('revealImg').alt = item.name;
    $('revealWeapon').textContent = item.weapon;
    $('revealSkin').textContent = item.skin;

    const tags = [];
    tags.push('<span class="tag">' + esc(item.wear) + '</span>');
    if(item.stattrak) tags.push('<span class="tag tag-st">StatTrak\u2122</span>');
    tags.push('<span class="tag">' + esc(item.caseName) + '</span>');
    $('revealTags').innerHTML = tags.join('');

    $('revealPrice').textContent = money(item.price);
    $('btnSellNow').textContent = 'Sell for ' + money(item.price);
    $('btnAgain').style.display = opts.contract ? 'none' : '';

    $('reveal').hidden = false;
  }
  function closeReveal(){ $('reveal').hidden = true; currentReveal = null; }

  /* ---------- economy ---------- */
  function charge(n){ wallet = Math.round((wallet-n)*100)/100; save.wallet(); updateWallet(); }
  function topUp(){ wallet = Math.round((wallet+TOPUP)*100)/100; save.wallet(); updateWallet(); toast('Added ' + money(TOPUP) + ' to your wallet','good'); }
  function updateWallet(){
    $('walletAmount').textContent = money(wallet);
    $('btnOpen').disabled = spinning || wallet < KEY_COST;
    $('btnOpenCost').textContent = money(KEY_COST);
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
    toast('Sold ' + it.skin + ' for ' + money(it.price),'good');
  }

  /* ---------- inventory + history ---------- */
  function addToInventory(item){ inventory.push(item); save.inv(); }
  function addToHistory(item){
    history.unshift({ weapon:item.weapon, skin:item.skin, wear:item.wear, rarity:item.rarity,
      color:item.color, img:item.img, price:item.price, caseName:item.caseName, stattrak:item.stattrak, ts:item.ts });
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
    if(best){ be.textContent = best.skin; be.style.color = best.hex || best.color; be.title = best.name + ' - ' + money(best.price); }
    else { be.textContent = 'None'; be.style.color=''; be.title=''; }

    renderHistory();
  }
  function renderHistory(){
    const el = $('history');
    if(!history.length){ el.innerHTML = '<li class="hist-empty" style="color:var(--text-faint);font-size:13px;padding:6px 2px;">Nothing yet. Your opened items appear here.</li>'; return; }
    el.innerHTML = history.map(h=>{
      const d = new Date(h.ts);
      const time = d.toLocaleDateString([], {month:'short', day:'numeric'}) + ' ' + d.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
      return '<li class="hist-row" style="--rc:' + h.color + '">' +
        '<img class="hist-img" src="' + h.img + '" alt="" loading="lazy">' +
        '<div><div class="hist-name"><span class="w">' + esc(h.weapon) + '</span> ' + esc(h.skin) +
          (h.stattrak?' <span style="color:#f5b942;font-size:11px;">ST\u2122</span>':'') + '</div>' +
          '<div class="hist-case">' + esc(h.caseName) + ' &middot; ' + esc(WEAR_SHORT[h.wear]||h.wear) + '</div></div>' +
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
        '<img src="' + it.img + '" alt="" loading="lazy">' +
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
          '<button class="slot-x" data-unpick="' + it.id + '" type="button">\u00d7</button>' +
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
    else { if(contractPick.length>=10){ toast('A contract uses exactly 10 items','bad'); return; } contractPick.push(id); }
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
    revealSound(result.rarity);
    showReveal(result, { contract:true });
    toast('Contract complete','good');
  }

  /* ---------- views ---------- */
  function switchView(name){
    document.querySelectorAll('.tab').forEach(t=>t.classList.toggle('is-active', t.dataset.view===name));
    document.querySelectorAll('.view').forEach(v=>{ v.hidden = (v.id !== 'view-'+name); });
    if(name==='inventory') renderInventory();
    if(name==='contracts') renderContracts();
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
  function toggleMute(){ muted = !muted; save.muted(); updateMuteBtn(); if(!muted){ ensureAudio(); tick(); } }

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
    $('btnSellNow').addEventListener('click', ()=>{ if(currentReveal){ const id=currentReveal.id; closeReveal(); sellItem(id); } });
    $('revealBackdrop').addEventListener('click', closeReveal);

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
      document.querySelector('.main').innerHTML = '<p style="color:var(--text-dim);padding:40px 0;">Case data failed to load. Make sure data.js is present.</p>';
      return;
    }
    CASES = normalize(window.CASE_DATA);
    load();
    renderCaseGrid();
    renderOddsStrip();
    selectCase(0);
    updateWallet();
    updateMuteBtn();
    updateTabCounts();
    renderInventory();
    bindEvents();
  }

  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
