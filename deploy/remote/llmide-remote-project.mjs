#!/opt/llmide-node/bin/node
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
const BASE = "/srv/llmide/projects";
const op = JSON.parse(fs.readFileSync("/etc/llmide-remote/operator.json","utf8"));
const key = fs.readFileSync("/etc/systemd/system/llmide-remote.service","utf8").match(/LLMIDE_HOST_APPROVAL_KEY=([0-9a-f]{64})/)?.[1];
const proof = crypto.createHmac("sha256", Buffer.from(key,"hex")).update("bus-host-proof/v1").digest("hex");
const base = "http://127.0.0.1:3457";
const [action, raw] = process.argv.slice(2);
const post = (p,b,h={}) => fetch(base+p,{method:"POST",headers:{"content-type":"application/json",...h},body:JSON.stringify(b||{})}).then(async r=>({status:r.status,body:await r.json().catch(()=>({}))}));
if (action === "list") {
  const dir = path.resolve(raw || BASE);
  if (!dir.startsWith(BASE)) { console.error("outside base"); process.exit(2); }
  const rows = fs.readdirSync(dir,{withFileTypes:true}).filter(e=>e.isDirectory()&&!e.name.startsWith(".")).slice(0,200).map(e=>({name:e.name,path:path.join(dir,e.name)}));
  console.log(JSON.stringify({dir,rows})); process.exit(0);
}
if (action !== "open") { console.error("usage: llmide-remote-project list|open <path>"); process.exit(2); }
const root = path.resolve(raw || "");
if (!root.startsWith(BASE) || !fs.existsSync(root) || !fs.statSync(root).isDirectory()) { console.error("invalid project folder"); process.exit(2); }
fs.mkdirSync(path.join(root,"system"),{recursive:true});
const pj = path.join(root,"system/project.json");
if (!fs.existsSync(pj)) fs.writeFileSync(pj, JSON.stringify({name:path.basename(root)})+"\n");
const login = await post("/auth/login",{email:op.email,password:op.password});
if (login.status !== 200) { console.error("operator login failed"); process.exit(3); }
const auth = {authorization:`Bearer ${login.body.accessToken}`,"x-llmide-host-nonce":proof};
const reg = await post("/kb/projects/register",{root,name:path.basename(root)},{...auth});
if (reg.status !== 200) { console.error("register failed", reg.status, JSON.stringify(reg.body)); process.exit(4); }
const pin = await post("/host-api/pin",{},{...auth});
if (pin.status !== 200) { console.error("pin failed", pin.status); process.exit(5); }
console.log(JSON.stringify({root,projectId:reg.body.id,url:op.url,pin:pin.body.pin,fingerprint:pin.body.fingerprint}));
