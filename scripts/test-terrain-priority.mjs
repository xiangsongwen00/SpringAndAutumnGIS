import assert from 'node:assert/strict';
import * as THREE from 'three';
import {readFile} from 'node:fs/promises';
import {transform} from 'esbuild';
import {TerrainTileLayer,Ellipsoid,WebMercatorTilingScheme,FrameWorkBudget} from '../dist/spring-and-autumn-gis.es.js';
const e=Ellipsoid.WGS84,scheme=new WebMercatorTilingScheme(),key=id=>`${id.level}/${id.x}/${id.y}`,tick=()=>new Promise(r=>setImmediate(r));
const tile=(lon,lat,level)=>({level,x:Math.floor((lon+180)/360*2**level),y:Math.floor((1-Math.asinh(Math.tan(lat*Math.PI/180))/Math.PI)/2*2**level)});
const selected=(id,pixels=128,centre=1.8)=>({id,rectangle:scheme.rectangle(id),screenPixels:pixels,viewCenterDistance:centre});
const near=tile(103.43968,32.04231,14),far=tile(105.8,32.04,8),camera=lon=>e.cartographicToCartesian({longitude:lon,latitude:32.04231,height:9000});
const selection=[selected(far,4096,0),selected(near)];
function field(id,value=6000){const texture=new THREE.DataTexture(new Float32Array(9).fill(value),3,3,THREE.RedFormat,THREE.FloatType);return {id,texture,heights:texture.image.data,width:3,height:3,minimumHeight:value,maximumHeight:value};}
function controlled(options={}){const calls=[],requests=[];const layer=new TerrainTileLayer(e,{id:'priority-unit',minLevel:0,maxLevel:14,loadTile:(id,signal)=>new Promise(resolve=>{const request={id,signal,resolve:value=>resolve(field(id,value)),resolveData:resolve};calls.push(key(id));requests.push(request);})},{maxConcurrentRequests:1,maxCommitsPerFrame:1,...options});return {layer,calls,requests};}
function seed(layer,id={level:0,x:0,y:0},value=6000){const data=field(id,value),k=key(id);layer.records.set(k,{id,key:k,state:'ready',priority:0,lastUsedFrame:0,active:false,data,controller:null});layer.hasInitialCoverage=true;layer.coverageReady=true;return data;}
// Cold coverage is still safe, but NEAR coarse coverage wins over far low zoom.
const cold=controlled();cold.layer.update(selection,camera(103.43968));assert.equal(cold.calls[0],key({level:12,x:Math.floor(near.x/4),y:Math.floor(near.y/4)}));
cold.requests[0].resolve(6000);await tick();cold.layer.update(selection,camera(103.43968));assert.equal(cold.calls[1],key({level:6,x:Math.floor(far.x/4),y:Math.floor(far.y/4)}),'First viewport cover remains required; no isolated cold child');
cold.requests[1].resolve(6000);await tick();cold.layer.update(selection,camera(103.43968));assert.equal(cold.calls[2],key(near),'Near target is not held behind far lower-level detail');assert.equal(cold.layer.resolveTexture(near).sourceLevel,12);cold.layer.dispose();
// Existing parent: same full-detail target, even though far has higher SSE/lower z.
const direct=controlled();seed(direct.layer);direct.layer.update(selection,camera(103.43968));assert.equal(direct.calls[0],key(near));assert.deepEqual(selection.map(s=>s.id.level),[8,14],'Priority must not change LOD leaves');direct.layer.dispose();
const missingCalls=[],missing=new TerrainTileLayer(e,{id:'coarse-missing',minLevel:0,maxLevel:14,loadTile:async id=>{missingCalls.push(id.level);if(id.level<14)throw new Error('HTTP 404');return field(id,7000);}},{maxConcurrentRequests:1});
const one=[selected(near)];for(let i=0;i<8;i++){missing.update(one,camera(103.43968));await tick();}assert.deepEqual(missingCalls,[12,13,14]);assert.equal(missing.resolveTexture(near).sourceLevel,14,'Missing coarse service tiles must not freeze the patch');missing.dispose();
const old=controlled({requestPriority:'screen-error'});seed(old.layer);old.layer.update(selection,camera(103.43968));assert.equal(old.calls[0],key(far));old.layer.dispose();
// Coarse footprint centre is far away, but its visible rectangle contains the
// camera projection: it must still be treated as nearby, including the dateline.
const footprint=controlled();seed(footprint.layer);const broad=tile(103.43968,32.04231,5),medium=tile(106,32.04,12),footSelection=[selected(medium,4096,0),selected(broad,64,2)];
footprint.layer.update(footSelection,camera(103.43968));assert.equal(footprint.calls[0],key(broad));footprint.layer.dispose();
const date=controlled();seed(date.layer);const seam=tile(-179.9,32.04231,8),opposite=tile(150,32.04,8);date.layer.update([selected(opposite,4096,0),selected(seam)],camera(179.9));assert.equal(date.calls[0],key(seam));date.layer.dispose();
// Three nearby-detail opportunities are followed by missing coarse coverage.
const fair=controlled();fair.layer.hasInitialCoverage=true;fair.layer.coverageReady=true;fair.layer.refreshPriorityCamera(camera(103.43968));
for(let i=0;i<5;i++){const id={level:8,x:100+i,y:100};fair.layer.queueTile(id,i,'detail');}
const coverId={level:2,x:0,y:0};fair.layer.queueTile(coverId,100,'coverage');
assert.equal(fair.layer.chooseRequest().requestClass,'detail');assert.equal(fair.layer.chooseRequest().requestClass,'detail');assert.equal(fair.layer.chooseRequest().requestClass,'detail');assert.equal(fair.layer.chooseRequest().requestClass,'coverage');fair.layer.dispose();
// Upload re-ranks on camera movement even when selection reference is unchanged.
const budget=new FrameWorkBudget(4);budget.beginFrame(1);budget.spend(4);const uploads=controlled({workBudget:budget});seed(uploads.layer);
for(const id of [near,far])uploads.layer.records.set(key(id),{id,key:key(id),state:'pending',priority:0,lastUsedFrame:0,active:false,data:field(id,7800),controller:null});
uploads.layer.update(selection,camera(105.8));assert.equal(uploads.layer.stats.committed,0);
budget.beginFrame(2);uploads.layer.update(selection,camera(103.43968));assert.equal(uploads.layer.records.get(key(near)).state,'ready');assert.equal(uploads.layer.records.get(key(far)).state,'pending');uploads.layer.dispose();
// Occupied far DETAIL can yield one slot safely; late ignored-abort result dies.
const preempt=controlled();seed(preempt.layer);preempt.layer.update(selection,camera(105.8));assert.equal(preempt.calls[0],key(far));const obsolete=preempt.requests[0];
preempt.layer.update(selection,camera(103.43968));assert.equal(preempt.calls[1],key(near));assert.equal(obsolete.signal.aborted,true);assert.equal(preempt.layer.stats.preemptedRequests,1);
let released=0;const stale=field(far,10000);stale.texture.addEventListener('dispose',()=>released++);obsolete.resolveData(stale);await tick();
assert.equal(released,1);assert.equal(preempt.layer.records.get(key(far)).data,null,'Aborted far result must not publish');assert.equal(preempt.layer.resolveTexture(near).sourceLevel,0,'Trusted parent stays while near data loads');
preempt.requests[1].resolve(8000);await tick();preempt.layer.update(selection,camera(103.43968));assert.equal(preempt.layer.resolveTexture(near).sourceLevel,14);preempt.layer.dispose();
// Regional display commits a READY near cohort before an equally ready far one.
const region=controlled({regionalCoverage:true,maxCommitsPerFrame:10,commitBudgetMs:100});const root=seed(region.layer);region.layer.publishedKeys.add('0/0/0');region.layer.displayKeys.add('0/0/0');region.layer.displayedData.set('0/0/0',root);region.layer.displaySignatures.set('0/0/0',`${root.texture.uuid}/raw`);
for(const id of [near,far]){const parent={level:id.level-1,x:Math.floor(id.x/2),y:Math.floor(id.y/2)};seed(region.layer,parent,6500);seed(region.layer,id,8000);}
region.layer.update(selection,camera(103.43968));assert.equal(region.layer.resolveTexture(near).sourceLevel,14);assert.equal(region.layer.resolveTexture(far).sourceLevel,0,'Far ready region must not be first publication');region.layer.dispose();
// Shared DEM Worker queue uses LIVE priority while retaining FIFO for other clients.
const {code}=await transform(await readFile(new URL('../src/core/workers/SerialWorkerClient.ts',import.meta.url),'utf8'),{loader:'ts',format:'esm'});
const {SerialWorkerClient}=await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`),nativeWorker=globalThis.Worker;globalThis.Worker=class{};
try{const worker={postMessage(message){this.sent.push(message);},sent:[],terminate(){}},client=new SerialWorkerClient(()=>worker);let a=10,b=20;
 const p0=client.request({name:'running'}),p1=client.request({name:'old-far'},undefined,[],()=>a),p2=client.request({name:'new-near'},undefined,[],()=>b);b=-1;
 worker.onmessage({data:{id:worker.sent[0].id,result:0}});assert.equal(worker.sent[1].name,'new-near');worker.onmessage({data:{id:worker.sent[1].id,result:2}});worker.onmessage({data:{id:worker.sent[2].id,result:1}});await Promise.all([p0,p1,p2]);client.dispose();
 const fifoWorker={postMessage(m){this.sent.push(m);},sent:[],terminate(){}},fifo=new SerialWorkerClient(()=>fifoWorker);
 const promises=[fifo.request({name:'hold'}),fifo.request({name:'old-far'},undefined,[],()=>100),...Array.from({length:4},(_,i)=>fifo.request({name:`near-${i}`},undefined,[],()=>i))];
 for(let i=0;i<6;i++)fifoWorker.onmessage({data:{id:fifoWorker.sent[i].id,result:i}});
 assert.deepEqual(fifoWorker.sent.map(m=>m.name),['hold','near-0','near-1','near-2','old-far','near-3']);await Promise.all(promises);fifo.dispose();
}finally{globalThis.Worker=nativeWorker;}
console.log('Terrain near footprint ordering, unchanged LOD, cold parents, direct target, same-selection upload reprioritization, bounded preemption, regional display and live Worker priority passed.');
