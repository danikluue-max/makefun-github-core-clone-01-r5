import { buildCommit, buildTag, buildTree, collectReachable, flattenTree, hashObject, isAncestor, mergeBase, parseCommit, parseTag, parseTree, peelToCommit, type GitObject, type GitObjectType } from './objects.ts';
import { DeterministicClock } from './clock.ts';
import { VIEWER } from './viewer.ts';

export interface Label { name: string; color: string; description: string }
export interface Issue { id:number; number:number; title:string; body:string; state:'open'|'closed'; labels:Label[]; createdSeq:number; createdAt:string; updatedAt:string; userLogin:string }
export interface Comment { id:number; issueNumber:number; body:string; createdAt:string; userLogin:string }
export interface PullRequest { id:number; number:number; title:string; body:string; state:'open'|'closed'; merged:boolean; mergedAt:string|null; mergeCommitSha:string|null; headRef:string; baseRef:string; headSha:string; baseSha:string; createdSeq:number; createdAt:string; updatedAt:string; userLogin:string }
export interface PullFile { filename:string; status:'added'|'removed'|'modified'; additions:number; deletions:number; changes:number }
export interface Repo {
  id:number; name:string; owner:string; description:string; private:boolean; defaultBranch:string; createdSeq:number; createdAt:string; updatedAt:string;
  objects:Map<string,GitObject>; refs:Map<string,string>; labels:Map<string,Label>; issues:Map<number,Issue>; pulls:Map<number,PullRequest>; comments:Map<number,Comment[]>;
  nextNumber:number; nextCommentId:number; version:number; parentsCache:Map<string,string[]>; treeCache:Map<string,string>;
  fetchCache:Map<string,Buffer>; lsRefsCache:Map<string,Buffer>; advCache:Map<string,Buffer>; issueJson:Map<number,Buffer>; repoJson:Buffer|null;
}

const b64 = (s:string):string => Buffer.from(s).toString('base64url');
export const repoGlobalId = (r:Repo):string => b64(`repo:${r.id}`);
export const issueGlobalId = (r:Repo,i:Issue):string => b64(`issue:${r.id}:${i.number}`);
export const pullGlobalId = (r:Repo,p:PullRequest):string => b64(`pr:${r.id}:${p.number}`);
export const commentGlobalId = (r:Repo,c:Comment):string => b64(`comment:${r.id}:${c.id}`);
export function decodeGlobalId(id:string):{kind:string;repoId:number;number?:number;commentId?:number}|null {
  let text:string; try { text=Buffer.from(id,'base64url').toString(); } catch { return null; }
  const p=text.split(':'); const repoId=Number(p[1]); if (!Number.isInteger(repoId)) return null;
  if (p[0]==='repo'&&p.length===2) return {kind:'repo',repoId};
  if ((p[0]==='issue'||p[0]==='pr')&&p.length===3&&Number.isInteger(Number(p[2]))) return {kind:p[0],repoId,number:Number(p[2])};
  if (p[0]==='comment'&&p.length===3&&Number.isInteger(Number(p[2]))) return {kind:'comment',repoId,commentId:Number(p[2])};
  return null;
}

export function lineDiff(a:string,b:string):{additions:number;deletions:number} {
  const aa=a===''?[]:a.split('\n'), bb=b===''?[]:b.split('\n');
  if (aa.length*bb.length>4_000_000) { let p=0,s=0; while(p<aa.length&&p<bb.length&&aa[p]===bb[p])p++; while(s<aa.length-p&&s<bb.length-p&&aa[aa.length-1-s]===bb[bb.length-1-s])s++; return {additions:bb.length-p-s,deletions:aa.length-p-s}; }
  let prev=new Uint32Array(bb.length+1), cur=new Uint32Array(bb.length+1);
  for(let i=1;i<=aa.length;i++){ for(let j=1;j<=bb.length;j++) cur[j]=aa[i-1]===bb[j-1]?prev[j-1]!+1:Math.max(prev[j]!,cur[j-1]!); [prev,cur]=[cur,prev]; cur.fill(0); }
  const lcs=prev[bb.length]!; return {additions:bb.length-lcs,deletions:aa.length-lcs};
}

