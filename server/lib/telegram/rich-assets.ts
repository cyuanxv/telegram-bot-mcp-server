import {z} from 'zod';
import type {CompiledRich} from './rich-compiler.mjs';
type Env=Record<string,string|undefined>;
export function resolveRichMedia(compiled:CompiledRich,env:Env=process.env){
 for(const m of compiled.rich_message.media??[]){if(!m.media.media.startsWith('rich-ref:'))continue;
  const ref=m.media.media.slice(9);const registry=z.record(z.string(),z.object({bot_alias:z.literal('default'),type:z.enum(['photo','video','audio','voice_note']),file_id:z.string().regex(/^[A-Za-z0-9_-]{10,512}$/)}).strict()).parse(JSON.parse(env.TELEGRAM_RICH_MEDIA_REFS_JSON??'{}'));
  const v=registry[ref];if(!v||v.type!==m.media.type)throw Error('Unknown or mismatched Bot media reference');m.media.media=v.file_id;
 }
}
