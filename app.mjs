import {makeFixture,rng32} from './verifier.mjs';

const $=s=>document.querySelector(s);
const worker=new Worker(new URL('./engine-worker.mjs',import.meta.url),{type:'module'});
const pending=new Map();
let nextID=1;
function status(txt,ok=true){$('#engine-status').textContent=txt;$('#engine-status').style.color=ok?'#8fc6b5':'#ee9d93';}
function request(type,args={},progress=null){
  const id=nextID++;
  return new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>{pending.delete(id);reject(new Error('Worker timeout ('+type+')'));},type==='bench'?180000:25000);
    pending.set(id,{resolve,reject,timeout,progress});
    worker.postMessage({id,type,...args});
  });
}
worker.onmessage=ev=>{
  const {id,type}=ev.data,job=pending.get(id);
  if(!job)return;
  if(type==='bench-progress'){job.progress?.(ev.data);return;}
  clearTimeout(job.timeout);pending.delete(id);
  if(type==='error')job.reject(new Error(ev.data.message));
  else job.resolve(ev.data);
};
worker.onerror=event=>{
  status('Błąd silnika WASM — sprawdź build w README',false);
  for(const [,job] of pending){clearTimeout(job.timeout);job.reject(new Error(event.message||'Worker failed'));}
  pending.clear();
};

// -- tab navigation
let activeTab='path',simActive=false;
const tabs=['path','benchmark','fireflies'];
function selectTab(tab){
  if(!tabs.includes(tab))return;
  activeTab=tab;
  for(const el of document.querySelectorAll('.nav-item'))el.classList.toggle('selected',el.dataset.tab===tab);
  for(const key of tabs)$('#view-'+key).classList.toggle('hidden',key!==tab);
  if(tab!=='fireflies'&&simActive)toggleSim(false);
}
for(const el of document.querySelectorAll('[data-tab]'))el.addEventListener('click',()=>selectTab(el.dataset.tab));

// -- pathfinding grid
let mapSeed=13,gridN=32,gridCells=makeFixture(32,mapSeed,0).initial,gridRoute=[];
let gridSkips=0,gridPainting=false,gridQueue=Promise.resolve();
const pathCanvas=$('#path-canvas'),ctx=pathCanvas.getContext('2d');
function drawGrid(){
  const N=gridN,step=pathCanvas.width/N;
  ctx.fillStyle='#101b24';ctx.fillRect(0,0,pathCanvas.width,pathCanvas.height);
  for(let v=0;v<N*N;v++)if(gridCells[v]){
    ctx.fillStyle='#2e4350';ctx.fillRect(v%N*step+1,Math.floor(v/N)*step+1,step-2,step-2);
  }
  if(gridRoute.length){
    ctx.beginPath();
    gridRoute.forEach((v,i)=>{
      const x=(v%N+.5)*step,y=(Math.floor(v/N)+.5)*step;
      i?ctx.lineTo(x,y):ctx.moveTo(x,y);
    });
    ctx.lineWidth=Math.max(2,step*.32);ctx.strokeStyle='#72ecb6';ctx.lineJoin='round';ctx.lineCap='round';ctx.stroke();
  }
  ctx.strokeStyle='rgba(169,216,215,.08)';ctx.lineWidth=1;ctx.beginPath();
  for(let x=0;x<=N;x++){ctx.moveTo(x*step,0);ctx.lineTo(x*step,pathCanvas.height);ctx.moveTo(0,x*step);ctx.lineTo(pathCanvas.width,x*step);}ctx.stroke();
  const marker=(v,color,text)=>{
    const x=(v%N+.5)*step,y=(Math.floor(v/N)+.5)*step;
    ctx.fillStyle=color;ctx.beginPath();ctx.arc(x,y,step*.43,0,Math.PI*2);ctx.fill();
    ctx.fillStyle='#081519';ctx.textAlign='center';ctx.textBaseline='middle';ctx.font='bold '+Math.floor(step*.52)+'px system-ui';ctx.fillText(text,x,y+1);
  };
  marker(0,'#88e7c5','S');marker(N*N-1,'#ffc580','G');
}
function updateGridUI(res){
  gridRoute=res.route;
  $('#path-cost').textContent=res.cost<0?'Brak trasy':res.cost+' pól';
  $('#path-time').textContent=res.kernelUs===undefined?'—':res.kernelUs.toFixed(2)+' µs';
  gridSkips+=res.skipped||0;$('#path-skips').textContent=String(gridSkips);
  $('#path-check').textContent='BFS PASS';drawGrid();
}
async function initGrid(){
  gridQueue=gridQueue.then(async()=>{
    gridSkips=0;$('#path-skips').textContent='0';gridRoute=[];drawGrid();
    const res=await request('init-grid',{width:gridN,cells:Array.from(gridCells),method:Number($('#path-method').value)});
    updateGridUI(res);
  }).catch(err=>{status(err.message,false);$('#path-check').textContent='BŁĄD';});
  return gridQueue;
}
function cellFromPointer(e){
  const b=pathCanvas.getBoundingClientRect();
  const x=Math.floor((e.clientX-b.left)/b.width*gridN),y=Math.floor((e.clientY-b.top)/b.height*gridN);
  if(x<0||y<0||x>=gridN||y>=gridN)return -1;
  return y*gridN+x;
}
function paint(e){
  if(!gridPainting)return;
  const cell=cellFromPointer(e);
  if(cell<=0||cell>=gridN*gridN-1)return;
  const blocked=Number($('#path-brush').value);
  if(gridCells[cell]===blocked)return;
  gridCells[cell]=blocked;drawGrid();
  gridQueue=gridQueue.then(async()=>{
    const res=await request('grid-toggle',{vertex:cell,blocked});
    updateGridUI(res);
  }).catch(err=>{status(err.message,false);$('#path-check').textContent='BŁĄD';});
}
pathCanvas.addEventListener('pointerdown',e=>{gridPainting=true;pathCanvas.setPointerCapture(e.pointerId);paint(e);});
pathCanvas.addEventListener('pointermove',paint);
pathCanvas.addEventListener('pointerup',()=>gridPainting=false);
pathCanvas.addEventListener('pointercancel',()=>gridPainting=false);
pathCanvas.addEventListener('contextmenu',e=>e.preventDefault());
$('#path-method').addEventListener('change',initGrid);
$('#path-new').addEventListener('click',()=>{gridCells=makeFixture(gridN,++mapSeed,0).initial;initGrid();});
$('#path-clear').addEventListener('click',()=>{gridCells=new Uint8Array(gridN*gridN);initGrid();});
drawGrid();

