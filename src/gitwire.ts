import type { IncomingMessage, ServerResponse } from 'node:http';
import { ZERO_OID, decodePktLinesPrefix, parseCommit, parseTag, readPack, sidebandPackets, writePack, type GitObject } from './objects.ts';
import { Forge, type Repo } from './store.ts';
import { readBody, sendBuf, sendJson } from './wire.ts';

const AGENT = 'github-core-clone/1.0';
const V2_ADVERTISEMENT = frame(['version 2\n', `agent=${AGENT}\n`, 'ls-refs=unborn\n', 'fetch=shallow filter\n', 'object-format=sha1\n', 'flush']);
function queryService(search:string):string|null{for(const part of search.split('&')){const at=part.indexOf('=');if(decodeURIComponent(at<0?part:part.slice(0,at))==='service')return decodeURIComponent(at<0?'':part.slice(at+1).replace(/\+/g,' '));}return null;}

function frame(parts: readonly (string | 'flush' | 'delim')[]): Buffer {
  const strings: string[] = [];
  const buffers: Buffer[] = [];
  const flush = (): void => { if (strings.length) { buffers.push(Buffer.from(strings.join(''), 'utf8')); strings.length = 0; } };
  for (const part of parts) {
    if (part === 'flush' || part === 'delim') { flush(); buffers.push(Buffer.from(part === 'flush' ? '0000' : '0001', 'ascii')); }
    else strings.push(`${(Buffer.byteLength(part, 'utf8') + 4).toString(16).padStart(4, '0')}${part}`);
  }
  flush();
  return Buffer.concat(buffers);
}

/** One pkt-line frame as a string: 4 hex digits + payload. */
function pktLine(text: string): string {
  return `${(Buffer.byteLength(text, 'utf8') + 4).toString(16).padStart(4, '0')}${text}`;
}

