// PoolCheck — smartphone colorimetry for swimming-pool chlorine, DPD (free) or OTO (total).
// Mirrors poolcheck_photo.py exactly (the GPT's Code-Interpreter copy of this engine).
//
// Since 2026-09-11 the reading is taken off the 0–5 mg/L COLOUR CHARTS (eight steps) rather
// than a single absorbance slope: the vial colour, white-balanced against the white card in
// the same photo, is matched to the nearest point on the chart's colour line and the mg/L is
// interpolated between the two neighbouring swatches. The chart swatch colours below are the
// median RGB of each block in the two chart images (DPD and Ortho Tolidine/Toluidine), and the
// 0.0 block is each chart's own white, so a chart is used as ratios against its 0.0 block —
// exactly as the vial is used as ratios against the white card.
var POOL_MIN=1.0, POOL_IDEAL_HIGH=3.0, POOL_MAX=5.0;
var CHART_MG=[0,0.2,0.5,1,2,3,4,5], CHART_TOP=5.0;
var OFF_CHART_FIT=0.12;      // weighted distance from the chart line above which the colour is flagged
// Vial-on-white gate (same rule in every app of the family): refuse when >50% of the band is
// neither liquid nor white card, or when >20% is and the liquid covers <15%.
var SCENE_MAX_FRAC=0.50, SCENE_WARN_FRAC=0.20, SAMPLE_MIN_FRAC=0.15;
var LEGACY_DPD_K=3.778;      // pre-2026-09-11 green-channel slope — kept in the record for comparison only
var CHARTS={
  dpd:{id:'dpd', name:'DPD', species:'free', label:'Free chlorine', shortLabel:'Free Cl', colour:'pink', channel:1,
    rgb:[[254,254,254],[253,230,240],[252,193,220],[249,158,202],[244,123,184],[239,91,168],[234,53,146],[221,26,129]],
    sop:['Collect <b>10 mL</b> pool water in a clean clear vial.',
         'Add the <b>DPD</b> reagent (tablet/powder for free chlorine); cap and invert until an even <b>pink</b> develops.',
         'Read <b>within 1 minute</b> — DPD colour drifts toward total chlorine on standing.',
         'Hold the vial against a <b>pure white</b> card/paper, fill the outline and tap the shutter.'],
    chips:['1 · Fill 10 mL','2 · Add DPD','3 · Photograph','4 · Result']},
  oto:{id:'oto', name:'OTO', species:'total', label:'Total chlorine (OTO)', shortLabel:'Total Cl', colour:'yellow', channel:2,
    rgb:[[250,250,250],[250,245,208],[253,242,150],[253,240,100],[253,237,56],[254,237,5],[253,220,2],[246,195,4]],
    sop:['Collect <b>10 mL</b> pool water in a clean clear vial.',
         'Add the <b>ortho-tolidine (OTO)</b> reagent (usually 3–4 drops); cap and invert — a <b>yellow</b> colour develops.',
         'Photograph <b>immediately</b> after mixing; the colour keeps rising on standing and over-reports.',
         'Hold the vial against a <b>pure white</b> card/paper, fill the outline and tap the shutter.',
         'OTO reads <b>total</b> chlorine (free + combined). It can prove chlorine is absent or low, but cannot confirm the 1–3 mg/L <b>free</b> range — confirm with DPD.'],
    chips:['1 · Fill 10 mL','2 · Add OTO','3 · Photograph','4 · Result']}
};
// Chart as transmittance vectors (swatch ÷ 0.0 swatch, clipped to 1) plus per-channel
// weights: each channel counts in proportion to how much it moves across the chart, so
// red — nearly flat on both charts — cannot drag a match.
(function prep(){
  Object.keys(CHARTS).forEach(function(id){
    var ch=CHARTS[id], w=ch.rgb[0];
    ch.t=ch.rgb.map(function(c){ return [Math.min(1,c[0]/w[0]),Math.min(1,c[1]/w[1]),Math.min(1,c[2]/w[2])]; });
    var rng=[0,1,2].map(function(c){ var v=ch.t.map(function(t){return t[c];}); return Math.max.apply(null,v)-Math.min.apply(null,v); });
    var mx=Math.max.apply(null,rng); ch.w=rng.map(function(r){return r/mx;});
  });
})();
var reagentId='dpd';
function R(){ return CHARTS[reagentId]; }
// DPD magenta: red dominant with blue also above green — no illuminant makes white paper look like this.
function isPink(r,g,b){ return r>g+8 && b>g+2 && (r-g)>10; }
// OTO yellow: red and green both well above blue. Yellow IS the warm end of the colour-temperature
// axis, so this is only ever applied to WHITE-BALANCED values (see analyzePixels).
function isYellow(r,g,b){ return (r-b)>18 && (g-b)>14 && r>90 && g>70; }
var ANALYTE={dpd:isPink, oto:isYellow};

var camStream=null, roiTimer=null, lastGeo=null, lastReading=null;

