import { Pool } from 'pg';
import { BusinessBackfill, backfillGuard } from '../lib/telegram/business-backfill';
import { PgPoolDatabase } from '../lib/telegram/delivery/pg-pool-adapter';
import { postgresConnectionConfig } from '../lib/telegram/delivery/postgres-config';
async function main(){
  const action=process.argv[2];
  if(!['plan','apply'].includes(action)){
    console.log('Business deletion repair: plan or apply. JSON stdin: {scope:{bot_alias,connection_id,chat_ids,after_sequence,through_sequence},expected_digest?}. Apply requires the reviewed digest and explicit operator approval. No migration, Telegram requests or automatic execution.');return;
  }
  let size=0;const parts:Buffer[]=[];
  for await(const chunk of process.stdin){const b=Buffer.from(chunk);size+=b.length;if(size>65536)throw Error('Input too large');parts.push(b);}
  const input=JSON.parse(Buffer.concat(parts).toString('utf8'));
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['scope','expected_digest'].includes(k))
    ||(action==='plan'&&input.expected_digest!==undefined)||(action==='apply'&&!/^[0-9a-f]{64}$/.test(input.expected_digest??'')))throw Error('Invalid repair input');
  const {scope,guard}=backfillGuard(input.scope,action==='apply');
  guard();const pool=new Pool(postgresConnectionConfig(process.env));pool.on('error',()=>{});
  try{
    const repair=new BusinessBackfill(new PgPoolDatabase(pool,{guard}),scope,guard);
    const result=action==='plan'?await repair.plan():await repair.apply(input.expected_digest);
    console.log(JSON.stringify(result));
  }finally{await pool.end();}
}
main().catch(()=>{console.error('{"error":"Business repair failed; verify scope, reviewed digest, flags and database access. An apply with unknown outcome may be retried using the same plan."}');process.exitCode=1;});
