import geodesic from 'geographiclib-geodesic';
import type { EntityPosition, EntitySnapshot } from './EntityTypes';
import type { EntityCollection } from './EntityCollection';
import type { EntityDrawingController, EntityDrawState } from './EntityDrawingController';

const geod = geodesic.Geodesic.WGS84;
export type DistanceMeasurement = Readonly<{ kind:'distance'; method:'wgs84-geodesic'; metres:number; segments:readonly number[] }>;
export type AreaMeasurement = Readonly<{ kind:'area'; method:'wgs84-geodesic'; squareMetres:number; perimeterMetres:number }>;
export type MeasurementResult = DistanceMeasurement | AreaMeasurement;

function positions(input:readonly EntityPosition[], minimum:number): void {
  if(!Array.isArray(input)||input.length<minimum||input.length>10000)throw new Error(`Measurement requires ${minimum}..10000 positions.`);
  for(const p of input)if(!Array.isArray(p)||p.length<2||!p.every(Number.isFinite)||Math.abs(p[0]!)>180||Math.abs(p[1]!)>90)
    throw new Error('Measurement requires finite WGS84 longitude/latitude positions.');
}
/** Horizontal ellipsoidal distance. Heights/DEM do not change this result. */
export function measureDistance(input:readonly EntityPosition[]):DistanceMeasurement {
  positions(input,2);
  const segments=input.slice(1).map((p,i)=>geod.Inverse(input[i]![1],input[i]![0],p[1],p[0]).s12!);
  return Object.freeze({kind:'distance',method:'wgs84-geodesic',metres:segments.reduce((a,b)=>a+b,0),segments:Object.freeze(segments)});
}
/** Smaller-region ellipsoidal polygon area. Valid non-self-intersecting rings and contained holes required. */
export function measureArea(input:readonly EntityPosition[],holes:readonly (readonly EntityPosition[])[]=[]):AreaMeasurement {
  const ring=(points:readonly EntityPosition[])=>{
    positions(points,3);const polygon=geod.Polygon(false);
    for(const p of points)polygon.AddPoint(p[1],p[0]);
    const result=polygon.Compute(false,true);return {area:Math.abs(result.area!),perimeter:result.perimeter};
  };
  const outer=ring(input);let squareMetres=outer.area,perimeterMetres=outer.perimeter;
  for(const hole of holes){const value=ring(hole);squareMetres-=value.area;perimeterMetres+=value.perimeter;}
  if(squareMetres<0)throw new Error('Hole area exceeds outer area.');
  return Object.freeze({kind:'area',method:'wgs84-geodesic',squareMetres,perimeterMetres});
}
export type MeasurementState = Readonly<{ active:boolean; kind:'distance'|'area'|null; vertexCount:number;
  result:MeasurementResult|null; entityId:string|null; error:string|null }>;

/** Shares drawing interaction and entity lifecycle; no second picking/navigation system. */
export class MeasurementController {
  private kind:'distance'|'area'|null=null;
  private entityId:string|null=null;
  private result:MeasurementResult|null=null;
  private error:string|null=null;
  private serial=0;
  private vertexCount=0;
  private readonly owned=new Set<string>();
  private disposed=false;
  private readonly listeners=new Set<(state:MeasurementState)=>void>();
  private readonly unsubscribe:()=>void;
  constructor(private readonly draw:EntityDrawingController,private readonly entities:EntityCollection){
    this.unsubscribe=draw.onChange(state=>this.changed(state));
  }
  get state():MeasurementState{return Object.freeze({active:this.kind!==null&&this.draw.isActive,kind:this.kind,
    vertexCount:this.kind?this.draw.state.vertexCount:this.vertexCount,result:this.result,entityId:this.entityId,error:this.error});}
  start(kind:'distance'|'area'):MeasurementState {
    this.assertAlive();if(!['distance','area'].includes(kind))throw new Error('Unknown measurement kind.');
    this.cancel();this.draw.cancel();let id:string;do{id=`measure-${kind}-${++this.serial}`;}while(this.entities.has(id));
    this.kind=kind;this.entityId=id;this.result=null;this.error=null;this.vertexCount=0;
    try{this.draw.start({id,type:kind==='distance'?'polyline':'polygon',name:kind==='distance'?'路程测量':'面积测量',
      properties:{measurement:kind},heightReference:'clamp-to-ground',groundOffset:.5,
      symbol:kind==='distance'?{color:'#ffcc66',width:3,occlusion:'overlay'}:{color:'#ffcc66',opacity:.3,outlineWidth:2,occlusion:'overlay'}});}
    catch(error){this.kind=null;this.entityId=null;throw error;}
    this.emit();return this.state;
  }
  finish():MeasurementResult {this.assertAlive();if(!this.kind)throw new Error('No active measurement.');this.draw.finish();if(!this.result)throw new Error(this.error??'Measurement failed.');return this.result;}
  undo():void{this.assertAlive();if(this.kind)this.draw.undo();}
  cancel():void{if(this.disposed)return;if(this.kind){this.kind=null;this.draw.cancel();this.entityId=null;this.result=null;this.error=null;this.vertexCount=0;this.emit();}}
  clear():void{this.assertAlive();this.cancel();for(const id of this.owned)this.entities.remove(id);this.owned.clear();this.result=null;this.entityId=null;this.vertexCount=0;this.emit();}
  onChange(listener:(state:MeasurementState)=>void):()=>void{this.assertAlive();this.listeners.add(listener);return()=>this.listeners.delete(listener);}
  dispose():void{if(this.disposed)return;this.cancel();this.disposed=true;this.unsubscribe();this.listeners.clear();}
  private changed(state:EntityDrawState):void {
    if(!this.kind)return;
    if(state.active&&state.type!==(this.kind==='distance'?'polyline':'polygon')){this.kind=null;this.entityId=null;this.result=null;this.emit();return;}
    if(!state.active){
      if(state.lastEntityId===this.entityId){
        const value=this.entities.getById(state.lastEntityId!)!;
        try{this.result=this.compute(value);this.vertexCount='positions' in value?value.positions.length:0;this.owned.add(value.id);
          const text=this.result.kind==='distance'?`${(this.result.metres/1000).toFixed(3)} km`:`${(this.result.squareMetres/1e6).toFixed(4)} km²`;
          this.entities.update(value.id,{properties:{...value.properties,measurementResult:this.result},label:{text,occlusion:'overlay',color:'#ffcc66'}});
        }catch(error){this.error=error instanceof Error?error.message:'Measurement failed.';}
      }else{this.result=null;this.entityId=null;}
      this.kind=null;
    }else if(state.positions.length>=(this.kind==='distance'?2:3)){
      try{this.result=this.kind==='distance'?measureDistance(state.positions):measureArea(state.positions);this.error=null;}catch(error){this.error=String(error);}
    }else this.result=null;
    this.emit();
  }
  private compute(value:EntitySnapshot):MeasurementResult{if(value.type==='polyline')return measureDistance(value.positions);if(value.type==='polygon')return measureArea(value.positions,value.holes);throw new Error('Invalid measurement geometry.');}
  private emit():void{for(const listener of [...this.listeners])try{listener(this.state);}catch{console.warn('[Measurement] Listener failed.');}}
  private assertAlive():void{if(this.disposed)throw new Error('Measurement controller disposed.');}
}