// The app is used in both the US and India, so dates follow the device's REGION
// (7/24/2026 vs 24/07/2026) — but the language is pinned to English and digits to
// Latin. Without the pin, a phone set to Marathi/Bengali renders Devanagari digits, which
// no field record should contain.
var APP_LOCALE=(function(){
  try{
    var o=new Intl.DateTimeFormat().resolvedOptions();
    var region=(String(o.locale).match(/-([A-Za-z]{2})(?:-|$)/)||[])[1];
    if(region) region=region.toUpperCase();
    if(!region){ var tz=o.timeZone||'';                       // locale carried no region
      region=/Kolkata|Calcutta/i.test(tz)?'IN':(/America\//.test(tz)?'US':''); }
    return 'en'+(region?'-'+region:'')+'-u-nu-latn';
  }catch(e){ return 'en-u-nu-latn'; }
})();
function fmt(x,d){ if(!isFinite(x)||x===null) return "—"; return Number(x).toFixed(d); }
function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g,function(c){
  return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
// Same median as the Python engine: the mean of the two middle values when n is even.
function _median(a){ if(!a.length) return 0; a.sort(function(x,y){return x-y;}); var n=a.length;
  return n%2?a[n>>1]:(a[n/2-1]+a[n/2])/2; }

function requestGeo(){
  if(!navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition(function(p){ lastGeo={lat:p.coords.latitude,lon:p.coords.longitude}; },
    function(){ lastGeo=null; }, {enableHighAccuracy:true,timeout:8000,maximumAge:60000});
}
function startCam(){
  stopCam();
  var v=document.getElementById('cam'), hint=document.getElementById('camHint');
  if(!navigator.mediaDevices||!navigator.mediaDevices.getUserMedia){
    hint.innerHTML='<span style="color:var(--red)">Camera not available — use 📁 Photo or the manual entry below.</span>'; return; }
  navigator.mediaDevices.getUserMedia({video:{facingMode:'environment'}})
    .then(function(s){ camStream=s; v.srcObject=s; hint.textContent='Fill the outline with the vial against white, then tap the shutter.';
      if(roiTimer) clearInterval(roiTimer); roiTimer=setInterval(checkROI,400); })
    .catch(function(){ hint.innerHTML='<span style="color:var(--red)">Camera blocked — allow it, or use 📁 Photo / manual entry.</span>'; });
}
function stopCam(){ if(camStream){camStream.getTracks().forEach(function(t){t.stop();});camStream=null;} if(roiTimer){clearInterval(roiTimer);roiTimer=null;} }

// ---- reagent selection: the operator's choice is the ONLY authority ----
// The photo's colour is used to VETO a clear contradiction (a yellow vial on the DPD tab is
// refused and told what it looks like) but never to switch the reagent.
function setReagent(id){
  if(!CHARTS[id]) return;
  reagentId=id; var ch=R();
  var tD=document.getElementById('rgDpd'), tO=document.getElementById('rgOto');
  if(tD){ tD.className=(id==='dpd'?'on':''); tD.setAttribute('aria-selected',id==='dpd'); }
  if(tO){ tO.className=(id==='oto'?'on':''); tO.setAttribute('aria-selected',id==='oto'); }
  var seg=document.getElementById('reagentTabs'); if(seg) seg.className='seg '+(id==='oto'?'yellowish':'pinkish');
  ['testPanel','resultPanel'].forEach(function(pid){ var el=document.getElementById(pid); if(el) el.className='card '+id; });
  var tt=document.getElementById('testTitle'); if(tt) tt.textContent='2 · '+ch.name+' test — '+(id==='oto'?'total chlorine (yellow)':'free chlorine (pink)');
  var rn=document.getElementById('reagentNote'); if(rn) rn.innerHTML=(id==='oto'
    ?'<b>OTO</b> (ortho-tolidine, yellow) measures <b>total</b> chlorine — read against the OTO chart. Switch to DPD to test free chlorine.'
    :'<b>DPD</b> (pink) measures <b>free</b> chlorine — the pool standard (WHO 1–3 mg/L) is on this test. Switch to OTO only if you added ortho-tolidine.');
  var oc=document.getElementById('otoCaution'); if(oc) oc.style.display=(id==='oto'?'block':'none');
  try{ if(history.replaceState) history.replaceState(null,'',location.pathname+location.search+(id==='oto'?'#oto':'')); }catch(e){}
  var sop=document.getElementById('sopList'); if(sop) sop.innerHTML=ch.sop.map(function(x){return '<li>'+x+'</li>';}).join('');
  var chips=document.getElementById('stepChips'); if(chips) chips.innerHTML=ch.chips.map(function(x,i){return '<span'+(i===0?' class="on"':'')+'>'+x+'</span>';}).join('');
  var rt=document.getElementById('resultTitle'); if(rt) rt.textContent=ch.label;
  var lab=document.getElementById('roiLabel'); if(lab) lab.textContent='Align the '+ch.colour+' vial · white background';
  renderChartStrip();
  rejectTest('Reagent set to <b>'+ch.name+'</b> ('+ch.label.toLowerCase()+'). Capture a test to see the result.');
}
// The chart the reading is made against, drawn from the same numbers the engine uses.
// Tapping a swatch enters that card step as a manual reading (0.0 is deliberately not a
// button: a zero alert must come from an explicit statement, not a mis-tap).
function renderChartStrip(){
  var el=document.getElementById('chartStrip'); if(!el) return;
  var ch=R(), h='';
  ch.rgb.forEach(function(c,i){
    var mg=CHART_MG[i], bg='rgb('+c[0]+','+c[1]+','+c[2]+')';
    h+=(i===0?'<div class="sw" style="background:'+bg+'"><b>0.0</b></div>'
              :'<button type="button" class="sw" style="background:'+bg+'" onclick="manualSwatch('+mg+')" aria-label="Card reading '+mg+' mg/L"><b>'+mg.toFixed(1)+'</b></button>');
  });
  el.innerHTML=h;
  var t=document.getElementById('chartTitle'); if(t) t.textContent=ch.name+' colour chart — '+ch.label.toLowerCase()+', mg/L';
}

// ---- pixel engine (pure; the node harness drives it without a DOM) ----
// d = RGBA bytes of the centre 30–70% vertical band of the frame.
function analyzePixels(d){
  var ch=R(), other=CHARTS[ch.id==='dpd'?'oto':'dpd'];
  var n=d.length/4, i, over=0;
  // pass 1 — the white card, chosen WITHOUT looking at colour: the brightest 10% of the band
  // in the MEASURING channel. The analyte absorbs there, so the vial is always darker than the
  // card in that channel; a single-channel brightness test cannot be fooled by a colour cast
  // the way a "bright and neutral" pixel test is (warm paper fails neutrality and, worse, can
  // pass a yellow test and join the sample).
  var hist=new Uint32Array(256);
  for(i=0;i<d.length;i+=4){ if(d[i]>250&&d[i+1]>250&&d[i+2]>250) over++; hist[d[i+ch.channel]]++; }
  var want=Math.max(50,Math.floor(n*0.10)), acc=0, thr=255;
  for(i=255;i>=0;i--){ acc+=hist[i]; if(acc>=want){ thr=i; break; } }
  var wV=[[],[],[]], nW=0;
  for(i=0;i<d.length;i+=4){ if(d[i+ch.channel]>=thr){ wV[0].push(d[i]); wV[1].push(d[i+1]); wV[2].push(d[i+2]); nW++; } }
  var white=nW>=50?[_median(wV[0]),_median(wV[1]),_median(wV[2])]:[0,0,0];
  // A usable card is bright in every channel and is not the vial itself (on a dark bench the
  // brightest thing in frame is the sample). No card -> white=0, never a fabricated 255: a
  // reading is only ever computed against a MEASURED reference (family-wide fix, 2026-07-30).
  var whiteOK=nW>=50 && Math.min(white[0],white[1],white[2])>170 && !isPink(white[0],white[1],white[2]) && !isYellow(white[0],white[1],white[2]);
  if(!whiteOK) return {detected:false, whiteOK:false, overFrac:over/n, white:[0,0,0], nWhite:nW};
  // pass 2 — colour tests on WHITE-BALANCED values (the card is neutral by construction)
  var k=[255/Math.max(1,white[0]),255/Math.max(1,white[1]),255/Math.max(1,white[2])];
  var sV=[[],[],[]], nS=0, nOther=0, nScene=0;
  for(i=0;i<d.length;i+=4){
    var nr=d[i]*k[0], ng=d[i+1]*k[1], nb=d[i+2]*k[2];
    if(ANALYTE[ch.id](nr,ng,nb)){ sV[0].push(d[i]); sV[1].push(d[i+1]); sV[2].push(d[i+2]); nS++; }
    else if(ANALYTE[other.id](nr,ng,nb)) nOther++;
    else if(!(Math.min(nr,ng,nb)>150 && Math.max(nr,ng,nb)-Math.min(nr,ng,nb)<30)) nScene++;   // neither reagent nor white card
  }
  var minPix=Math.max(50,0.02*n);
  // A face, a room or a document has a sliver of "pink" and most of the frame in other
  // colours; a vial on white paper has neither. Refuse such a frame rather than read it.
  if(nS>=minPix && (nScene>SCENE_MAX_FRAC*n || (nScene>SCENE_WARN_FRAC*n && nS<SAMPLE_MIN_FRAC*n)))
    return {detected:false, whiteOK:true, overFrac:over/n, white:white, nWhite:nW, notVial:true,
            sampleFrac:nS/n, sceneFrac:nScene/n};
  if(nS<minPix) return {detected:false, whiteOK:true, overFrac:over/n, white:white, nWhite:nW,
                        wrongReagent:nOther>=minPix, looksLike:other.id};
  return {detected:true, whiteOK:true, overFrac:over/n, white:white, nWhite:nW,
          sample:[_median(sV[0]),_median(sV[1]),_median(sV[2])], nSample:nS};
}
function analyzeFrame(srcEl,w,h){
  var cv=document.createElement('canvas'); cv.width=w; cv.height=h;
  var cx=cv.getContext('2d',{willReadFrequently:true}); cx.drawImage(srcEl,0,0,w,h);
  var x0=Math.round(w*0.30), bw=Math.round(w*0.40);
  return analyzePixels(cx.getImageData(x0,0,bw,h).data);
}
// Project a transmittance triple onto the chart's colour line. fit = weighted distance from
// the line (0 = exactly a chart colour); beyond = past the 5.0 swatch along the last segment.
function chartRead(t,reagent){
  var ch=CHARTS[reagent], P=ch.t, w=ch.w, best=null, i, c;
  for(i=0;i<P.length-1;i++){
    var a=P[i], b=P[i+1], d=[], x=[], l2=0, dot=0;
    for(c=0;c<3;c++){ d[c]=(b[c]-a[c])*w[c]; x[c]=(t[c]-a[c])*w[c]; l2+=d[c]*d[c]; dot+=x[c]*d[c]; }
    var u=l2>0?dot/l2:0, uc=Math.min(1,Math.max(0,u)), fit=0;
    for(c=0;c<3;c++){ var e=x[c]-uc*d[c]; fit+=e*e; }
    fit=Math.sqrt(fit);
    if(best===null||fit<best.fit-1e-9) best={fit:fit,seg:i,frac:uc,u:u};
  }
  var mg=CHART_MG[best.seg]+best.frac*(CHART_MG[best.seg+1]-CHART_MG[best.seg]);
  return {mg:Math.round(mg*1000)/1000, fit:Math.round(best.fit*10000)/10000, seg:best.seg,
          frac:Math.round(best.frac*1000)/1000, beyond:(best.seg===P.length-2&&best.u>1)};
}
function dilutionFactor(){ return parseFloat(document.getElementById('dilution').value)||1; }
function chlorineFromChart(sample,white,reagent,dil){
  dil=dil||1;
  var t=[Math.min(1,sample[0]/white[0]),Math.min(1,sample[1]/white[1]),Math.min(1,sample[2]/white[2])];
  var rd=chartRead(t,reagent);
  var out={reagent:reagent, t:t, conc:Math.round(rd.mg*dil*100)/100, fit:rd.fit, seg:rd.seg, frac:rd.frac,
           beyond:rd.beyond, dil:dil, legacy:null};
  if(reagent==='dpd'){ var gw=white[1], gs=Math.max(1,Math.min(sample[1],white[1]));
    out.legacy=Math.round(LEGACY_DPD_K*Math.log10(gw/gs)*dil*100)/100; }
  return out;
}
function checkROI(){
  var v=document.getElementById('cam'); if(!v.videoWidth) return;
  var s=analyzeFrame(v,240,320), ch=R();
  var roi=document.getElementById('roi'),lab=document.getElementById('roiLabel'),sh=document.getElementById('shutter');
  var ok=true,msg=ch.colour.charAt(0).toUpperCase()+ch.colour.slice(1)+' detected — tap the shutter';
  if(s.overFrac>0.15){ ok=false; msg='Too bright / glare — move to shade'; }
  else if(!s.whiteOK){ ok=false; msg='Use a white background behind the vial'; }
  else if(!s.detected){ ok=false; msg=s.notVial?'Not a vial on white paper — fill the outline':(s.wrongReagent?('Looks like a '+CHARTS[s.looksLike].name+' vial — check the tab'):('Align the '+ch.colour+' vial in the outline')); }
  roi.className='roi '+(ok?'ok':'bad'); lab.textContent=msg; sh.disabled=!ok;
}
function classify(conc,reagent){
  // With cyanuric-acid-stabilized chlorine, MAHC 2023 requires a minimum FC of 2.0 mg/L.
  var cya=parseFloat(document.getElementById('cya').value)||0, lo=cya>0?2.0:POOL_MIN;
  if(reagent==='oto'){
    // OTO reads TOTAL chlorine. Free <= total, so zero total proves zero free and a total below
    // the free minimum proves free is below it too; anything else leaves free unknown — never a pass.
    if(conc<=0.049) return {band:'zero',label:'ZERO total → zero free — unsafe'};
    if(conc<lo) return {band:'low',label:'Low — total <'+lo+', so free chlorine is too'};
    if(conc>POOL_MAX) return {band:'vhigh',label:'Very high total (>5) — confirm free with DPD'};
    if(conc>POOL_IDEAL_HIGH) return {band:'high',label:'Total >3 — free may be over range; confirm with DPD'};
    return {band:'total',label:'Total '+fmt(conc,2)+' — free ≤ this; confirm with DPD'};
  }
  if(conc<=0.049) return {band:'zero',label:'ZERO — unsafe'};
  if(cya>0){
    if(conc<2.0) return {band:'low',label:'Low (<2, stabilized) — under-chlorinated'};
    if(conc<=POOL_IDEAL_HIGH) return {band:'ok',label:'Safe (2–3 mg/L, stabilized)'};
  }else{
    if(conc<POOL_MIN) return {band:'low',label:'Low (<1) — under-chlorinated'};
    if(conc<=POOL_IDEAL_HIGH) return {band:'ok',label:'Safe (1–3 mg/L)'};
  }
  if(conc<=POOL_MAX) return {band:'high',label:'High (>3) — over-chlorinated'};
  return {band:'vhigh',label:'Very high (>5)'};
}

// Camera-shutter click, synthesized so the app stays asset-free and works offline.
// Two short bursts of decaying filtered noise = mirror up, mirror down.
var audioCtx=null;
function playShutterClick(){
  try{
    var AC=window.AudioContext||window.webkitAudioContext; if(!AC) return;
    if(!audioCtx) audioCtx=new AC();
    if(audioCtx.state==='suspended') audioCtx.resume();
    var t0=audioCtx.currentTime, sr=audioCtx.sampleRate;
    [[0,3800,0.9],[0.055,2600,0.5]].forEach(function(p){
      var len=Math.floor(sr*0.03), buf=audioCtx.createBuffer(1,len,sr), d=buf.getChannelData(0);
      for(var n=0;n<len;n++) d[n]=(Math.random()*2-1)*Math.pow(1-n/len,8); // sharp decay
      var src=audioCtx.createBufferSource(); src.buffer=buf;
      var bp=audioCtx.createBiquadFilter(); bp.type='bandpass'; bp.frequency.value=p[1]; bp.Q.value=1.2;
      var g=audioCtx.createGain(); g.gain.value=p[2];
      src.connect(bp); bp.connect(g); g.connect(audioCtx.destination);
      src.start(t0+p[0]);
    });
  }catch(e){} // audio is cosmetic — never let it block a reading
}
function captureTest(){ var v=document.getElementById('cam'); playShutterClick(); finishTest(analyzeFrame(v,v.videoWidth||960,v.videoHeight||1280),v,v.videoWidth||960,v.videoHeight||1280); }
function loadPhoto(ev){ var f=ev.target.files[0]; if(!f) return;
  var img=new Image(); img.onload=function(){ finishTest(analyzeFrame(img,img.width,img.height),img,img.width,img.height); }; img.src=URL.createObjectURL(f); }

// Clear the result area AND the previous reading's save row — a rejected shot must
// not leave a stale reading one tap away from the log.
function rejectTest(noteHtml){
  lastReading=null;
  document.getElementById('clResult').innerHTML='— <small style="font-size:18px;font-weight:400">mg/L</small>';
  document.getElementById('clBand').style.display='none'; document.getElementById('gaugePin').style.display='none';
  document.getElementById('clSteps').innerHTML=''; document.getElementById('recordBlock').style.display='none';
  document.getElementById('readingSummary').style.display='none'; document.getElementById('saveBtn').style.display='none';
  document.getElementById('clNote').innerHTML=noteHtml;
}
function finishTest(s,srcEl,w,h){
  var ch=R();
  // Same gate order as the Python engine: glare, then white reference, then colour.
  // Photo uploads never pass through checkROI, so every gate is re-applied here.
  if(s.overFrac>0.15){ rejectTest('<b>Too much glare.</b> Retake away from direct sun and reflections.'); return; }
  if(!s.whiteOK){ rejectTest('<b>No white reference.</b> Place the vial on plain white paper in even light and retake — a reading without a white reference is unreliable.'); return; }
  if(!s.detected){
    if(s.notVial){ rejectTest('<b>This does not look like a vial on white paper</b> (coloured liquid is '+Math.round(100*s.sampleFrac)+'% of the frame, other content '+Math.round(100*s.sceneFrac)+'%). Photograph the vial filling the outline against plain white paper and retake.'); return; }
    if(s.wrongReagent){ var o=CHARTS[s.looksLike];
      rejectTest('<b>This looks like a '+o.colour+' '+o.name+' vial</b>, but the '+ch.name+' tab is selected. Confirm which reagent you added and select that tab — the two are read on different scales.'); }
    else rejectTest('<b>No '+ch.colour+' vial detected.</b> Align the '+ch.name+' vial against a white background and capture again. If the sample is truly colourless, confirm zero on the comparator card.');
    return;
  }
  var r=chlorineFromChart(s.sample,s.white,ch.id,dilutionFactor());
  renderResult(r,{sample:s.sample,white:s.white}); stampImage(srcEl,w,h,r);
}
function manualResult(){
  var v=parseFloat(document.getElementById('manualCl').value);
  if(!(v>=0)){ document.getElementById('clNote').textContent='Enter the card reading in mg/L.'; return; }
  renderResult({conc:v,manual:true,reagent:reagentId,beyond:false,legacy:null},null); document.getElementById('recordBlock').style.display='none';
}
function manualSwatch(mg){ document.getElementById('manualCl').value=mg; manualResult(); }
function renderResult(r,px){
  var ch=CHARTS[r.reagent||reagentId], c=classify(r.conc,ch.id);
  document.getElementById('clResult').innerHTML=(r.beyond?'≥ ':'')+fmt(r.conc,2)+' <small style="font-size:18px;font-weight:400">mg/L</small>';
  var b=document.getElementById('clBand'); b.style.display='inline-block'; b.className='band '+c.band; b.textContent=c.label;
  var pin=document.getElementById('gaugePin'); pin.style.display='block';
  pin.style.left=Math.max(0,Math.min(100,(r.conc/5)*100))+'%';
  var st=[];
  if(!r.manual&&px){
    st.push('Colour read from photo — vial RGB <span class="u">'+px.sample.map(function(v){return fmt(v,0);}).join('/')+'</span> · white card RGB <span class="u">'+px.white.map(function(v){return fmt(v,0);}).join('/')+'</span>');
    st.push('Transmittance (vial ÷ card) R/G/B = <span class="u">'+r.t.map(function(v){return fmt(v,3);}).join(' / ')+'</span>');
    st.push('Nearest point on the '+ch.name+' chart line: between the <b>'+CHART_MG[r.seg].toFixed(1)+'</b> and <b>'+CHART_MG[r.seg+1].toFixed(1)+'</b> swatches, '+Math.round(r.frac*100)+'% of the way'
      +(r.dil>1?' × '+r.dil+' (dilution)':'')+' = <span class="u"><b>'+fmt(r.conc,2)+' mg/L</b></span>');
    if(r.fit>OFF_CHART_FIT) st.push('<span style="color:var(--amber)">Colour sits '+fmt(r.fit,2)+' off the chart line — approximate; check lighting, reagent and the white card.</span>');
  } else if(r.manual){ st.push('Manual card reading ('+ch.name+'): <b>'+fmt(r.conc,2)+' mg/L</b>'); }
  document.getElementById('clSteps').innerHTML=st.map(function(x){return '<li>'+x+'</li>';}).join('');
  var cyaRaw=document.getElementById('cya').value;
  var cya=(cyaRaw!==''&&isFinite(parseFloat(cyaRaw)))?parseFloat(cyaRaw):null;
  var note=(ch.id==='oto'?{
    zero:'No chlorine at all — see the alert.',
    low:'Total chlorine is below the minimum, so free chlorine is too. Raise chlorination before allowing bathers.',
    total:'OTO reads total chlorine (free + combined). Free chlorine is at most this value — confirm the '+(cya>0?'2–3':'1–3')+' mg/L free range with a DPD test.',
    high:'Total chlorine above 3 mg/L — free chlorine may be over range; confirm with a DPD test before changing dosing.',
    vhigh:'Well above the range — keep bathers out until a DPD free-chlorine test confirms.'}
  :{zero:'No disinfection — see the alert.',
    low:'Below '+(cya>0?'2 mg/L (MAHC stabilized minimum)':'1 mg/L')+'. Raise chlorination before allowing bathers.',
    ok:'Within the safe pool range ('+(cya>0?'2–3 mg/L with stabilizer':'WHO 1–3 mg/L')+').',
    high:'Above 3 mg/L — reduce dosing; high chlorine irritates eyes/skin.',
    vhigh:'Well above the safe range — keep bathers out until it falls.'})[c.band];
  if(r.beyond) note+=' Colour is at or beyond the 5.0 swatch — dilute 1:1 with chlorine-free water, set Dilution ×2, and re-test.';
  if(cya>90) note+=' CYA '+cya+' mg/L exceeds the MAHC maximum (90) — replace '+Math.round((1-90/cya)*100)+'% of pool water to dilute the stabilizer.';
  document.getElementById('clNote').textContent=note;
  // full reading summary (chlorine + temp + pH + CYA + active HOCl) per the technical note
  var temp=document.getElementById('temp').value, ph=document.getElementById('ph').value;
  var tempN=(temp!==''?parseFloat(temp):null), phN=(ph!==''?parseFloat(ph):null);
  // Active HOCl fraction from pH & temperature — Morris (1966) pKa fit (7.54 at 25 °C).
  // Only meaningful on FREE chlorine, so DPD only.
  var hoclF=null, activeCl=null, hoclHTML='';
  if(ch.id==='dpd'&&phN!==null&&isFinite(phN)){
    var T=(isFinite(tempN)?tempN:25)+273.15;
    var pKa=3000.0/T-10.0686+0.0253*T;
    var f=1/(1+Math.pow(10,phN-pKa));
    hoclF=f; activeCl=f*r.conc;
    var badge;
    if(f<0.20) badge='<span class="phb warn" style="background:#ffd2d2;color:#a10000">disinfection largely ineffective at this pH even though FC reads adequate — correct pH first</span>';
    else if(phN>7.8) badge='<span class="phb warn">raise efficacy — lower pH toward 7.2–7.8</span>';
    else if(f>=0.45) badge='<span class="phb ok">good HOCl fraction</span>';
    else badge='<span class="phb ok">acceptable — pH at the high end of 7.2–7.8</span>';
    hoclHTML='<br>Active HOCl: '+Math.round(f*100)+'% → effective chlorine '+fmt(activeCl,2)+' mg/L '+badge;
  }
  lastReading={conc:r.conc, band:c.band, bandLabel:c.label, manual:!!r.manual,
    reagent:ch.id, species:ch.species, beyond:!!r.beyond,
    chartFit:(r.fit!=null?r.fit:null), legacySlope:(r.legacy!=null?r.legacy:null),
    temp:tempN, ph:phN, cya:cya,
    hoclFraction:(hoclF!==null?parseFloat(hoclF.toFixed(3)):null),
    activeCl:(activeCl!==null?parseFloat(activeCl.toFixed(2)):null),
    pool:(document.getElementById('poolName').value||'').trim(),
    lat:lastGeo?lastGeo.lat:null, lon:lastGeo?lastGeo.lon:null, ts:new Date().toISOString()};
  var sum=document.getElementById('readingSummary');
  sum.style.display='block';
  sum.innerHTML='<b>Reading</b> — '+ch.label+' <b>'+(r.beyond?'≥ ':'')+fmt(r.conc,2)+' mg/L</b>'
    +'  ·  Temp '+(lastReading.temp!==null?fmt(lastReading.temp,1)+' °C':'—')
    +'  ·  pH '+(lastReading.ph!==null?fmt(lastReading.ph,2):'—')
    +(cya!==null?'  ·  CYA '+fmt(cya,0)+' mg/L':'')
    +hoclHTML;
  document.getElementById('saveBtn').style.display='block';
  if(c.band==='zero') triggerCritical(ch.id);
}

// ---- pH advisory (ideal pool pH 7.2-7.8) ----
function checkPH(){
  var el=document.getElementById('phBadge'), v=parseFloat(document.getElementById('ph').value);
  if(!isFinite(v)){ el.innerHTML=''; return; }
  if(v>=7.2&&v<=7.8) el.innerHTML='<span class="phb ok">ideal (7.2–7.8)</span>';
  else if(v>=6.8&&v<=8.2) el.innerHTML='<span class="phb warn">acceptable — aim 7.2–7.8</span>';
  else el.innerHTML='<span class="phb warn">out of range — correct pH</span>';
}

// ---- day-wise on-device test log ----
var LOGKEY='poolcheck_log_v1';
function loadLog(){ try{ return JSON.parse(localStorage.getItem(LOGKEY)||'[]'); }catch(e){ return []; } }
var _capWarned=false;
function saveLog(a){
  if(a.length>2000){
    a.splice(0, a.length-2000);
    if(!_capWarned){ _capWarned=true; console.warn('PoolCheck: log capped at 2000 records — oldest tests were dropped. Export the CSV to keep them.'); }
  }
  try{ localStorage.setItem(LOGKEY, JSON.stringify(a)); return true; }
  catch(e){ alert('Could not save — device storage is full. Export the CSV, then clear old tests.'); return false; }
}
function saveReading(){
  if(!lastReading){ return; }
  var log=loadLog(); log.push(lastReading);
  if(saveLog(log)){
    document.getElementById('saveBtn').textContent='✓ Saved to log';
    setTimeout(function(){ document.getElementById('saveBtn').textContent='＋ Save this test to the log'; },1500);
  }
  renderHistory();
}
// Records saved before 2026-09-11 carry no reagent: they were all DPD free chlorine.
function recReagent(r){ return CHARTS[r.reagent]?r.reagent:'dpd'; }
function renderHistory(){
  var log=loadLog();
  var empty=document.getElementById('histEmpty'), body=document.getElementById('histBody'), act=document.getElementById('histActions');
  if(!log.length){ empty.style.display='block'; body.style.display='none'; act.style.display='none'; return; }
  empty.style.display='none'; body.style.display='block'; act.style.display='flex';
  // group day-wise by ISO YYYY-MM-DD key (locale-independent; string sort is chronological)
  var byDay={};
  log.forEach(function(r){ var d=new Date(r.ts);
    var key=isFinite(d)?d.getFullYear()+'-'+('0'+(d.getMonth()+1)).slice(-2)+'-'+('0'+d.getDate()).slice(-2):String(r.ts||'').slice(0,10);
    (byDay[key]=byDay[key]||[]).push(r); });
  var days=Object.keys(byDay).sort().reverse();
  var h='<table class="htable"><tr><th>Time</th><th>Pool</th><th>Test</th><th>Cl (mg/L)</th><th>Band</th><th>Temp °C</th><th>pH</th></tr>';
  days.forEach(function(day){
    var rows=byDay[day].sort(function(a,b){ return new Date(b.ts)-new Date(a.ts); });
    var free=rows.filter(function(r){return recReagent(r)==='dpd';});
    var avg=free.length?free.reduce(function(s,r){return s+r.conc;},0)/free.length:null;
    var disp=new Date(day+'T00:00:00').toLocaleDateString(APP_LOCALE,{weekday:'short',year:'numeric',month:'short',day:'numeric'});
    h+='<tr><td class="daygrp" colspan="7">'+disp+'  —  '+rows.length+' test(s)'+(avg!==null?', mean free Cl '+fmt(avg,2)+' mg/L':'')+'</td></tr>';
    rows.forEach(function(r){
      var t=new Date(r.ts).toLocaleTimeString(APP_LOCALE, {hour:'2-digit',minute:'2-digit'});
      h+='<tr><td>'+t+'</td><td class="l">'+esc(r.pool||'—')+'</td><td>'+CHARTS[recReagent(r)].shortLabel+'</td><td><b>'+(r.beyond?'≥':'')+fmt(r.conc,2)+'</b></td><td class="l">'+esc(r.bandLabel||'')+'</td><td>'+(r.temp!=null?fmt(r.temp,1):'—')+'</td><td>'+(r.ph!=null?fmt(r.ph,2):'—')+'</td></tr>';
    });
  });
  h+='</table>';
  body.innerHTML=h;
}
// RFC 4180 quoting + spreadsheet formula-injection neutralization (=, +, -, @, tab, CR prefixes)
function csvCell(v){
  var s=String(v==null?'':v);
  if(/^[=+\-@\t\r]/.test(s.trim())) s="'"+s;
  if(/[",\r\n]/.test(s)) s='"'+s.replace(/"/g,'""')+'"';
  return s;
}
function exportHistory(){
  var log=loadLog(); if(!log.length) return;
  var head=['timestamp','date','time','pool','reagent','species','chlorine_mg_L','beyond_chart','band','temperature_C','pH','cyanuric_acid_mg_L','hocl_fraction','active_chlorine_mg_L','latitude','longitude','source','chart_fit','legacy_slope_mg_L'];
  var lines=[head.map(csvCell).join(',')];
  log.forEach(function(r){
    var d=new Date(r.ts), rg=recReagent(r);
    var row=[r.ts, d.toLocaleDateString(APP_LOCALE), d.toLocaleTimeString(APP_LOCALE), r.pool||'',
      rg, CHARTS[rg].species, fmt(r.conc,2), r.beyond?'yes':'', r.bandLabel||'', r.temp!=null?r.temp:'', r.ph!=null?r.ph:'',
      r.cya!=null?r.cya:'', r.hoclFraction!=null?r.hoclFraction:'', r.activeCl!=null?r.activeCl:'',
      r.lat!=null?r.lat:'', r.lon!=null?r.lon:'', r.manual?'manual card':'photo',
      r.chartFit!=null?r.chartFit:'', r.legacySlope!=null?r.legacySlope:''];
    lines.push(row.map(csvCell).join(','));
  });
  // UTF-8 BOM so Excel decodes Devanagari/Odia pool names; CRLF per RFC 4180
  var blob=new Blob(['﻿'+lines.join('\r\n')],{type:'text/csv;charset=utf-8'});
  var a=document.createElement('a'); a.href=URL.createObjectURL(blob);
  a.download='poolcheck_log_'+new Date().toISOString().slice(0,10)+'.csv'; a.click();
  URL.revokeObjectURL(a.href);
}
function clearHistory(){
  if(confirm('Clear all saved tests on this device? Export first if you need them.')){ saveLog([]); renderHistory(); }
}

// ---- tamper-evident overlay ----
function stampImage(srcEl,w,h,r){
  var maxW=900,sc=Math.min(1,maxW/w),cw=Math.round(w*sc),ch=Math.round(h*sc);
  var rg=CHARTS[r.reagent||reagentId];
  var pool=(document.getElementById('poolName').value||'').trim();
  var tv=document.getElementById('temp').value, pv=document.getElementById('ph').value;
  var hasTP=(tv!==''||pv!=='');
  var band=Math.round(cw*(0.40+(pool?0.06:0)+(hasTP?0.06:0)));
  var cv=document.getElementById('stampCanvas'); cv.width=cw; cv.height=ch+band;
  var cx=cv.getContext('2d'); cx.drawImage(srcEl,0,0,cw,ch);
  cx.fillStyle='rgba(4,40,48,.92)'; cx.fillRect(0,ch,cw,band);
  var now=new Date();
  var ts=now.toLocaleString(APP_LOCALE,{weekday:'short',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});
  var off=-now.getTimezoneOffset()/60, tz='GMT'+(off>=0?'+':'')+off;
  var pad=Math.round(cw*0.03), y=ch+pad*1.4, lh=Math.round(band*0.11);
  cx.textBaseline='top';
  cx.fillStyle='#8fe3f0'; cx.font='bold '+Math.round(band*0.14)+'px sans-serif';
  cx.fillText((rg.id==='oto'?'TOTAL chlorine (OTO) = ':'Free chlorine = ')+(r.beyond?'≥ ':'')+r.conc.toFixed(2)+' mg/L', pad, y); y+=lh*1.5;
  cx.fillStyle='#fff'; cx.font=Math.round(band*0.085)+'px sans-serif';
  if(pool){ cx.font='bold '+Math.round(band*0.095)+'px sans-serif'; cx.fillText('Pool: '+pool.substring(0,46),pad,y); y+=lh; cx.font=Math.round(band*0.085)+'px sans-serif'; }
  if(hasTP){ cx.fillText('Temp '+(tv!==''?parseFloat(tv).toFixed(1)+' °C':'—')+'    pH '+(pv!==''?parseFloat(pv).toFixed(2):'—'),pad,y); y+=lh; }
  var lat=lastGeo?lastGeo.lat.toFixed(5):'—', lon=lastGeo?lastGeo.lon.toFixed(5):'—';
  cx.fillText('Lat '+lat+'   Long '+lon+(lastGeo?'':'  (location unavailable)'),pad,y); y+=lh;
  cx.fillText(ts+'  '+tz,pad,y); y+=lh;
  cx.fillStyle='#7fb8c4'; cx.fillText('Address & map: when online…',pad,y);
  drawMapSnippet(cx,cw,ch,band,pad,y,lat,lon);
  document.getElementById('recordBlock').style.display='block';
  document.getElementById('dlStamp').href=cv.toDataURL('image/png');
}
// Keep the stamp English-only: Nominatim returns local-script names (Odia, Hindi...) for
// places with no name:en tag, so drop any comma-part that isn't Latin script.
function englishOnlyAddress(s){
  var nonLatin=/[^ -ɏ‐-‧‰-⁞]/; // ASCII + Latin-1/Ext-A/B + punctuation
  var kept=String(s).split(',').map(function(p){return p.trim();})
    .filter(function(p){ return p && !nonLatin.test(p); });
  return kept.join(', ');
}
function drawMapSnippet(cx,cw,ch,band,pad,addrY,lat,lon){
  if(!lastGeo) return;
  fetch('https://nominatim.openstreetmap.org/reverse?format=json&accept-language=en&lat='+lastGeo.lat+'&lon='+lastGeo.lon)
    .then(function(x){return x.json();}).then(function(j){
      var addr=j&&j.display_name?englishOnlyAddress(j.display_name):'';
      if(addr){ cx.fillStyle='rgba(4,40,48,.92)'; cx.fillRect(pad,addrY,cw-2*pad,band*0.12);
        cx.fillStyle='#bfe8ef'; cx.font=Math.round(band*0.075)+'px sans-serif';
        cx.fillText(addr.substring(0,64),pad,addrY);
        document.getElementById('dlStamp').href=document.getElementById('stampCanvas').toDataURL('image/png'); } }).catch(function(){});
  var msz=Math.round(band*0.7), mx=cw-msz-pad, my=ch+(band-msz)/2;
  var img=new Image(); img.crossOrigin='anonymous';
  img.onload=function(){ cx.drawImage(img,mx,my,msz,msz); cx.strokeStyle='#8fe3f0'; cx.strokeRect(mx,my,msz,msz);
    document.getElementById('dlStamp').href=document.getElementById('stampCanvas').toDataURL('image/png'); };
  img.src='https://staticmap.openstreetmap.de/staticmap.php?center='+lat+','+lon+'&zoom=16&size='+msz+'x'+msz+'&markers='+lat+','+lon+',red-pushpin';
}

// ---- critical zero protocol ----
function triggerCritical(reagent){
  document.getElementById('criticalTitle').textContent='ZERO CHLORINE — POOL UNSAFE';
  document.getElementById('criticalAdv').innerHTML=
    'CRITICAL: No '+(reagent==='oto'?'total chlorine detected (OTO) — so there is no free chlorine either':'free chlorine detected')+'. The pool has no disinfection and is unsafe for bathers.<br><br>'+
    '<b>Immediate action:</b> close the pool to bathers, check the chlorinator/dosing pump, and re-chlorinate to restore 1–3 mg/L free chlorine before reopening.';
  document.getElementById('critical').classList.add('show');
  document.getElementById('ackBtn').focus();
}
function ackCritical(){
  document.getElementById('critical').classList.remove('show');
  document.getElementById('clNote').textContent='ZERO chlorine acknowledged at '+new Date().toLocaleTimeString(APP_LOCALE)+'. Re-chlorinate and re-test before reopening.';
  document.getElementById('shutter').focus();
}

// ---- init ----
requestGeo(); setReagent(location.hash==='#oto'?'oto':'dpd'); startCam(); renderHistory();   // #oto deep-links to the OTO panel
if('serviceWorker' in navigator){ navigator.serviceWorker.register('sw.js').catch(function(){}); }