function v0Advertisement(repo: Repo, service: string): Buffer {
  const key = `${repo.version}:${service}`;
  const cached = repo.advCache.get(key); if (cached) return cached;
  const upload = 'side-band-64k ofs-delta thin-pack multi_ack shallow symref=HEAD:refs/heads/main agent=' + AGENT;
  const receive = 'report-status side-band-64k delete-refs ofs-delta symref=HEAD:refs/heads/main agent=' + AGENT;
  const caps = service === 'git-upload-pack' ? upload : receive;
  // The refs sorted by name, exactly like Forge.allRefs (which needs no `this`).
  const refs = [...repo.refs].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  // One string, one Buffer.from: the advertisement is rebuilt on every push
  // (the version bump clears the cache), so the generic frame()'s per-part
  // Buffer.from + Buffer.concat is pure overhead here. The bytes are
  // identical to frame()'s output by construction (same pkt-line framing,
  // same flush markers, same cap placement).
  let out = `${pktLine(`# service=${service}\n`)}0000`;
  if (!refs.length) {
    out += pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`);
  } else {
    const headRef = `refs/heads/${repo.defaultBranch}`;
    const head = repo.refs.get(headRef);
    if (head) out += pktLine(`${head} HEAD\0${caps}\n`);
    refs.forEach(([name, oid], i) => {
      out += pktLine(`${oid} ${name}${i === 0 && !head ? `\0${caps}` : ''}\n`);
      const obj = repo.objects.get(oid);
      if (obj?.type === 'tag') {
        const peeled = parseTag(obj.data).object;
        if (peeled) out += pktLine(`${peeled} ${name}^{}\n`);
      }
    });
  }
  out += '0000';
  const buf = Buffer.from(out, 'utf8');
  repo.advCache.set(key, buf);
  return buf;
}

function lsRefs(repo: Repo, args: string[]): Buffer {
  const key = `${repo.version}:${args.join('\n')}`, hit = repo.lsRefsCache.get(key); if (hit) return hit;
  const lines: string[] = [], prefixes = args.filter((x) => x.startsWith('ref-prefix ')).map((x) => x.slice(11));
  const head = `refs/heads/${repo.defaultBranch}`, tip = repo.refs.get(head);
  if (!prefixes.length) {
    if (tip) lines.push(`${tip} HEAD symref-target:${head}\n`);
    else if (args.includes('unborn')) lines.push(`unborn HEAD symref-target:${head}\n`);
  }
  for (const [name, oid] of [...repo.refs].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (prefixes.length && !prefixes.some((p) => name.startsWith(p))) continue;
    let line = `${oid} ${name}`; if (args.includes('symrefs') && name === head) line += ` symref-target:${head}`;
    if (args.includes('peel')) { const peeled = Forge.prototype.peelRef.call({} as Forge, repo, oid); if (peeled) line += ` peeled:${peeled}`; }
    lines.push(`${line}\n`);
  }
  const out = frame([...lines, 'flush']); repo.lsRefsCache.set(key, out); return out;
}

interface Plan { wants:string[]; haves:string[]; shallow:string[]; depth:number|null; deepenSince:number|null; deepenNot:string[]; thinPack:boolean; noProgress:boolean; filter:string }
function parseArgs(args:string[]):Plan {
  const p:Plan={wants:[],haves:[],shallow:[],depth:null, deepenSince:null,deepenNot:[],thinPack:false,noProgress:false,filter:''};
  for(const a of args){if(a.startsWith('want '))p.wants.push(a.slice(5));else if(a.startsWith('have '))p.haves.push(a.slice(5));else if(a.startsWith('shallow '))p.shallow.push(a.slice(8));else if(a.startsWith('deepen '))p.depth=Number.parseInt(a.slice(7),10);else if(a.startsWith('deepen-since '))p.deepenSince=Date.parse(a.slice(13))/1000;else if(a.startsWith('deepen-not '))p.deepenNot.push(a.slice(11));else if(a==='thin-pack')p.thinPack=true;else if(a==='no-progress')p.noProgress=true;else if(a.startsWith('filter '))p.filter=a.slice(7);}
  return p;
}

function fetchPlan(forge:Forge,repo:Repo,p:Plan):{objects:Map<string,GitObject>;shallow:string[];unshallow:string[]} {
  const tips:string[]=[], tags=new Map<string,GitObject>();
  for(const want of p.wants){const o=repo.objects.get(want);if(o?.type==='tag'){tags.set(want,o);const peeled=forge.peelRef(repo,want);if(peeled)tips.push(peeled);}else if(o?.type==='commit')tips.push(want);}
  const parentsOf=(oid:string):string[]=>{const cached=repo.parentsCache.get(oid);if(cached)return cached;const obj=repo.objects.get(oid);if(!obj||obj.type!=='commit')return[];const ps=parseCommit(obj.data).parents;repo.parentsCache.set(oid,ps);return ps;};
  const treeOf=(oid:string):string|undefined=>{const cached=repo.treeCache.get(oid);if(cached)return cached;const obj=repo.objects.get(oid);if(!obj||obj.type!=='commit')return undefined;const t=parseCommit(obj.data).tree;repo.treeCache.set(oid,t);return t;};
  const generations=new Map<string,number>(), queue=tips.map((x)=>[x,0] as [string,number]);
  while(queue.length){const [oid,g]=queue.shift()!;if((generations.get(oid)??Infinity)<=g)continue;const obj=repo.objects.get(oid);if(obj?.type!=='commit')continue;generations.set(oid,g);if(p.depth!==null&&g+1>=p.depth)continue;for(const parent of parentsOf(oid))queue.push([parent,g+1]);}
  const commits=new Set(generations.keys()), shallow:string[]=[];
  if(p.depth!==null)for(const [oid,g] of generations)if(g===p.depth-1&&parentsOf(oid).length>0)shallow.push(oid);
  const objects=new Map<string,GitObject>(tags);
  for(const oid of commits){const obj=repo.objects.get(oid);if(!obj)continue;objects.set(oid,obj);const tree=treeOf(oid);if(tree)for(const id of forge.reachable(repo,[tree])){const child=repo.objects.get(id);if(child)objects.set(id,child);}}
  const held=new Set<string>();
  for(const ref of p.deepenNot){const id=repo.refs.get(ref);if(id)for(const item of forge.reachable(repo,[id]))held.add(item);}
  if(p.haves.length) { const stop=new Set(p.shallow), q=[...p.haves], seen=new Set<string>(); while(q.length){const id=q.shift()!,obj=repo.objects.get(id);if(!obj)continue;if(obj.type==='commit'){if(seen.has(id))continue;seen.add(id);held.add(id);const tree=treeOf(id);if(tree)for(const item of forge.reachable(repo,[tree]))held.add(item);if(!stop.has(id))q.push(...parentsOf(id));}else if(obj.type==='tag'){held.add(id);q.push(parseTag(obj.data).object);}else held.add(id);}}
  for(const id of held){objects.delete(id);commits.delete(id);}
  const shallowOut=shallow.filter((id)=>commits.has(id));
  const unshallow=p.shallow.filter((id)=>parentsOf(id).length>0&&parentsOf(id).every((parent)=>objects.has(parent)));
  return {objects,shallow:shallowOut,unshallow};
}

function fetchResponse(forge:Forge,repo:Repo,args:string[],v2:boolean,cacheKey?:string):Buffer {
  const p=parseArgs(args), key=cacheKey??`${repo.version}:${JSON.stringify({wants:p.wants,haves:p.haves,shallow:p.shallow,depth:p.depth,deepenSince:p.deepenSince,deepenNot:p.deepenNot,thinPack:p.thinPack,noProgress:p.noProgress,filter:p.filter,command:v2?'fetch':'fetch-v0'})}`;
  const hit=repo.fetchCache.get(key);if(hit)return hit;
  const {objects,shallow,unshallow}=fetchPlan(forge,repo,p), chunks:Buffer[]=[];
  if(v2){
    if(p.haves.length)chunks.push(frame(['acknowledgments\n',...p.haves.filter((x)=>repo.objects.has(x)).map((x)=>`ACK ${x}\n`),'ready\n','delim']));
    if(shallow.length||unshallow.length)chunks.push(frame(['shallow-info\n',...shallow.map((x)=>`shallow ${x}\n`),...unshallow.map((x)=>`unshallow ${x}\n`),'delim']));
    const values=[...objects.values()];if(values.length)chunks.push(frame(['packfile\n']),sidebandPackets(writePack(values)));
  } else {
    const acks=p.haves.filter((x)=>repo.objects.has(x)).map((x)=>`ACK ${x}\n`);chunks.push(frame(acks.length?acks:['NAK\n']));
    chunks.push(frame([...shallow.map((x)=>`shallow ${x}\n`),...unshallow.map((x)=>`unshallow ${x}\n`)]));
    if(objects.size)chunks.push(sidebandPackets(writePack(objects.values())));
  }
  chunks.push(Buffer.from('0000'));const out=Buffer.concat(chunks);repo.fetchCache.set(key,out);return out;
}

export async function handleGitwire(req:IncomingMessage,res:ServerResponse,forge:Forge,repo:Repo,tail:string[],search=''):Promise<boolean> {
  const service=tail[0];
  if(tail.length===2&&tail[0]==='info'&&tail[1]==='refs'){
    const svc=queryService(search);
    if(svc==='git-upload-pack'&&req.headers['git-protocol']==='version=2')sendBuf(res,200,V2_ADVERTISEMENT,'application/x-git-upload-pack-advertisement');
    else if(svc==='git-upload-pack'||svc==='git-receive-pack')sendBuf(res,200,v0Advertisement(repo,svc),svc==='git-upload-pack'?'application/x-git-upload-pack-advertisement':'application/x-git-receive-pack-advertisement');
    else sendJson(res,404,{message:'Not Found'});return true;
  }
  if(tail.length!==1||req.method!=='POST'||(service!=='git-upload-pack'&&service!=='git-receive-pack'))return false;
  const body=await readBody(req);
  if(service==='git-upload-pack'){
    const rawKey=`${repo.version}:fetch:${body.toString('latin1')}`;
    const hit=repo.fetchCache.get(rawKey);
    if(hit){sendBuf(res,200,hit,'application/x-git-upload-pack-result');return true;}
    // Fast path: a fetch response is a pure function of (repo version, raw request bytes).
    // Identical bytes answer from the cache without decoding pkt-lines or parsing args.
    // latin1 is a byte-exact string encoding, so distinct bodies never collide.
    // (ls-refs bodies can never match a fetch body, so this lookup is harmless for them.)
    const packets=decodePktLinesPrefix(body).packets;
    const firstData=packets.find((x)=>x.kind==='data');
    if(firstData===undefined||!firstData.payload.toString('utf8').startsWith('command=')){
      // Protocol v0 fetch: want/have/shallow/deepen lines, no command= framing.
      // (The v2 path below handles command=ls-refs / command=fetch.)
      const args:string[]=[];
      for(const packet of packets){
        if(packet.kind!=='data')continue;
        const line=packet.payload.toString('utf8').trim();
        const nul=line.indexOf('\0');
        const clean=(nul<0?line:line.slice(0,nul)).trim();
        if(clean==='done')break;
        // A v0 want line carries capabilities after the OID, space-separated
        // ("want <oid> side-band-64k thin-pack ..."): the OID is the first token.
        if(clean.startsWith('want '))args.push(`want ${clean.slice(5).split(/\s/)[0]}`);
        else if(clean.startsWith('have ')||clean.startsWith('shallow ')||clean.startsWith('deepen ')||clean.startsWith('deepen-since ')||clean.startsWith('deepen-not ')||clean==='thin-pack'||clean==='no-progress'||clean.startsWith('filter '))args.push(clean);
      }
      sendBuf(res,200,fetchResponse(forge,repo,args,false,rawKey),'application/x-git-upload-pack-result');
      return true;
    }
    let command='',after=false;const args:string[]=[];
    for(const packet of packets){if(packet.kind==='delim'){after=true;continue;}if(packet.kind==='data'){const s=packet.payload.toString().trim();if(!command&&s.startsWith('command='))command=s.slice(8);else if(after)args.push(s);}}
    if(command==='ls-refs')sendBuf(res,200,lsRefs(repo,args),'application/x-git-upload-pack-result');
    else if(command==='fetch')sendBuf(res,200,fetchResponse(forge,repo,args,true,rawKey),'application/x-git-upload-pack-result');
    else sendJson(res,400,{message:`unsupported command ${command}`});return true;
  }
  const decoded=decodePktLinesPrefix(body), commands:{old:string;next:string;ref:string}[]=[];
  for(const packet of decoded.packets)if(packet.kind==='data'){const s=packet.payload.toString(),nul=s.indexOf('\0'),m=/^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)/.exec((nul<0?s:s.slice(0,nul)).trim());if(m)commands.push({old:m[1]!,next:m[2]!,ref:m[3]!});}
  const pack=body.subarray(decoded.consumed);let unpackOk=false;
  if(pack.length>=12&&pack.toString('ascii',0,4)==='PACK')try{const parsed=readPack(pack,{resolveBase:(id)=>repo.objects.get(id)});if(!parsed.checksumOk)throw new Error('pack checksum mismatch');forge.ingestObjects(repo,parsed.objects);unpackOk=true;}catch{unpackOk=false;}
  else if(commands.every((c)=>c.next===ZERO_OID))unpackOk=true;
  const report:string[]=[];
  for(const c of commands){if(!unpackOk&&c.next!==ZERO_OID){report.push(`ng ${c.ref} unpack failed`);continue;}const old=repo.refs.get(c.ref);if(c.next===ZERO_OID){if(old===undefined)report.push(`ng ${c.ref} no such ref`);else{forge.deleteRef(repo,c.ref);report.push(`ok ${c.ref}`);}continue;}const obj=repo.objects.get(c.next);if(!obj){report.push(`ng ${c.ref} object not found`);continue;}if(old===undefined||old===c.next){forge.setRef(repo,c.ref,c.next);report.push(`ok ${c.ref}`);continue;}const nextCommit=obj.type==='tag'?forge.peelRef(repo,c.next)??c.next:c.next, oldObj=repo.objects.get(old),oldCommit=oldObj?.type==='tag'?forge.peelRef(repo,old)??old:old;if(forge.isAncestor(repo,oldCommit,nextCommit)) {forge.setRef(repo,c.ref,c.next);report.push(`ok ${c.ref}`);}else report.push(`ng ${c.ref} non-fast-forward`);}
  const text=`unpack ${unpackOk?'ok':'error'}\n${report.map((x)=>x+'\n').join('')}`;sendBuf(res,200,Buffer.concat([sidebandPackets(Buffer.from(text)),Buffer.from('0000')]),'application/x-git-receive-pack-result');return true;
}