// -- browser benchmark
let benchmarkData=null;
$('#bench-start').addEventListener('click',async()=>{
  const btn=$('#bench-start');btn.disabled=true;$('#bench-export').disabled=true;
  $('#bench-status').textContent='Pracuje Web Worker. Pomiar, walidacja BFS oraz zapisy wyników…';
  try{
    const repeat=Number($('#bench-repeats').value);
    const {result}=await request('bench',{repeat},progress=>{
      $('#bench-status').textContent='Algorytm '+(progress.method+1)+'/3 • przypadek '+progress.done+'/'+progress.total;
    });
    benchmarkData=result;
    renderBenchmark(result);
    $('#bench-status').textContent=
      'PASS — każdy zwrócony plan zgodny z niezależnym BFS • '+result.fixtures+
      ' map × 75 zmian × '+result.repeats+' powtórzeń. Wszystkie czasy zmierzono lokalnie w WASM.';
    $('#bench-export').disabled=false;
  }catch(e){$('#bench-status').textContent='FAIL: '+e.message;status('Błąd benchmarku',false);}
  finally{btn.disabled=false;}
});
$('#bench-export').addEventListener('click',()=>{
  if(!benchmarkData)return;
  const data={...benchmarkData,measuredAt:new Date().toISOString(),userAgent:navigator.userAgent};
  const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'});
  const url=URL.createObjectURL(blob),link=document.createElement('a');
  link.href=url;link.download='algorithm-showcase-browser-benchmark.json';link.click();
  setTimeout(()=>URL.revokeObjectURL(url),200);
});
function renderBenchmark(r){
  const rows=r.byMethod;
  $('#bench-table').innerHTML='<table><thead><tr><th>Algorytm</th><th>Poprawne trasy</th><th>Łączny czas kernela</th><th>Mediana / event</th><th>p95 / event</th><th>Bezpieczne reuse</th></tr></thead><tbody>'+
    rows.map(x=>'<tr><th>'+x.name+'</th><td>'+x.validated+'/'+r.perAlgorithmEvents+
    '</td><td>'+x.totalKernelMs.toFixed(3)+' ms</td><td>'+x.medianUs.toFixed(3)+
    ' µs</td><td>'+x.p95Us.toFixed(3)+' µs</td><td>'+x.skipped+'</td></tr>').join('')+'</tbody></table>'+
    '<p class="hint">Stosunek całkowitego czasu D* Lite / Gate: <strong>'+r.ratioVsDStar.toFixed(3)+
    '×</strong>. Wartości mniejsze niż 1 oznaczają, że Gate było wolniejsze.</p>';
  const c=$('#bench-chart'),g=c.getContext('2d'),W=c.width,H=c.height;
  g.clearRect(0,0,W,H);g.fillStyle='#131920';g.fillRect(0,0,W,H);
  g.fillStyle='#a6bac4';g.font='18px system-ui';g.fillText('Łączny czas aktualizacji algorytmu — WASM / Twoja przeglądarka',40,39);
  const max=Math.max(...rows.map(x=>x.totalKernelMs),.001);
  const colors=['#9cabb6','#6ca5d2','#78e9b4'];
  rows.forEach((x,i)=>{
    const y=86+i*100;
    g.fillStyle='#aebfc8';g.font='17px system-ui';g.fillText(x.name,40,y);
    g.fillStyle='#253541';g.fillRect(40,y+13,W-250,38);
    g.fillStyle=colors[i];g.fillRect(40,y+13,(W-250)*x.totalKernelMs/max,38);
    g.fillStyle='#e7eff3';g.font='bold 17px ui-monospace,monospace';g.fillText(x.totalKernelMs.toFixed(2)+' ms',W-190,y+40);
  });
  g.fillStyle='#8aa2ad';g.font='14px system-ui';g.fillText('Niskie wartości to lepiej • uwzględniono każdą aktualizację i każde powtórzenie',40,H-17);
}

