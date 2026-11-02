import createEngine from './engine.mjs';
import {makeFixture,assertGridRoute,validateTour,roundedTourCost} from './verifier.mjs';

const ready=createEngine({
  locateFile:(name)=>new URL(name,import.meta.url).href,
});
let grid=null,engine=null;
const A={};
function post(id,type,data={}){self.postMessage({id,type,...data});}
function int32(module,ptr,n){return Array.from(module.HEAP32.subarray(ptr>>2,(ptr>>2)+n));}
function check(rc){if(rc<0)throw new Error('C++ engine failed with '+rc);}
function createGrid(module,width,cells,method){
  const cellPtr=module._malloc(cells.length);
  if(!cellPtr)throw new Error('WASM memory allocation failed');
  module.HEAPU8.set(cells,cellPtr);
  const handle=module._demo_grid_create(width,width,cellPtr,method);
  module._free(cellPtr);
  if(!handle)throw new Error('Grid initialization failed');
  const route=module._malloc(width*width*4),meta=module._malloc(8);
  if(!route||!meta){if(route)module._free(route);if(meta)module._free(meta);module._demo_grid_destroy(handle);throw new Error('WASM memory unavailable');}
  return {width,cells:cells.slice(),method,handle,route,meta,module};
}
function deleteGrid(obj){
  if(!obj)return;
  obj.module._demo_grid_destroy(obj.handle);
  obj.module._free(obj.route);obj.module._free(obj.meta);
}
function readGrid(obj,len){
  check(len);
  const route=int32(obj.module,obj.route,len);
  const cost=obj.module.HEAP32[obj.meta>>2];
  const skipped=obj.module.HEAP32[(obj.meta>>2)+1];
  assertGridRoute(obj.width,obj.cells,route,cost);
  return {route,cost,skipped};
}
function currentGrid(obj){
  const len=obj.module._demo_grid_current(obj.handle,obj.route,obj.width*obj.width,obj.meta);
  return readGrid(obj,len);
}
function toggleGrid(obj,vertex,blocked){
  if(vertex<=0||vertex>=obj.width*obj.width-1||blocked!==0&&blocked!==1)
    throw new Error('Invalid grid event');
  const original=obj.cells[vertex];
  const begin=performance.now();
  const len=obj.module._demo_grid_update(obj.handle,vertex,blocked,obj.route,obj.width*obj.width,obj.meta);
  const kernelUs=(performance.now()-begin)*1000;
  check(len);
  obj.cells[vertex]=blocked;
  try{
    const answer=readGrid(obj,len);
    return {...answer,kernelUs};
  }catch(err){
    // Leave invalid instance unavailable; next command must reinitialize.
    deleteGrid(obj);
    if(grid===obj)grid=null;
    obj.cells[vertex]=original;
    throw err;
  }
}
function solveTsp(module,xy,mode,budget=35){
  const n=xy.length/2;
  if(n<5||n>201)throw new Error('TSP expects 4..200 targets plus hunter');
  const pxy=module._malloc(xy.length*8),out=module._malloc(n*4),costPtr=module._malloc(4);
  if(!pxy||!out||!costPtr){
    for(const ptr of [pxy,out,costPtr])if(ptr)module._free(ptr);
    throw new Error('WASM memory allocation failed');
  }
  try{
    module.HEAPF64.set(xy,pxy>>3);
    const begun=performance.now();
    const len=module._demo_tsp_solve(pxy,n,mode,budget,out,n,costPtr);
    const kernelMs=performance.now()-begun;
    check(len);
    const order=int32(module,out,len),closedCost=module.HEAP32[costPtr>>2];
    validateTour(order,n);
    if(roundedTourCost(xy,order)!==closedCost)
      throw new Error('WASM tour cost disagreement with independent JS');
    return {order,closedCost,kernelMs};
  }finally{
    module._free(pxy);module._free(out);module._free(costPtr);
  }
}
async function runBenchmark(module,id,repeat=2){
  if(repeat<1||repeat>8)throw new Error('Benchmark repeat out of range');
  const sizes=[16,32,64],seeds=[11,29,53,71];
  const fixtures=sizes.flatMap(width=>seeds.map(seed=>makeFixture(width,seed,75)));
  const samples=[[],[],[]],byMethod=[];
  let eventsCount=0;
  const algorithmNames=['A*','D* Lite','Gate + D* Lite'];
  // Equal suite for all methods, each run uses fresh native state.
  for(let mode=0;mode<3;mode++){
    let valid=0,skipped=0,computeMs=0;
    for(let rep=0;rep<repeat;rep++)for(const fixture of fixtures){
      const obj=createGrid(module,fixture.width,fixture.initial,mode);
      try{
        currentGrid(obj); // validate initialization, excluded from update timings
        for(const ev of fixture.events){
          const answer=toggleGrid(obj,ev.vertex,ev.blocked);
          samples[mode].push(answer.kernelUs);
          valid++;skipped+=answer.skipped;computeMs+=answer.kernelUs/1000;
        }
      }finally{deleteGrid(obj);}
      post(id,'bench-progress',{method:mode,done:rep*fixtures.length+fixtures.indexOf(fixture)+1,total:repeat*fixtures.length});
    }
    byMethod.push({name:algorithmNames[mode],method:mode,validated:valid,skipped,totalKernelMs:computeMs});
    eventsCount=Math.max(eventsCount,valid);
  }
  function pct(sorted,p){if(!sorted.length)return 0;return sorted[Math.min(sorted.length-1,Math.floor(p*(sorted.length-1)))];}
  for(let m=0;m<3;m++){
    const v=samples[m].slice().sort((a,b)=>a-b);
    Object.assign(byMethod[m],{medianUs:pct(v,.5),p95Us:pct(v,.95),meanUs:v.reduce((a,b)=>a+b,0)/v.length});
  }
  return {byMethod,perAlgorithmEvents:eventsCount,fixtures:fixtures.length,repeats:repeat,
    benchmark:'NEW_BROWSER_FIXTURE_NOT_IDENTICAL_TO_HISTORICAL_PYTHON_RANDOM_STREAM',
    measured:'WASM kernel update only, JS BFS verification outside timed region; browser-specific',
    ratioVsDStar:byMethod[1].totalKernelMs/byMethod[2].totalKernelMs};
}
self.onmessage=async ev=>{
  const {id,type}=ev.data;
  try{
    const mod=engine||await ready;
    engine=mod;
    if(type==='init-grid'){
      deleteGrid(grid);grid=null;
      const width=ev.data.width,method=ev.data.method;
      grid=createGrid(mod,width,Uint8Array.from(ev.data.cells),method);
      post(id,'grid-answer',{...currentGrid(grid),cells:Array.from(grid.cells),width});
    }else if(type==='grid-toggle'){
      if(!grid)throw new Error('Grid not initialized');
      post(id,'grid-answer',{...toggleGrid(grid,ev.data.vertex,ev.data.blocked),vertex:ev.data.vertex,blocked:ev.data.blocked});
    }else if(type==='bench'){
      const result=await runBenchmark(mod,id,ev.data.repeat);
      post(id,'bench-result',{result});
    }else if(type==='tsp'){
      const xy=Float64Array.from(ev.data.xy);
      const answer=solveTsp(mod,xy,ev.data.mode,ev.data.budgetMs);
      post(id,'tsp-answer',{...answer,version:ev.data.version,mode:ev.data.mode});
    }else if(type==='ping'){post(id,'ready',{engine:'Original repository C++20 kernels compiled to WebAssembly'});}
    else throw new Error('Unknown worker command '+type);
  }catch(e){post(id,'error',{message:e?.message||String(e)});}
};
