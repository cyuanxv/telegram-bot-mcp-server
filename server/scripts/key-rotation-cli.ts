import {Pool} from 'pg';
import {KeyRotation,rotationScope} from '../lib/telegram/vault/key-rotation';
import {loadVaultKeyring} from '../lib/telegram/vault/keyring';
import {PgPoolDatabase} from '../lib/telegram/delivery/pg-pool-adapter';
import {postgresConnectionConfig} from '../lib/telegram/delivery/postgres-config';
async function main(){
 const action=process.argv[2];
 if(!['inspect','plan','apply'].includes(action)){console.log('Key rotation: inspect|plan|apply. JSON stdin: {aliases:[...],fromKeyId,toKeyId,expected_digest?}. Keys come only from server Secret configuration. No migrations or Telegram calls. Unknown apply outcome: inspect records before further action; never retry automatically.');return}
 let size=0;const parts:Buffer[]=[];
 for await(const chunk of process.stdin){const b=Buffer.from(chunk);size+=b.length;if(size>32768)throw Error();parts.push(b)}
 const input=JSON.parse(Buffer.concat(parts).toString('utf8'));
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['aliases','fromKeyId','toKeyId','expected_digest'].includes(k))||(action!=='apply'&&input.expected_digest!==undefined)||(action==='apply'&&!/^[0-9a-f]{64}$/.test(input.expected_digest??'')))throw Error();
 const snapshot={...process.env};const scope=rotationScope({ownerId:snapshot.TELEGRAM_VAULT_OWNER_ID,aliases:input.aliases,fromKeyId:input.fromKeyId,toKeyId:input.toKeyId});
 const guard=()=>{
  if(snapshot.TELEGRAM_VAULT_ROTATION_ENABLED!=='true'||scope.toKeyId!==snapshot.TELEGRAM_VAULT_KEY_ID||Object.keys({...snapshot,...process.env}).filter(k=>k.startsWith('TELEGRAM_')).some(k=>snapshot[k]!==process.env[k]))throw Error();
  if(action==='apply'&&(snapshot.TELEGRAM_VAULT_ROTATION_APPLY_ENABLED!=='true'||['TELEGRAM_VAULT_BOTS_ENABLED','TELEGRAM_BOT_ENROLLMENT_ENABLED','TELEGRAM_BOT_MANAGEMENT_ENABLED'].some(k=>snapshot[k]!=='false')))throw Error();
 };
 guard();const config=postgresConnectionConfig(snapshot),ring=action==='apply'?loadVaultKeyring(snapshot):undefined;
 let pool:Pool|undefined;
 try{pool=new Pool(config);pool.on('error',()=>{});const rotation=new KeyRotation(new PgPoolDatabase(pool,{guard}),scope,guard);console.log(JSON.stringify(action==='inspect'?await rotation.inspect():action==='plan'?await rotation.plan():await rotation.apply(input.expected_digest,ring!.keys)))}
 finally{ring?.dispose();await pool?.end()}
}
main().catch(()=>{console.error('{"error":"Key rotation failed or outcome unknown. Check approved scope, reviewed digest, maintenance flags and stored revisions before continuing. No automatic retry."}');process.exitCode=1});
