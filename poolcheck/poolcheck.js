// PoolCheck — DPD colorimetry for swimming-pool free chlorine.
// Mirrors poolcheck_engine.py exactly.
var DPD_K=3.778, POOL_MIN=1.0, POOL_IDEAL_HIGH=3.0, POOL_MAX=5.0, RELIABLE_MAX=3.0;
var camStream=null, roiTimer=null, lastGeo=null, lastReading=null;

function fmt(x,d){ if(!isFinite(x)||x===null) return "—"; return Number(x).toFixed(d); }
function _median(a){ if(!a.length) return 0; a.sort(function(x,y){return x-y;}); return a[a.length>>1]; }

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

// Locate the pink DPD liquid in the central band; measure its green vs the white surround.
function analyzeFrame(srcEl,w,h){
  var cv=document.createElement('canvas'); cv.width=w; cv.height=h;
  var cx=cv.getContext('2d'); cx.drawImage(srcEl,0,0,w,h);
  var x0=Math.round(w*0.30), bw=Math.round(w*0.40);
  var d=cx.getImageData(x0,0,bw,h).data;
  var gPink=[],gWhite=[],nPink=0,nWhite=0,over=0,n=0;
  for(var i=0;i<d.length;i+=4){ var R=d[i],G=d[i+1],B=d[i+2]; n++;
    if(R>250&&G>250&&B>250) over++;
    if(R>G+8&&B>G+2&&(R-G)>10){ gPink.push(G); nPink++; }
    else if(Math.min(R,G,B)>170&&(Math.max(R,G,B)-Math.min(R,G,B))<18){ gWhite.push(G); nWhite++; }
  }
  if(nPink<Math.max(50,0.02*n)) return {detected:false,overFrac:over/n,gWhite:_median(gWhite)||0};
  return {detected:true,gPink:_median(gPink),gWhite:(nWhite>=50?_median(gWhite):255),overFrac:over/n};
}
function checkROI(){
  var v=document.getElementById('cam'); if(!v.videoWidth) return;
  var s=analyzeFrame(v,240,320);
  var roi=document.getElementById('roi'),lab=document.getElementById('roiLabel'),sh=document.getElementById('shutter');
  var ok=true,msg='Pink detected — tap the shutter';
  if(s.overFrac>0.15){ ok=false; msg='Too bright / glare — move to shade'; }
  else if(!s.detected){ ok=false; msg='Align the pink vial in the outline'; }
  else if(s.gWhite<150){ ok=false; msg='Use a white background behind the vial'; }
  roi.className='roi '+(ok?'ok':'bad'); lab.textContent=msg; sh.disabled=!ok;
}

function dilutionFactor(){ return parseFloat(document.getElementById('dilution').value)||1; }
function chlorineFromGreen(gS,gW,dil){
  gS=Math.min(gS,gW); var A=Math.log10(gW/gS);
  var conc=Math.max(0,DPD_K*A)*(dil||1);
  return {A:A,conc:conc,adviseDil:conc>RELIABLE_MAX};
}
function classify(conc){
  if(conc<=0.049) return {band:'zero',label:'ZERO — unsafe'};
  if(conc<POOL_MIN) return {band:'low',label:'Low (<1) — under-chlorinated'};
  if(conc<=POOL_IDEAL_HIGH) return {band:'ok',label:'Safe (1–3 mg/L)'};
  if(conc<=POOL_MAX) return {band:'high',label:'High (>3) — over-chlorinated'};
  return {band:'vhigh',label:'Very high (>5)'};
}

function captureTest(){ var v=document.getElementById('cam'); finishTest(analyzeFrame(v,v.videoWidth||960,v.videoHeight||1280),v,v.videoWidth||960,v.videoHeight||1280); }
function loadPhoto(ev){ var f=ev.target.files[0]; if(!f) return;
  var img=new Image(); img.onload=function(){ finishTest(analyzeFrame(img,img.width,img.height),img,img.width,img.height); }; img.src=URL.createObjectURL(f); }

