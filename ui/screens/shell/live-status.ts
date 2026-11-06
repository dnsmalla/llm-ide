import { invokeHost } from "./host.ts";
export interface LiveRecording { sessionId:string; startedAtMs:number; platform:string|null }
let current:LiveRecording|null=null;const listeners=new Set<()=>void>();
export function getLiveRecording():LiveRecording|null{return current}
export function setLiveRecording(r:LiveRecording|null):void{current=r;for(const l of [...listeners])l()}
export function subscribeLiveRecording(l:()=>void):()=>void{listeners.add(l);return()=>{listeners.delete(l)}}
export async function syncLiveRecordingFromHost(invoke:(cmd:string)=>Promise<unknown>=(c)=>invokeHost<unknown>(c)):Promise<void>{let s:unknown;try{s=await invoke("capture_status")}catch{return}const r=s&&typeof s==="object"?s as Record<string,unknown>:{};if(r.recording===true&&typeof r.sessionId==="string")setLiveRecording({sessionId:r.sessionId.slice(0,40),startedAtMs:typeof r.startedAtMs==="number"?r.startedAtMs:Date.now(),platform:null});else if(r.recording===false)setLiveRecording(null)}
