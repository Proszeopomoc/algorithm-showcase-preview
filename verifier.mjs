// Independent JavaScript oracle and deterministic fixture generator.
// Deliberately separate from the C++/WASM solver; never included in timed kernels.
export function bfs(width, cells) {
  const n=width*width, goal=n-1, dist=new Int32Array(n).fill(-1);
  const prev=new Int32Array(n).fill(-1),queue=new Int32Array(n);
  if(cells[0]||cells[goal])return {cost:-1,path:[]};
  let front=0,back=0;queue[back++]=0;dist[0]=0;
  while(front<back){
    const u=queue[front++];if(u===goal)break;
    const x=u%width, y=Math.floor(u/width);
    const neighbors=[];
    if(x>0)neighbors.push(u-1);
    if(x<width-1)neighbors.push(u+1);
    if(y>0)neighbors.push(u-width);
    if(y<width-1)neighbors.push(u+width);
    for(const v of neighbors)if(!cells[v]&&dist[v]===-1){
      dist[v]=dist[u]+1;prev[v]=u;queue[back++]=v;
    }
  }
  if(dist[goal]===-1)return {cost:-1,path:[]};
  const path=[];
  for(let u=goal;u!==-1;u=prev[u])path.push(u);
  path.reverse();return {cost:dist[goal],path};
}
export function assertGridRoute(width,cells,route,cost) {
  const truth=bfs(width,cells);
  if(truth.cost!==cost)throw new Error('Wrong shortest cost: '+cost+' expected '+truth.cost);
  if(cost===-1){if(route.length!==0)throw new Error('Unreachable route must be empty');return true;}
  const n=width*width;
  if(route.length!==cost+1||route[0]!==0||route[route.length-1]!==n-1)
    throw new Error('Wrong route endpoints or length');
  const visited=new Set();
  for(let i=0;i<route.length;i++){
    const v=route[i];
    if(!Number.isInteger(v)||v<0||v>=n||cells[v]||visited.has(v))
      throw new Error('Blocked, repeated or out-of-bounds route cell');
    visited.add(v);
    if(i>0){
      const prev=route[i-1],dx=Math.abs(prev%width-v%width);
      const dy=Math.abs(Math.floor(prev/width)-Math.floor(v/width));
      if(dx+dy!==1)throw new Error('Disconnected route');
    }
  }
  return true;
}
export function rng32(seed) {
  let state=(seed|0)||0x12345678;
  return ()=>{
    state^=state<<13;state^=state>>>17;state^=state<<5;
    return (state>>>0)/4294967296;
  };
}
export function makeFixture(width,seed,updates=75) {
  const random=rng32(Math.imul(seed,11717)+width);
  const initial=new Uint8Array(width*width);
  for(let i=0;i<initial.length;i++)initial[i]=+(random()<0.14);
  for(let x=0;x<width;x++)initial[x]=0;
  for(let y=0;y<width;y++)initial[y*width+width-1]=0;
  const actual=initial.slice(),events=[];
  for(let k=0;k<updates;k++){
    const path=bfs(width,actual).path,onPath=new Set(path);
    const choices=[];const ty=k%10;
    for(let v=1;v<actual.length-1;v++){
      if(ty<6 && !actual[v]&&!onPath.has(v))choices.push(v);
      if(ty>=6&&ty<8&&onPath.has(v)&&!actual[v])choices.push(v);
      if(ty>=8&&actual[v])choices.push(v);
    }
    let blocked=ty<8?1:0;
    if(!choices.length) {
      for(let v=1;v<actual.length-1;v++)if(!actual[v])choices.push(v);
      blocked=1;
    }
    if(!choices.length)throw new Error('No toggle candidates');
    const vertex=choices[Math.floor(random()*choices.length)];
    events.push({vertex,blocked});
    actual[vertex]=blocked;
  }
  return {width,seed,initial,events};
}
export function validateTour(order,n) {
  if(order.length!==n||order[0]!==0)throw new Error('Tour dimension/start invalid');
  const used=new Set(order);
  if(used.size!==n||Math.min(...order)!==0||Math.max(...order)!==n-1)
    throw new Error('Tour permutation invalid');
  return true;
}
export function roundedTourCost(xy,order) {
  let sum=0;
  for(let i=0;i<order.length;i++){
    const a=order[i],b=order[(i+1)%order.length];
    sum+=Math.floor(Math.hypot(xy[2*a]-xy[2*b],xy[2*a+1]-xy[2*b+1])+0.5);
  }
  return sum;
}
