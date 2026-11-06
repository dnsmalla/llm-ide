import { useSyncExternalStore } from "react";
import { getLiveRecording, subscribeLiveRecording } from "./live-status.ts";
export function LiveBanner({activeSection,onOpen}:{activeSection:string;onOpen():void}) {
 const r=useSyncExternalStore(subscribeLiveRecording,getLiveRecording,getLiveRecording);if(!r||activeSection==="live")return null;const since=new Date(r.startedAtMs).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"});
 return (<div className="sh-notice" role="status" data-testid="live-banner"><p><span aria-hidden="true" style={{color:"#d33"}}>● </span>Recording meeting captions since {since}. Caption text only, never audio.</p><button type="button" className="sh-button" onClick={onOpen}>Open Live</button></div>);
}
