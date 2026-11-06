// SFTP to the user's own server: pinned ed25519 host key, ed25519 user key from the vault, lazy ssh2.
// One connection per store, reused; operations run one at a time; a connection lost mid-operation is replaced once.
// put writes a hidden temp file next to the target and renames it over the target with posix-rename@openssh.com, so a
// reader (the desktop or nginx) sees the old bytes or the new, never a mix. removeTree unlinks symlinks, never follows.
import { createHash, randomBytes } from 'node:crypto';
import { checkPath, checkSize, MAX_FILE_BYTES } from './index.mjs';
export const DEFAULT_SFTP_ROOT='/data',DEFAULT_SFTP_USER='llmidesync',DEFAULT_WEB_HOST='llm-ide.com';
const HOST_RE=/^(?=.{1,253}$)[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
export const WEB_HOST_RE=/^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const USER_RE=/^[a-z_][a-z0-9_-]{0,31}$/,FP_RE=/^SHA256:[A-Za-z0-9+/]{43}$/,ROOT_RE=/^(\/[A-Za-z0-9_.-]{1,64}){1,8}$/;
const NETWORK=new Set(['ECONNREFUSED','ECONNRESET','ETIMEDOUT','ENOTFOUND','EHOSTUNREACH','ENETUNREACH','EAI_AGAIN','EPIPE']);
const MESSAGES={SYNC_HOST_KEY_CHANGED:"The server's identity changed",SYNC_AUTH_FAILED:'The server refused the sync key',SYNC_UNREACHABLE:'Sync server not reachable',SYNC_TOO_LARGE:'Sync file too large',SYNC_IO:'Sync server operation failed'};
export const coded=(code)=>Object.assign(new Error(MESSAGES[code]??MESSAGES.SYNC_IO),{code});
export const hostKeyFingerprint=(blob)=>`SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/,'')}`;
export function parseHostFingerprint(text){const m=/SHA256:([A-Za-z0-9+/]{43})=?(?![A-Za-z0-9+/=])/.exec(String(text??''));return m?`SHA256:${m[1]}`:null}
export function validateSftpConfig(c){if(!c||typeof c.host!=='string'||!HOST_RE.test(c.host))return'host';if(!Number.isInteger(c.port)||c.port<1||c.port>65535)return'port';if(typeof c.username!=='string'||!USER_RE.test(c.username))return'username';if(typeof c.hostFingerprint!=='string'||!FP_RE.test(c.hostFingerprint))return'hostFingerprint';if(typeof c.webHost!=='string'||!WEB_HOST_RE.test(c.webHost))return'webHost';if(typeof c.root!=='string'||!ROOT_RE.test(c.root)||c.root.split('/').some((s)=>s==='.'||s==='..'))return'root';return null}
export function classifySftpError(e){if(String(e?.code??'').startsWith('SYNC_'))return e.code;if(e?.level==='client-authentication')return'SYNC_AUTH_FAILED';if(e?.level==='client-timeout'||NETWORK.has(e?.code))return'SYNC_UNREACHABLE';if(/Timed out while waiting for handshake|No response from server|Not connected|connection lost/i.test(String(e?.message??'')))return'SYNC_UNREACHABLE';return'SYNC_IO'}
export async function generateSyncSshKey(comment){const {utils}=(await import('ssh2')).default;const k=utils.generateKeyPairSync('ed25519',{comment});return{privateKey:k.private,publicKey:k.public}}
export async function connectSftp({host,port,username,hostFingerprint,privateKey},{onLost=()=>{}}={}){const {Client}=(await import('ssh2')).default;return new Promise((resolve,reject)=>{const client=new Client();let rejected=false,settled=false;const fail=(e)=>{if(settled)return;settled=true;try{client.end()}catch{/* already closed */}reject(rejected?coded('SYNC_HOST_KEY_CHANGED'):coded(classifySftpError(e)))};client.on('error',(e)=>(settled?onLost(e):fail(e)));client.on('close',()=>{if(settled)onLost();else fail(new Error('connection lost'))});client.on('ready',()=>client.sftp((e,sftp)=>{if(e)return fail(e);settled=true;resolve({sftp,close:()=>client.end()})}));try{client.connect({host,port,username,privateKey,authHandler:['publickey'],algorithms:{serverHostKey:['ssh-ed25519']},hostVerifier:(key)=>{const ok=hostKeyFingerprint(key)===hostFingerprint;if(!ok)rejected=true;return ok},readyTimeout:20000,keepaliveInterval:15000,keepaliveCountMax:3})}catch(e){fail(e)}})}


const NO_SUCH_FILE=2,S_IFMT=0o170000,S_IFREG=0o100000,S_IFDIR=0o040000;
const call=(fn)=>new Promise((res,rej)=>fn((e,v)=>e?rej(e):res(v)));const absent=(e)=>e?.code===NO_SUCH_FILE;const asCoded=(e)=>String(e?.code??'').startsWith('SYNC_')?e:coded(classifySftpError(e));
export function createSftpStore(config,secrets,{connect=connectSftp}={}){
 const root=config?.root||DEFAULT_SFTP_ROOT,target={host:config.host,port:config.port??22,username:config.username||DEFAULT_SFTP_USER,hostFingerprint:config.hostFingerprint};const full=(segs)=>[root,...segs].join('/');
 let session=null,chain=Promise.resolve();
 function conn(){if(!session){const p=connect({...target,privateKey:secrets.privateKey},{onLost:()=>{if(session!==p)return;session=null;p.then((s)=>s.close(),()=>{})}});p.catch(()=>{if(session===p)session=null});session=p}return session}
 function drop(){const old=session;session=null;old?.then((s)=>s.close(),()=>{}).catch(()=>{})}
 async function attempt(fn){for(let retried=false;;retried=true){let s;try{s=await conn()}catch(e){drop();throw asCoded(e)}try{return await fn(s.sftp)}catch(e){if(!retried&&classifySftpError(e)==='SYNC_UNREACHABLE'){drop();continue}throw asCoded(e)}}}
 const serial=(fn)=>{const run=chain.then(()=>attempt(fn));chain=run.catch(()=>{});return run};
 async function mkdirp(sftp,segs){let dir=root;for(const name of segs){dir=`${dir}/${name}`;try{await call((cb)=>sftp.mkdir(dir,{mode:0o770},cb))}catch(e){const st=await call((cb)=>sftp.stat(dir,cb)).catch(()=>null);if(!st?.isDirectory())throw e}}}
 async function rmTree(sftp,dir){let entries;try{entries=await call((cb)=>sftp.readdir(dir,cb))}catch(e){if(absent(e))return;throw e}for(const x of entries){if(x.filename==='.'||x.filename==='..')continue;const child=`${dir}/${x.filename}`;if((x.attrs.mode&S_IFMT)===S_IFDIR)await rmTree(sftp,child);else await call((cb)=>sftp.unlink(child,cb)).catch((e)=>{if(!absent(e))throw e})}await call((cb)=>sftp.rmdir(dir,cb)).catch((e)=>{if(!absent(e))throw e})}
 return{
  async put(path,bytes){const segs=checkPath(path);checkSize(bytes);const data=Buffer.from(bytes);await serial(async(sftp)=>{const dir=full(segs.slice(0,-1)),dest=`${dir}/${segs.at(-1)}`,tmp=`${dir}/.${segs.at(-1)}.${randomBytes(6).toString('hex')}.part`;const write=()=>call((cb)=>sftp.writeFile(tmp,data,{mode:0o660},cb));try{await write()}catch(e){if(!absent(e))throw e;await mkdirp(sftp,segs.slice(0,-1));await write()}try{await call((cb)=>sftp.ext_openssh_rename(tmp,dest,cb))}catch(e){await call((cb)=>sftp.unlink(tmp,cb)).catch(()=>{});throw e}})},
  async get(path){const segs=checkPath(path);return serial(async(sftp)=>{let st;try{st=await call((cb)=>sftp.stat(full(segs),cb))}catch(e){if(absent(e))return null;throw e}if(!st.isFile())return null;if(st.size>MAX_FILE_BYTES)throw coded('SYNC_TOO_LARGE');let buf;try{buf=await call((cb)=>sftp.readFile(full(segs),cb))}catch(e){if(absent(e))return null;throw e}if(buf.length>MAX_FILE_BYTES)throw coded('SYNC_TOO_LARGE');return buf})},
  async list(dir){const segs=checkPath(dir);return serial(async(sftp)=>{let entries;try{entries=await call((cb)=>sftp.readdir(full(segs),cb))}catch(e){if(absent(e))return[];throw e}return entries.filter((x)=>!x.filename.startsWith('.')&&(x.attrs.mode&S_IFMT)===S_IFREG).map((x)=>({name:x.filename,size:x.attrs.size??0,mtimeMs:(x.attrs.mtime??0)*1000}))})},
  async remove(path){const segs=checkPath(path);await serial((sftp)=>call((cb)=>sftp.unlink(full(segs),cb)).catch((e)=>{if(!absent(e))throw e}))},
  async removeTree(dir){const segs=checkPath(dir);await serial((sftp)=>rmTree(sftp,full(segs)))},
  async ensureDir(dir){const segs=checkPath(dir);await serial((sftp)=>mkdirp(sftp,segs))},
  describe(){return{kind:'sftp',root:config.webHost,account:`${target.username}@${target.host}:${target.port}`}},
  async close(){const old=session;session=null;if(old)await old.then((s)=>s.close(),()=>{}).catch(()=>{})},
 };
}