export class Forge {
  readonly repos=new Map<string,Repo>();
  private repoId=1; private seq=0;
  readonly clock: DeterministicClock;
  constructor(clock=new DeterministicClock()) { this.clock=clock; }
  timestamp():string { return this.clock.nextIso(); }
  private key(owner:string,name:string):string { return `${owner.toLowerCase()}\0${name.toLowerCase()}`; }
  getRepo(owner:string,name:string):Repo|undefined { return this.repos.get(this.key(owner,name)); }
  /** Lookup with already-lowercased owner/name (the router's hot paths). */
  repoByLower(ownerLower:string,nameLower:string):Repo|undefined { return this.repos.get(`${ownerLower}\0${nameLower}`); }
  repoById(id:number):Repo|undefined { for(const r of this.repos.values()) if(r.id===id)return r; }
  listRepos(owner:string):Repo[] { return [...this.repos.values()].filter(r=>r.owner.toLowerCase()===owner.toLowerCase()).sort((a,b)=>a.createdSeq-b.createdSeq); }
  createRepo(owner:string,name:string,options:{description?:string;private?:boolean}={}):Repo|{error:string} {
    if(this.getRepo(owner,name))return {error:`Repository ${name} already exists`};
    const createdSeq=++this.seq, createdAt=this.timestamp();
    const repo:Repo={id:this.repoId++,name,owner,description:options.description??'',private:options.private??false,defaultBranch:'main',createdSeq,createdAt,updatedAt:createdAt,objects:new Map(),refs:new Map(),labels:new Map(),issues:new Map(),pulls:new Map(),comments:new Map(),nextNumber:1,nextCommentId:1,version:0,parentsCache:new Map(),treeCache:new Map(),fetchCache:new Map(),lsRefsCache:new Map(),advCache:new Map(),issueJson:new Map(),repoJson:null};
    this.repos.set(this.key(owner,name),repo); return repo;
  }
  deleteRepo(owner:string,name:string):boolean { return this.repos.delete(this.key(owner,name)); }
  private invalidate(repo:Repo):void { repo.version++; repo.fetchCache.clear(); repo.lsRefsCache.clear(); repo.advCache.clear(); repo.repoJson=null; }
  lookup(repo:Repo):(oid:string)=>GitObject|undefined { return oid=>repo.objects.get(oid); }
  /** Store many objects at once (receive-pack): one cache invalidation, no re-hash. */
  ingestObjects(repo:Repo,objects:Map<string,GitObject>):void {
    let added=false;
    for(const [oid,object] of objects){
      if(repo.objects.has(oid))continue;
      repo.objects.set(oid,object);
      if(object.type==='commit'){const c=parseCommit(object.data);repo.parentsCache.set(oid,c.parents);repo.treeCache.set(oid,c.tree);}
      added=true;
    }
    if(added)this.invalidate(repo);
  }
  putObject(repo:Repo,type:GitObjectType,data:Buffer):string {
    const oid=hashObject(type,data); if(!repo.objects.has(oid)){ repo.objects.set(oid,{type,data}); if(type==='commit'){const c=parseCommit(data);repo.parentsCache.set(oid,c.parents);repo.treeCache.set(oid,c.tree);} this.invalidate(repo); } return oid;
  }
  refTip(repo:Repo,ref:string):string|undefined{return repo.refs.get(ref);}
  setRef(repo:Repo,ref:string,oid:string):void {if(repo.refs.get(ref)!==oid){repo.refs.set(ref,oid);this.invalidate(repo);}}
  deleteRef(repo:Repo,ref:string):boolean {const changed=repo.refs.delete(ref);if(changed)this.invalidate(repo);return changed;}
  defaultTip(repo:Repo):string|undefined{return repo.refs.get(`refs/heads/${repo.defaultBranch}`);}
  makeCommit(repo:Repo,tree:string,parents:readonly string[],message:string,timestamp?:number):string {
    const who=`${VIEWER.name} <${VIEWER.email}>`, data=buildCommit({tree,parents,message:message.endsWith('\n')?message:`${message}\n`,author:who,committer:who,timestamp:timestamp??this.clock.nextStampSec()}); return this.putObject(repo,'commit',data);
  }
  buildTreeFromMap(repo:Repo,flat:Map<string,{oid:string;mode:string}>):string {
    type Node={files:Map<string,{oid:string;mode:string}>;dirs:Map<string,Node>}; const make=():Node=>({files:new Map(),dirs:new Map()}),root=make();
    for(const [path,item] of flat){const parts=path.split('/');let node=root;for(const part of parts.slice(0,-1)){let child=node.dirs.get(part);if(!child){child=make();node.dirs.set(part,child);}node=child;}node.files.set(parts.at(-1)!,item);}
    const build=(node:Node):string=>{const entries: {mode:string;name:string;oid:string}[]=[];for(const [name,item] of node.files)entries.push({name,...item});for(const [name,child] of node.dirs)entries.push({name,mode:'40000',oid:build(child)});return this.putObject(repo,'tree',buildTree(entries));};return build(root);
  }
  treeFlat(repo:Repo,commitOid:string):Map<string,{oid:string;mode:string}> {const c=repo.objects.get(commitOid);if(!c||c.type!=='commit')return new Map();const tree=repo.treeCache.get(commitOid)??parseCommit(c.data).tree;return flattenTree(tree,this.lookup(repo));}
  commitFile(repo:Repo,branch:string,path:string,content:Buffer,message:string):{commitSha:string;blobSha:string}|{error:string} {
    const ref=`refs/heads/${branch}`,tip=repo.refs.get(ref),blobSha=this.putObject(repo,'blob',content),flat=tip?this.treeFlat(repo,tip):new Map<string,{oid:string;mode:string}>();flat.set(path,{oid:blobSha,mode:'100644'});const tree=this.buildTreeFromMap(repo,flat),commitSha=this.makeCommit(repo,tree,tip?[tip]:[],message);this.setRef(repo,ref,commitSha);repo.updatedAt=this.timestamp();return {commitSha,blobSha};
  }
  deleteFile(repo:Repo,branch:string,path:string,message:string):{commitSha:string}|{error:string} {const ref=`refs/heads/${branch}`,tip=repo.refs.get(ref);if(!tip)return {error:'branch does not exist'};const flat=this.treeFlat(repo,tip);if(!flat.delete(path))return {error:'file does not exist'};const tree=this.buildTreeFromMap(repo,flat),commitSha=this.makeCommit(repo,tree,[tip],message);this.setRef(repo,ref,commitSha);repo.updatedAt=this.timestamp();return {commitSha};}
  commitsFrom(repo:Repo,tip:string):{sha:string;message:string;author:string;committer:string;parents:string[];tree:string}[] {const out: {sha:string;message:string;author:string;committer:string;parents:string[];tree:string}[]=[],seen=new Set<string>(),stack=[tip];while(stack.length){const oid=stack.pop()!;if(seen.has(oid))continue;seen.add(oid);const object=repo.objects.get(oid);if(!object||object.type!=='commit')continue;const c=parseCommit(object.data);repo.parentsCache.set(oid,c.parents);repo.treeCache.set(oid,c.tree);out.push({sha:oid,...c});stack.push(...[...c.parents].reverse());}return out;}
  createIssue(repo:Repo,title:string,body:string,labels:string[]):Issue|{error:string} {const attached:Label[]=[];for(const name of labels){const l=repo.labels.get(name);if(!l)return {error:`Label ${name} does not exist`};attached.push(l);}const number=repo.nextNumber++,createdSeq=++this.seq,createdAt=this.timestamp(),issue:Issue={id:100000+repo.id*1000+number,number,title,body,state:'open',labels:attached,createdSeq,createdAt,updatedAt:createdAt,userLogin:VIEWER.login};repo.issues.set(number,issue);repo.issueJson.delete(number);repo.repoJson=null;return issue;}
  addComment(repo:Repo,number:number,body:string):Comment|{error:string} {if(!repo.issues.has(number))return {error:'issue not found'};const c:Comment={id:repo.nextCommentId++,issueNumber:number,body,createdAt:this.timestamp(),userLogin:VIEWER.login},list=repo.comments.get(number)??[];list.push(c);repo.comments.set(number,list);repo.issueJson.delete(number);return c;}
  createLabel(repo:Repo,name:string,color:string):Label {let l=repo.labels.get(name);if(!l){l={name,color:color||'ededed',description:''};repo.labels.set(name,l);}return l;}
  createPull(repo:Repo,title:string,body:string,head:string,base:string):PullRequest|{error:string} {const headSha=repo.refs.get(`refs/heads/${head}`),baseSha=repo.refs.get(`refs/heads/${base}`);if(!headSha)return {error:`head branch ${head} does not exist`};if(!baseSha)return {error:`base branch ${base} does not exist`};for(const p of repo.pulls.values())if(p.state==='open'&&p.headRef===head&&p.baseRef===base)return {error:'A pull request already exists for this head branch'};const number=repo.nextNumber++,createdSeq=++this.seq,createdAt=this.timestamp(),p:PullRequest={id:200000+repo.id*1000+number,number,title,body,state:'open',merged:false,mergedAt:null,mergeCommitSha:null,headRef:head,baseRef:base,headSha,baseSha,createdSeq,createdAt,updatedAt:createdAt,userLogin:VIEWER.login};repo.pulls.set(number,p);return p;}
  pullFiles(repo:Repo,pull:PullRequest):PullFile[] {const base=this.treeFlat(repo,pull.baseSha),head=this.treeFlat(repo,pull.headSha),paths=new Set([...base.keys(),...head.keys()]),out:PullFile[]=[];for(const path of [...paths].sort()){const a=base.get(path),b=head.get(path);if(a&&b&&a.oid===b.oid)continue;const av=a?repo.objects.get(a.oid)?.data.toString()??'':'';const bv=b?repo.objects.get(b.oid)?.data.toString()??'':'';const d=lineDiff(av,bv);const status=!a?'added':!b?'removed':'modified';out.push({filename:path,status,additions:d.additions,deletions:d.deletions,changes:d.additions+d.deletions});}return out;}
  pullMergesCleanly(repo:Repo,p:PullRequest):boolean {const ours=repo.refs.get(`refs/heads/${p.baseRef}`),theirs=repo.refs.get(`refs/heads/${p.headRef}`);if(!ours||!theirs)return false;const base=mergeBase(ours,theirs,this.lookup(repo),repo.parentsCache);if(!base)return false;const b=this.treeFlat(repo,base),o=this.treeFlat(repo,ours),t=this.treeFlat(repo,theirs);for(const path of new Set([...b.keys(),...o.keys(),...t.keys()])){const bv=b.get(path)?.oid,ov=o.get(path)?.oid,tv=t.get(path)?.oid;if(ov!==tv&&bv!==ov&&bv!==tv)return false;}return true;}
  mergePull(repo:Repo,p:PullRequest,method='squash'):{sha:string}|{error:string} {if(p.state!=='open')return {error:'pull request is not open'};const ours=repo.refs.get(`refs/heads/${p.baseRef}`),theirs=repo.refs.get(`refs/heads/${p.headRef}`);if(!ours||!theirs)return {error:'branch missing'};const base=mergeBase(ours,theirs,this.lookup(repo),repo.parentsCache);if(!base)return {error:'no merge base'};const b=this.treeFlat(repo,base),o=this.treeFlat(repo,ours),t=this.treeFlat(repo,theirs),merged=new Map<string,{oid:string;mode:string}>();for(const path of new Set([...b.keys(),...o.keys(),...t.keys()])){const bv=b.get(path),ov=o.get(path),tv=t.get(path);if(ov?.oid===tv?.oid){if(ov)merged.set(path,ov);}else if(bv?.oid===ov?.oid){if(tv)merged.set(path,tv);}else if(bv?.oid===tv?.oid){if(ov)merged.set(path,ov);}else return {error:'conflict'};}
    const tree=this.buildTreeFromMap(repo,merged),sha=this.makeCommit(repo,tree,method==='merge'?[ours,theirs]:[ours],`Merge pull request #${p.number} from ${p.headRef}${method==='merge'?'':`\n\n${p.title}`}`);this.setRef(repo,`refs/heads/${p.baseRef}`,sha);p.state='closed';p.merged=true;p.mergedAt=this.timestamp();p.updatedAt=p.mergedAt;p.mergeCommitSha=sha;p.baseSha=sha;p.headSha=theirs;return {sha};}
  allRefs(repo:Repo):[string,string][]{return [...repo.refs].sort(([a],[b])=>a<b?-1:a>b?1:0);}
  reachable(repo:Repo,tips:readonly string[]):Set<string>{return collectReachable(tips,this.lookup(repo),repo);}
  fetchSet(repo:Repo,wants:readonly string[],haves:readonly string[]):Set<string>{const wanted=collectReachable(wants,this.lookup(repo),repo);if(haves.length)for(const oid of collectReachable(haves,this.lookup(repo),repo))wanted.delete(oid);return wanted;}
  peelRef(repo:Repo,oid:string):string|undefined {const object=repo.objects.get(oid);if(!object||object.type!=='tag')return undefined;return parseTag(object.data).object;}
  peelCommit(repo:Repo,oid:string):string|null{return peelToCommit(oid,this.lookup(repo));}
  isAncestor(repo:Repo,ancestor:string,commit:string):boolean{return isAncestor(ancestor,commit,this.lookup(repo),repo.parentsCache);}
  makeTag(repo:Repo,object:string,tag:string,message:string):string {const data=buildTag({object,type:'commit',tag,message,tagger:`${VIEWER.name} <${VIEWER.email}>`,timestamp:this.clock.nextStampSec()});return this.putObject(repo,'tag',data);}
}

export { buildTree, parseCommit, parseTag, parseTree };
