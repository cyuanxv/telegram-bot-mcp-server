export type RichFile={id:string;filename:string;content_type:string;base64:string;sha256:string};
export type CompiledRich={rich_message:{html:string;media?:{id:string;media:{type:string;media:string}}[]};files:RichFile[];metrics:{characters:number;blocks:number;photos:number;media:number;buttons:number;attachment_bytes:number};block_order:string[]};
export function compileRich(input:unknown):CompiledRich;
export function checkRich(input:unknown):Promise<CompiledRich>;
export function richPreview(compiled:CompiledRich):Record<string,unknown>;
