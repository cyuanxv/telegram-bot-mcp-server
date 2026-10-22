import {AccountPeerStore,accountPeerId,openAccountPeer,sealAccountPeer,type AccountPeer} from './account-peers';
import {Pool} from 'pg';
import {AccountDirectory,type AccountScope} from './account-directory';
import {openCredential,validateContext,VaultError} from './crypto';
import {loadVaultKeyring} from './keyring';
import {PgPoolDatabase} from '../delivery/pg-pool-adapter';
import {postgresConnectionConfig} from '../delivery/postgres-config';
type Env=Record<string,string|undefined>;
export type AccountOperation={operation:AccountScope['operations'][number];peer?:string};
type Resource={peers?:AccountPeerStore;directory:Pick<AccountDirectory,'loadActive'|'listActive'>;close:()=>Promise<void>};
type Options={env?:()=>Env;guard?:()=>void;open?:(env:Env,guard:()=>void)=>Promise<Resource>};
async function openStore(env:Env,guard:()=>void):Promise<Resource>{const pool=new Pool(postgresConnectionConfig(env));pool.on('error',()=>{});return {peers:new AccountPeerStore(new PgPoolDatabase(pool,{guard})),directory:new AccountDirectory(new PgPoolDatabase(pool,{guard})),close:()=>pool.end()}}
/** Caller retains lease through transport and checks it immediately before each business RPC. */
export async function openRuntimeAccount(alias:string,request:AccountOperation,options:Options={}){
 const env=options.env??(()=>process.env),snapshot={...env()};
 if(snapshot.TELEGRAM_MTPROTO_ENABLED!=='true'||snapshot.TELEGRAM_VAULT_ACCOUNTS_ENABLED!=='true')throw new VaultError('account_runtime_disabled');
 const ownerId=snapshot.TELEGRAM_VAULT_OWNER_ID!;validateContext({ownerId,alias,purpose:'mtproto_account'});
 const guard=()=>{options.guard?.();const now=env();if(Object.keys({...snapshot,...now}).filter(k=>k.startsWith('TELEGRAM_')).some(k=>snapshot[k]!==now[k]))throw new VaultError('configuration_changed')};
 let resource:Resource|undefined;
 try{
  guard();resource=await(options.open??openStore)(snapshot,guard);guard();
  const stored=structuredClone(await resource.directory.loadActive(ownerId,alias));guard();
  if(!stored||!stored.entry.active||stored.entry.alias!==alias)throw new VaultError('account_unavailable');
  const scope=stored.entry.scope;
  if(!scope.operations.includes(request.operation))throw new VaultError('account_scope_denied');
  if(['read_history','search','send_message'].includes(request.operation)&&(!request.peer||!scope.peers.includes(request.peer)))throw new VaultError('account_scope_denied');
  const ring=loadVaultKeyring(snapshot);
  let config;
  try{const secret=openCredential({ownerId,alias,purpose:'mtproto_account'},stored.envelope,ring.keys,Date.now());if(!('session' in secret)||secret.userId!==stored.entry.userId)throw new VaultError('account_identity_mismatch');config={apiId:secret.apiId,apiHash:secret.apiHash,session:secret.session}}finally{ring.dispose()}
  const assertCurrent=async()=>{
   guard();const latest=await resource!.directory.loadActive(ownerId,alias);guard();
   if(!latest||JSON.stringify(latest.entry)!==JSON.stringify(stored.entry)||latest.envelope.ciphertext!==stored.envelope.ciphertext||latest.envelope.tag!==stored.envelope.tag||latest.envelope.nonce!==stored.envelope.nonce)throw new VaultError('account_state_changed');
  };
  const cacheEnabled=snapshot.TELEGRAM_ACCOUNT_PEER_CACHE_ENABLED==='true';
  const peerContext=(peerId:string)=>({ownerId,alias,userId:stored.entry.userId,vaultRevision:stored.entry.vaultRevision,peerId});
  const loadPeer=async()=>{
   if(!cacheEnabled||!request.peer)return undefined;
   await assertCurrent();if(!resource!.peers)throw new VaultError('peer_store_unavailable');
   const sealed=await resource!.peers.load(peerContext(request.peer));await assertCurrent();if(!sealed)return undefined;
   const keys=loadVaultKeyring(snapshot);try{return openAccountPeer(peerContext(request.peer),sealed,keys.keys)}finally{keys.dispose()}
  };
  const savePeers=async(peers:AccountPeer[])=>{
   if(!cacheEnabled)return;
   if(request.operation!=='list_dialogs'||peers.length>200||!resource!.peers)throw new VaultError('peer_scope_denied');
   for(const peer of peers){const id=accountPeerId(peer);if(!scope.peers.includes(id))continue;
    await assertCurrent();const keys=loadVaultKeyring(snapshot);
    try{const sealed=sealAccountPeer(peerContext(id),peer,keys.keys,keys.activeKeyId);await resource!.peers.save(peerContext(id),sealed)}finally{keys.dispose()}
    await assertCurrent();
   }
  };
  let closing:Promise<void>|undefined;
  await assertCurrent();return {config,userId:stored.entry.userId,assertCurrent,loadPeer,savePeers,close:()=>closing??=(resource!.close())};
 }catch(e){try{await resource?.close()}catch{}if(e instanceof VaultError)throw e;throw new VaultError('account_runtime_unavailable')}
}

/** Metadata only, independently usable when MTProto transport is disabled. */
export async function listVaultAccountSummaries(options:Options={}){
 const env=options.env??(()=>process.env),snapshot={...env()};
 if(snapshot.TELEGRAM_VAULT_ACCOUNTS_ENABLED!=='true')return [];
 const ownerId=snapshot.TELEGRAM_VAULT_OWNER_ID!;validateContext({ownerId,alias:'accounts',purpose:'mtproto_account'});
 const guard=()=>{options.guard?.();const current=env();if(Object.keys({...snapshot,...current}).filter(k=>k.startsWith('TELEGRAM_')).some(k=>snapshot[k]!==current[k]))throw new VaultError('configuration_changed')};
 let resource:Resource|undefined;
 try{
  guard();resource=await(options.open??openStore)(snapshot,guard);guard();
  const entries=await resource.directory.listActive(ownerId);guard();
  const result=entries.map(entry=>({alias:entry.alias,configured:true,enabled:snapshot.TELEGRAM_MTPROTO_ENABLED==='true',source:'vault',user_id:entry.userId,revision:entry.revision,allowed_operations:entry.scope.operations,allowed_peers:entry.scope.peers,runtime_verified:false}));
  await resource.close();resource=undefined;guard();return result;
 }catch{throw new VaultError('account_inventory_unavailable')}
 finally{try{await resource?.close()}catch{}}
}