// -- Moving Target TSP snapshot simulation
const W=560,H=380;
let targets=[],hunters=[],rafID=0,simLast=0,simRequestAt=0,simulationSeed=7101;
const canvases=[$('#fire-canvas-0'),$('#fire-canvas-1')];
const graphics=canvases.map(c=>c.getContext('2d'));
function initializeWorld(){
  if(rafID)cancelAnimationFrame(rafID);
  simActive=false;simLast=0;simRequestAt=0;
  const rnd=rng32(simulationSeed);
  const n=Number($('#fire-count').value),speed=Number($('#fire-speed').value);
  targets=Array.from({length:n},(_,id)=>{
    const a=rnd()*Math.PI*2,mag=speed*(.65+.7*rnd());
    return {id,x:25+rnd()*(W-50),y:25+rnd()*(H-50),
      vx:Math.cos(a)*mag,vy:Math.sin(a)*mag};
  });
  hunters=[0,1].map(mode=>({mode,x:W*.5,y:H*.5,route:[],captured:new Set(),
    pending:false,plans:0,missed:0,lastMs:0,closedCost:0,lastCycle:0,routeTag:'—'}));
  $('#fire-start').textContent='Start';
  for(let mode=0;mode<2;mode++){drawWorld(mode);$('#fire-stats-'+mode).textContent='0/'+targets.length+' złapanych · 0 planów';}
}
function drawWorld(mode){
  const c=graphics[mode],h=hunters[mode];
  c.fillStyle='#0b1420';c.fillRect(0,0,W,H);
  c.strokeStyle='rgba(130,191,196,.045)';c.lineWidth=1;
  for(let x=0;x<W;x+=28){c.beginPath();c.moveTo(x,0);c.lineTo(x,H);c.stroke();}
  for(let y=0;y<H;y+=28){c.beginPath();c.moveTo(0,y);c.lineTo(W,y);c.stroke();}
  c.beginPath();c.moveTo(h.x,h.y);
  for(const id of h.route){const p=targets[id];if(p&&!h.captured.has(id))c.lineTo(p.x,p.y);}
  c.strokeStyle=mode===0?'rgba(119,240,184,.78)':'rgba(126,181,242,.73)';
  c.lineWidth=1.7;c.stroke();
  for(const p of targets){
    if(h.captured.has(p.id))continue;
    c.beginPath();c.fillStyle=mode===0?'rgba(111,231,185,.15)':'rgba(130,187,247,.15)';
    c.arc(p.x,p.y,8,0,Math.PI*2);c.fill();
    c.beginPath();c.fillStyle='#e4ecf1';c.arc(p.x,p.y,2.2,0,Math.PI*2);c.fill();
  }
  c.beginPath();c.arc(h.x,h.y,8,0,Math.PI*2);c.fillStyle='#ffc382';c.fill();
  c.strokeStyle='#ffdda3';c.lineWidth=2;c.stroke();
}
function updateHunters(dt){
  for(const h of hunters){
    while(h.route.length&&h.captured.has(h.route[0]))h.route.shift();
    if(!h.route.length)continue;
    const p=targets[h.route[0]];
    const dist=Math.hypot(p.x-h.x,p.y-h.y);
    if(dist<=11){h.captured.add(p.id);h.route.shift();continue;}
    const step=Math.min(dist,110*dt);
    if(dist>0){h.x+=(p.x-h.x)*step/dist;h.y+=(p.y-h.y)*step/dist;}
    if(Math.hypot(p.x-h.x,p.y-h.y)<=11){h.captured.add(p.id);h.route.shift();}
  }
}
function updateWorld(dt){
  for(const p of targets){
    p.x+=p.vx*dt;p.y+=p.vy*dt;
    if(p.x<12){p.x=12;p.vx=Math.abs(p.vx);}
    if(p.x>W-12){p.x=W-12;p.vx=-Math.abs(p.vx);}
    if(p.y<12){p.y=12;p.vy=Math.abs(p.vy);}
    if(p.y>H-12){p.y=H-12;p.vy=-Math.abs(p.vy);}
  }
}
function runOnePlan(h){
  const active=targets.filter(p=>!h.captured.has(p.id));
  if(!active.length){h.route=[];return;}
  if(active.length<4){
    h.route=active.sort((a,b)=>
      Math.hypot(a.x-h.x,a.y-h.y)-Math.hypot(b.x-h.x,b.y-h.y)).map(p=>p.id);
    h.routeTag='NN endgame';return;
  }
  if(h.pending){h.missed++;return;}
  const xy=[h.x,h.y],ids=active.map(p=>p.id);
  for(const p of active){xy.push(p.x,p.y);}
  h.pending=true;
  request('tsp',{xy,mode:h.mode,budgetMs:35,version:h.plans+1}).then(res=>{
    h.plans++;h.lastMs=res.kernelMs;h.closedCost=res.closedCost;
    h.route=res.order.slice(1).map(i=>ids[i-1]).filter(id=>!h.captured.has(id));
    h.routeTag='WASM';
  }).catch(err=>{status('TSP: '+err.message,false);h.missed++;})
    .finally(()=>{h.pending=false;});
}
function frame(now){
  if(!simActive)return;
  const dt=Math.min(.04,Math.max(0,(now-simLast)/1000||.016));
  simLast=now;updateWorld(dt);updateHunters(dt);
  if(now-simRequestAt>=100){
    simRequestAt=now;
    for(const h of hunters)runOnePlan(h);
  }
  for(let i=0;i<2;i++){
    drawWorld(i);const h=hunters[i];
    $('#fire-stats-'+i).textContent=h.captured.size+'/'+targets.length+' złapanych • '+
      h.plans+' planów • '+h.missed+' missed • '+h.lastMs.toFixed(2)+
      ' ms / plan • '+h.routeTag;
  }
  if(hunters.every(h=>h.captured.size===targets.length)){toggleSim(false);return;}
  rafID=requestAnimationFrame(frame);
}
function toggleSim(on){
  simActive=on;
  $('#fire-start').textContent=on?'Pauza':'Start';
  if(on){simLast=performance.now();rafID=requestAnimationFrame(frame);}
  else if(rafID){cancelAnimationFrame(rafID);rafID=0;}
}
$('#fire-start').addEventListener('click',()=>toggleSim(!simActive));
$('#fire-reset').addEventListener('click',()=>{simulationSeed++;initializeWorld();});
$('#fire-count').addEventListener('change',initializeWorld);
$('#fire-speed').addEventListener('change',initializeWorld);
initializeWorld();

(async()=>{try{await request('ping');status('C++20 / WebAssembly — GOTOWE');await initGrid();}
catch(e){status('WASM niedostępne: '+e.message,false);}})();