function finishTest(s,srcEl,w,h){
  if(!s.detected){
    document.getElementById('clResult').innerHTML='— <small style="font-size:18px;font-weight:400">mg/L</small>';
    document.getElementById('clBand').style.display='none'; document.getElementById('gaugePin').style.display='none';
    document.getElementById('clSteps').innerHTML=''; document.getElementById('recordBlock').style.display='none';
    document.getElementById('clNote').innerHTML='<b>No vial detected.</b> Align the DPD vial against a white background and capture again. If the sample is truly colourless, confirm zero on the comparator card.';
    return;
  }
  var r=chlorineFromGreen(s.gPink,s.gWhite,dilutionFactor());
  renderResult(r,{gS:s.gPink,gW:s.gWhite}); stampImage(srcEl,w,h,r);
}
function manualResult(){
  var v=parseFloat(document.getElementById('manualCl').value);
  if(!(v>=0)){ document.getElementById('clNote').textContent='Enter the card reading in mg/L.'; return; }
  renderResult({conc:v,manual:true,adviseDil:false},null); document.getElementById('recordBlock').style.display='none';
}
function renderResult(r,px){
  var c=classify(r.conc);
  document.getElementById('clResult').innerHTML=fmt(r.conc,2)+' <small style="font-size:18px;font-weight:400">mg/L</small>';
  var b=document.getElementById('clBand'); b.style.display='inline-block'; b.className='band '+c.band; b.textContent=c.label;
  var pin=document.getElementById('gaugePin'); pin.style.display='block';
  pin.style.left=Math.max(0,Math.min(100,(r.conc/5)*100))+'%';
  var st=[];
  if(!r.manual&&px){
    st.push('Green read from photo: <span class="u">vial G='+fmt(px.gS,1)+' · white G='+fmt(px.gW,1)+'</span>');
    st.push('Absorbance A=log₁₀(G_white/G_vial)=<span class="u">'+fmt(r.A,4)+'</span>');
    var dil=dilutionFactor();
    st.push('Chlorine = 3.778 × A'+(dil>1?' × '+dil+' (dilution)':'')+' = <span class="u"><b>'+fmt(r.conc,2)+' mg/L</b></span>');
  } else if(r.manual){ st.push('Manual card reading: <b>'+fmt(r.conc,2)+' mg/L</b>'); }
  document.getElementById('clSteps').innerHTML=st.map(function(x){return '<li>'+x+'</li>';}).join('');
  var note={zero:'No disinfection — see the alert.',low:'Below 1 mg/L. Raise chlorination before allowing bathers.',
    ok:'Within the safe pool range (WHO 1–3 mg/L).',high:'Above 3 mg/L — reduce dosing; high chlorine irritates eyes/skin.',
    vhigh:'Well above the safe range — keep bathers out until it falls.'}[c.band];
  if(r.adviseDil) note+=' Reading is high — for accuracy, dilute 1:1 with chlorine-free water, set Dilution ×2, and re-test.';
  document.getElementById('clNote').textContent=note;
  // full reading summary (free Cl + temp + pH) per the technical note
  var temp=document.getElementById('temp').value, ph=document.getElementById('ph').value;
  lastReading={conc:r.conc, band:c.band, bandLabel:c.label, manual:!!r.manual,
    temp:(temp!==''?parseFloat(temp):null), ph:(ph!==''?parseFloat(ph):null),
    pool:(document.getElementById('poolName').value||'').trim(),
    lat:lastGeo?lastGeo.lat:null, lon:lastGeo?lastGeo.lon:null, ts:new Date().toISOString()};
  var sum=document.getElementById('readingSummary');
  sum.style.display='block';
  sum.innerHTML='<b>Reading</b> — Free chlorine <b>'+fmt(r.conc,2)+' mg/L</b>'
    +'  ·  Temp '+(lastReading.temp!==null?fmt(lastReading.temp,1)+' °C':'—')
    +'  ·  pH '+(lastReading.ph!==null?fmt(lastReading.ph,2):'—');
  document.getElementById('saveBtn').style.display='block';
  if(c.band==='zero') triggerCritical();
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
function saveLog(a){ try{ localStorage.setItem(LOGKEY, JSON.stringify(a)); }catch(e){} }
function saveReading(){
  if(!lastReading){ return; }
  var log=loadLog(); log.push(lastReading); saveLog(log);
  document.getElementById('saveBtn').textContent='✓ Saved to log';
  setTimeout(function(){ document.getElementById('saveBtn').textContent='＋ Save this test to the log'; },1500);
  renderHistory();
}
function renderHistory(){
  var log=loadLog();
  var empty=document.getElementById('histEmpty'), body=document.getElementById('histBody'), act=document.getElementById('histActions');
  if(!log.length){ empty.style.display='block'; body.style.display='none'; act.style.display='none'; return; }
  empty.style.display='none'; body.style.display='block'; act.style.display='flex';
  // group day-wise (most recent first)
  var byDay={};
  log.forEach(function(r){ var d=new Date(r.ts); var key=d.toLocaleDateString(); (byDay[key]=byDay[key]||[]).push(r); });
  var days=Object.keys(byDay).sort(function(a,b){ return new Date(b)-new Date(a); });
  var h='<table class="htable"><tr><th>Time</th><th>Pool</th><th>Free Cl (mg/L)</th><th>Band</th><th>Temp °C</th><th>pH</th></tr>';
  days.forEach(function(day){
    var rows=byDay[day].sort(function(a,b){ return new Date(b.ts)-new Date(a.ts); });
    var avg=rows.reduce(function(s,r){return s+r.conc;},0)/rows.length;
    h+='<tr><td class="daygrp" colspan="6">'+day+'  —  '+rows.length+' test(s), mean Cl '+fmt(avg,2)+' mg/L</td></tr>';
    rows.forEach(function(r){
      var t=new Date(r.ts).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
      h+='<tr><td>'+t+'</td><td class="l">'+(r.pool||'—')+'</td><td><b>'+fmt(r.conc,2)+'</b></td><td class="l">'+(r.bandLabel||'')+'</td><td>'+(r.temp!=null?fmt(r.temp,1):'—')+'</td><td>'+(r.ph!=null?fmt(r.ph,2):'—')+'</td></tr>';
    });
  });
  h+='</table>';
  body.innerHTML=h;
}
function exportHistory(){
  var log=loadLog(); if(!log.length) return;
  var head=['timestamp','date','time','pool','free_chlorine_mg_L','band','temperature_C','pH','latitude','longitude','source'];
  var lines=[head.join(',')];
  log.forEach(function(r){
    var d=new Date(r.ts);
    var row=[r.ts, d.toLocaleDateString(), d.toLocaleTimeString(), '"'+(r.pool||'').replace(/"/g,'""')+'"',
      fmt(r.conc,2), r.bandLabel||'', r.temp!=null?r.temp:'', r.ph!=null?r.ph:'',
      r.lat!=null?r.lat:'', r.lon!=null?r.lon:'', r.manual?'manual card':'photo'];
    lines.push(row.join(','));
  });
  var blob=new Blob([lines.join('\n')],{type:'text/csv'});
  var a=document.createElement('a'); a.href=URL.createObjectURL(blob);
  a.download='poolcheck_log_'+new Date().toISOString().slice(0,10)+'.csv'; a.click();
}
function clearHistory(){
  if(confirm('Clear all saved tests on this device? Export first if you need them.')){ saveLog([]); renderHistory(); }
}

// ---- tamper-evident overlay ----
function stampImage(srcEl,w,h,r){
  var maxW=900,sc=Math.min(1,maxW/w),cw=Math.round(w*sc),ch=Math.round(h*sc);
  var pool=(document.getElementById('poolName').value||'').trim();
  var tv=document.getElementById('temp').value, pv=document.getElementById('ph').value;
  var hasTP=(tv!==''||pv!=='');
  var band=Math.round(cw*(0.40+(pool?0.06:0)+(hasTP?0.06:0)));
  var cv=document.getElementById('stampCanvas'); cv.width=cw; cv.height=ch+band;
  var cx=cv.getContext('2d'); cx.drawImage(srcEl,0,0,cw,ch);
  cx.fillStyle='rgba(4,40,48,.92)'; cx.fillRect(0,ch,cw,band);
  var now=new Date();
  var ts=now.toLocaleString('en-GB',{weekday:'short',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});
  var off=-now.getTimezoneOffset()/60, tz='GMT'+(off>=0?'+':'')+off;
  var pad=Math.round(cw*0.03), y=ch+pad*1.4, lh=Math.round(band*0.11);
  cx.textBaseline='top';
  cx.fillStyle='#8fe3f0'; cx.font='bold '+Math.round(band*0.14)+'px sans-serif';
  cx.fillText('Free chlorine = '+r.conc.toFixed(2)+' mg/L', pad, y); y+=lh*1.5;
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
function drawMapSnippet(cx,cw,ch,band,pad,addrY,lat,lon){
  if(!lastGeo) return;
  fetch('https://nominatim.openstreetmap.org/reverse?format=json&lat='+lastGeo.lat+'&lon='+lastGeo.lon)
    .then(function(x){return x.json();}).then(function(j){
      if(j&&j.display_name){ cx.fillStyle='rgba(4,40,48,.92)'; cx.fillRect(pad,addrY,cw-2*pad,band*0.12);
        cx.fillStyle='#bfe8ef'; cx.font=Math.round(band*0.075)+'px sans-serif';
        cx.fillText(j.display_name.substring(0,64),pad,addrY);
        document.getElementById('dlStamp').href=document.getElementById('stampCanvas').toDataURL('image/png'); } }).catch(function(){});
  var msz=Math.round(band*0.7), mx=cw-msz-pad, my=ch+(band-msz)/2;
  var img=new Image(); img.crossOrigin='anonymous';
  img.onload=function(){ cx.drawImage(img,mx,my,msz,msz); cx.strokeStyle='#8fe3f0'; cx.strokeRect(mx,my,msz,msz);
    document.getElementById('dlStamp').href=document.getElementById('stampCanvas').toDataURL('image/png'); };
  img.src='https://staticmap.openstreetmap.de/staticmap.php?center='+lat+','+lon+'&zoom=16&size='+msz+'x'+msz+'&markers='+lat+','+lon+',red-pushpin';
}

// ---- critical zero protocol ----
function triggerCritical(){
  document.getElementById('criticalTitle').textContent='ZERO CHLORINE — POOL UNSAFE';
  document.getElementById('criticalAdv').innerHTML=
    'CRITICAL: No free chlorine detected. The pool has no disinfection and is unsafe for bathers.<br><br>'+
    '<b>Immediate action:</b> close the pool to bathers, check the chlorinator/dosing pump, and re-chlorinate to restore 1–3 mg/L free chlorine before reopening.';
  document.getElementById('critical').classList.add('show');
}
function ackCritical(){
  document.getElementById('critical').classList.remove('show');
  document.getElementById('clNote').textContent='ZERO chlorine acknowledged at '+new Date().toLocaleTimeString()+'. Re-chlorinate and re-test before reopening.';
}

// ---- init ----
requestGeo(); startCam(); renderHistory();
if('serviceWorker' in navigator){ navigator.serviceWorker.register('sw.js').catch(function(){}); }
