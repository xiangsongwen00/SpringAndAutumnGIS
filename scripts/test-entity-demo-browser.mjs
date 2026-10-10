import assert from 'node:assert/strict';
import {createServer} from 'vite';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const server=await createServer({root,configFile:join(root,'vite.config.ts'),server:{host:'127.0.0.1',port:0,strictPort:false},logLevel:'error'});
await server.listen();const base=`http://127.0.0.1:${server.httpServer.address().port}`;
const profile=await mkdtemp(join(tmpdir(),'sag-entity-demo-'));
const child=spawn(process.env.CHROME_PATH??'C:/Program Files/Google/Chrome/Application/chrome.exe',['--headless','--no-first-run','--disable-extensions','--window-size=1440,900',
 '--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-gpu-sandbox','--disable-background-networking','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'],{windowsHide:true,stdio:'ignore'});
let socket,launchError;child.on('error',error=>{launchError=error;});const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
try{
 let port;for(let i=0;i<100&&!port;i++){if(launchError)throw launchError;try{port=(await readFile(join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0];}catch{await pause(100);}}
 assert.ok(port,'Chrome did not launch');const page=(await(await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(p=>p.type==='page');
 socket=new WebSocket(page.webSocketDebuggerUrl);await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject;});
 const pending=new Map();let next=0;const external=[];
 const command=(method,params={})=>new Promise(resolve=>{const id=++next;pending.set(id,resolve);socket.send(JSON.stringify({id,method,params}));});
 socket.onmessage=({data})=>{const msg=JSON.parse(data);if(msg.id){pending.get(msg.id)?.(msg);pending.delete(msg.id);}else if(msg.method==='Fetch.requestPaused'){
   const url=new URL(msg.params.request.url);if(url.origin===base||['data:','blob:'].includes(url.protocol))void command('Fetch.continueRequest',{requestId:msg.params.requestId});
   else{external.push(url.hostname);void command('Fetch.failRequest',{requestId:msg.params.requestId,errorReason:'BlockedByClient'});}
 }};
 await command('Page.enable');await command('Fetch.enable',{patterns:[{urlPattern:'*'}]});
 await command('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:2,mobile:false});
 const evaluate=async expression=>{const result=await command('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});
   assert.ok(!result.result?.exceptionDetails, result.result?.exceptionDetails?.exception?.description??'Browser evaluation failed');return result.result?.result?.value;};
 const until=async(expression)=>{for(let i=0;i<300;i++){if(await evaluate(expression))return;await pause(100);}throw new Error('Root entity demo readiness timed out');};
 for(const terrain of [0,1]){
   await command('Page.navigate',{url:`${base}/index.html?entitySmoke=1&terrain=${terrain}`});
   await until('Boolean(window.__entityDemo)');
   await evaluate(`document.getElementById('entity-test').click()`);
   await until(`window.__entityDemo.entities.length===4&&['demo-point','demo-line','demo-polygon'].every(id=>window.__entityDemo.layer.getResourceState(id)?.state==='ready')`);
   assert.equal(await evaluate(`document.querySelector('#globe').querySelectorAll('canvas').length`),1);
   assert.equal(await evaluate(`document.querySelector('#business-layer-panel #geojson-test')!==null`),true);
   await evaluate(`document.getElementById('entity-heading').value='90';document.getElementById('entity-update').click();`);
   assert.equal(await evaluate(`window.__entityDemo.entities.getById('demo-point').symbol.heading`),90);
   await evaluate(`document.getElementById('entity-move').click();document.getElementById('entity-toggle').click();`);
   assert.equal(await evaluate(`window.__entityDemo.entities.getById('demo-point').visible`),false);
   await evaluate(`document.getElementById('entity-toggle').click();document.getElementById('entity-query-json').value='{"type":"polygon"}';document.getElementById('entity-query').click();`);
   assert.equal(await evaluate(`document.getElementById('entity-output').textContent.includes('demo-polygon')`),true);
   await evaluate(`document.getElementById('entity-clear').click();window.__entityDemo.engine.flyTo({longitude:106.55,latitude:29.61,altitude:12000,pitch:-55,heading:37,duration:0});document.getElementById('entity-click-add').checked=true;document.getElementById('entity-icon-enabled').checked=false;document.getElementById('entity-color').value='#ff00ff';document.getElementById('entity-text').value='';`);
   await until(`window.__entityDemo.engine.imagery.stats.ready>0${terrain?'&&window.__entityDemo.engine.terrain.stats.ready>0':''}`);
   await pause(600);
   const report=await evaluate(`(async()=>{
     const h=window.__entityDemo,c=h.engine.renderer.domElement,r=c.getBoundingClientRect();const s={x:r.width*.35,y:r.height*.65};
     const before=h.engine.pickPositionDetailed(s);const oldHeight=document.getElementById('entity-height').value;
     c.dispatchEvent(new PointerEvent('pointerdown',{button:0,pointerId:42,clientX:r.left+s.x,clientY:r.top+s.y}));
     c.dispatchEvent(new PointerEvent('pointerup',{button:0,pointerId:42,clientX:r.left+s.x,clientY:r.top+s.y}));
     await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
     const entity=h.entities.values[0],world=h.engine.coordinates.geodeticToWorld({longitude:entity.position[0],latitude:entity.position[1],height:entity.position[2]}).project(h.engine.camera);
     const error=Math.hypot((world.x+1)*r.width/2-s.x,(1-world.y)*r.height/2-s.y),gl=c.getContext('webgl2'),pixel=new Uint8Array(4);
     gl.readPixels(Math.floor(s.x*gl.drawingBufferWidth/r.width),Math.floor((r.height-s.y)*gl.drawingBufferHeight/r.height),1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);
     return {oldHeight,source:before?.source,error,pixel:[...pixel],position:entity.position,canvasCount:document.querySelectorAll('#globe canvas').length};
   })()`);
   assert.equal(report.source,'rendered-surface');assert.ok(report.error<.05,`Placed point drift ${report.error}px`);assert.equal(report.canvasCount,1);
   assert.ok(report.pixel[0]>180&&report.pixel[1]<100&&report.pixel[2]>180,`Clicked ground marker missing at its GPU pixel: ${report.pixel}`);
   const resize=await evaluate(`(async()=>{const c=window.__entityDemo.engine.renderer.domElement;c.style.transform='translate(35px,20px)';const r=c.getBoundingClientRect();
     const p=window.__entityDemo.engine.pickPositionDetailed({x:r.width*.42,y:r.height*.62});c.style.transform='';return p.errorPixels;})()`);
   assert.ok(resize<.001,'Canvas-offset CSS coordinates drifted');
   const drawing=await evaluate(`(async()=>{
     const h=window.__entityDemo,c=h.engine.renderer.domElement,r=c.getBoundingClientRect(),click=(x,y)=>{
       c.dispatchEvent(new PointerEvent('pointerdown',{button:0,pointerId:43,clientX:r.left+x*r.width,clientY:r.top+y*r.height}));
       c.dispatchEvent(new PointerEvent('pointerup',{button:0,pointerId:43,clientX:r.left+x*r.width,clientY:r.top+y*r.height}));
     };
     const before=h.entities.length;document.getElementById('entity-draw-line').click();const paused=!h.engine.controls.enabled;
     click(.25,.58);click(.35,.65);document.getElementById('entity-draw-undo').click();const undo=h.draw.state.vertexCount;
     click(.35,.65);document.getElementById('entity-draw-finish').click();const line=h.entities.getById(h.draw.state.lastEntityId);
     document.getElementById('entity-draw-polygon').click();click(.25,.55);click(.36,.60);click(.27,.70);document.getElementById('entity-draw-finish').click();const polygon=h.entities.getById(h.draw.state.lastEntityId);
     await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
     const center=polygon.positions.reduce((sum,p)=>sum.map((v,i)=>v+p[i]/polygon.positions.length),[0,0,0]),world=h.engine.coordinates.geodeticToWorld({longitude:center[0],latitude:center[1],height:center[2]}).project(h.engine.camera),gl=c.getContext('webgl2'),rgba=new Uint8Array(4);
     gl.readPixels(Math.floor((world.x+1)*gl.drawingBufferWidth/2),Math.floor((world.y+1)*gl.drawingBufferHeight/2),1,1,gl.RGBA,gl.UNSIGNED_BYTE,rgba);
     document.getElementById('entity-draw-line').click();click(.22,.57);document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
     return {paused,undo,lineType:line?.type,lineVertices:line?.positions.length,polygonType:polygon?.type,polygonVertices:polygon?.positions.length,
       restored:h.engine.controls.enabled,active:h.draw.isActive,added:h.entities.length-before,filledPixel:[...rgba]};
   })()`);
   const {filledPixel,...drawState}=drawing;
   assert.deepEqual(drawState,{paused:true,undo:1,lineType:'polyline',lineVertices:2,polygonType:'polygon',polygonVertices:3,restored:true,active:false,added:2});
   assert.ok(filledPixel[0]>180&&filledPixel[1]<100&&filledPixel[2]>180,`Drawn polygon fill not visible: ${filledPixel}`);
   if(terrain){
     const occlusion=await evaluate(`(async()=>{
       const h=window.__entityDemo,c=h.engine.renderer.domElement,r=c.getBoundingClientRect();h.entities.clear();
       const ground=h.engine.pickPositionDetailed({x:r.width*.35,y:r.height*.65}).position;
       h.entities.add({id:'occluded',type:'point',position:[ground.longitude,ground.latitude,ground.height-300],symbol:{color:'#ff00ff',size:30,outlineWidth:0,occlusion:'depth'},label:{text:'置顶文字',fontSize:20,color:'#ffffff',offset:[0,-40],occlusion:'overlay'}});
       const read=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>{const gl=c.getContext('webgl2'),p=h.engine.coordinates.geodeticToWorld({longitude:ground.longitude,latitude:ground.latitude,height:ground.height-300}).project(h.engine.camera),x=(p.x+1)*r.width/2,y=(1-p.y)*r.height/2,rgba=new Uint8Array(4);
         gl.readPixels(Math.floor(x*gl.drawingBufferWidth/r.width),Math.floor((r.height-y)*gl.drawingBufferHeight/r.height),1,1,gl.RGBA,gl.UNSIGNED_BYTE,rgba);resolve([...rgba]);})));
       const normal=await read();h.entities.update('occluded',{symbol:{occlusion:'overlay'}});const top=await read();
       const original=h.entities.getById('occluded').position[2];
       h.entities.clear();h.entities.add({id:'backside',type:'point',position:[ground.longitude>0?ground.longitude-180:ground.longitude+180,-ground.latitude,100],symbol:{color:'#ff00ff',size:100,occlusion:'overlay'}});
       await read();return {normal,top,heightUnchanged:original===ground.height-300,backsideVisible:h.layer.object3d.children.some(group=>group.visible)};
     })()`);
     assert.ok(!(occlusion.normal[0]>180&&occlusion.normal[2]>180&&occlusion.normal[1]<100),'Normal-depth point must be terrain occluded');
     assert.ok(occlusion.top[0]>180&&occlusion.top[2]>180&&occlusion.top[1]<100,'Overlay point must show above terrain');
     assert.equal(occlusion.heightUnchanged,true);assert.equal(occlusion.backsideVisible,false);
   }
   await evaluate(`document.getElementById('entity-close').click()`);assert.equal(await evaluate(`document.getElementById('entity-panel').hidden`),true);
   console.log(`Root index.html: objects/material controls, one canvas, terrain=${terrain}, clicked point reprojection ${report.error.toFixed(6)}px passed.`);
 }
 assert.deepEqual(external,[],'Regression must not request external tiles/services');
 console.log('Root source demo browser regression passed; no real map/token service used.');
}finally{
 socket?.close();if(child.exitCode===null&&!launchError){const exited=new Promise(resolve=>child.once('exit',resolve));child.kill();await exited;}
 await server.close();await rm(profile,{recursive:true,force:true,maxRetries:8,retryDelay:250});
}
