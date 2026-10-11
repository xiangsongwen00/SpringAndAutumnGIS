/** Live priorities stay in the main thread, never in DEM payloads/Worker messages. */
const priorities=new WeakMap<AbortSignal,()=>number>();
export function bindTerrainTaskPriority(signal:AbortSignal,priority:()=>number):void{priorities.set(signal,priority);}
export function terrainTaskPriority(signal?:AbortSignal):number{return signal?priorities.get(signal)?.()??0:0;}
