import test from 'node:test';
import assert from 'node:assert/strict';
import {inboxEndpoint} from '../lib/telegram/inbox/control-policy.ts';
test('webhook uses explicit deployment origin and refuses URL credentials or paths',()=>{
 assert.equal(inboxEndpoint('reports',{TELEGRAM_PUBLIC_ORIGIN:'https://own.example.test'}),'https://own.example.test/api/telegram/webhook/reports');
 for(const origin of ['http://own.example.test','https://u:p@own.example.test','https://own.example.test/path','https://own.example.test/?x=y','https://own.example.test/#x'])assert.throws(()=>inboxEndpoint('reports',{TELEGRAM_PUBLIC_ORIGIN:origin}));
});
