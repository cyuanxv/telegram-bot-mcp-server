import {getChats} from '../config';
import {listRuntimeBots} from './runtime-bots';
type Env=Record<string,string|undefined>;
/** Metadata-only inventory. Every outbound request still resolves its own current credentials/scope. */
export async function workflowRegistry(env:()=>Env,signal?:AbortSignal){
 const snapshot={...env()};
 const guard=()=>{const current=env();if(signal?.aborted||Object.keys({...snapshot,...current}).filter(k=>k.startsWith('TELEGRAM_')).some(k=>snapshot[k]!==current[k]))throw Error('Workflow registry changed')};
 let bots:string[]=[];const chats=getChats(snapshot);
 const refresh=async()=>{guard();const rows=await listRuntimeBots({env,signal});guard();bots=rows.map(b=>b.alias)};
 await refresh();
 return {read:()=>{guard();return {bots:[...bots],chats:{...chats}}},refresh};
}
