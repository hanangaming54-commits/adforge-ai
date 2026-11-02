require("dotenv").config();
const express = require("express");
const path = require("path");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const rateLimit = require("express-rate-limit");
const Database = require("better-sqlite3");
const Stripe = require("stripe");

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "dev-only-change-me";
const db = new Database("data.sqlite");

db.exec(`
CREATE TABLE IF NOT EXISTS users(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 name TEXT NOT NULL,
 email TEXT UNIQUE NOT NULL,
 password_hash TEXT NOT NULL,
 role TEXT NOT NULL DEFAULT 'user',
 credits INTEGER NOT NULL DEFAULT 1,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS ads(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 user_id INTEGER NOT NULL,
 brand TEXT NOT NULL,
 product TEXT NOT NULL,
 style TEXT NOT NULL,
 details TEXT,
 result TEXT,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY(user_id) REFERENCES users(id)
);
`);

function ensureAdmin(){
  const email = process.env.ADMIN_EMAIL;
  const pass = process.env.ADMIN_PASSWORD;
  if(!email || !pass) return;
  const exists = db.prepare("SELECT id FROM users WHERE email=?").get(email);
  if(!exists){
    const hash = bcrypt.hashSync(pass, 12);
    db.prepare("INSERT INTO users(name,email,password_hash,role,credits) VALUES(?,?,?,?,?)")
      .run("Owner", email, hash, "admin", 999999);
  }
}
ensureAdmin();

app.use(express.json({limit:"1mb"}));
app.use(express.static(path.join(__dirname,"public")));

const authLimiter = rateLimit({windowMs:15*60*1000,max:30,standardHeaders:true,legacyHeaders:false});
const genLimiter = rateLimit({windowMs:60*1000,max:10,standardHeaders:true,legacyHeaders:false});

function tokenFor(user){
  return jwt.sign({id:user.id, role:user.role}, JWT_SECRET, {expiresIn:"7d"});
}
function auth(req,res,next){
  try{
    const h=req.headers.authorization||"";
    if(!h.startsWith("Bearer ")) throw new Error();
    req.user=jwt.verify(h.slice(7),JWT_SECRET);
    next();
  }catch(e){ return res.status(401).json({error:"Login required"}); }
}
function adminOnly(req,res,next){
  if(req.user.role!=="admin") return res.status(403).json({error:"Owner access only"});
  next();
}

app.post("/api/signup", authLimiter, async (req,res)=>{
  const {name,email,password}=req.body||{};
  if(!name || !email || !password || password.length<8)
    return res.status(400).json({error:"Name, email and an 8+ character password are required."});
  try{
    const hash=await bcrypt.hash(password,12);
    const info=db.prepare("INSERT INTO users(name,email,password_hash,credits) VALUES(?,?,?,1)")
      .run(name.trim(),email.trim().toLowerCase(),hash);
    const user=db.prepare("SELECT id,name,email,role,credits FROM users WHERE id=?").get(info.lastInsertRowid);
    res.json({token:tokenFor(user),user});
  }catch(e){ res.status(409).json({error:"That email is already registered."}); }
});

app.post("/api/login", authLimiter, async (req,res)=>{
  const {email,password}=req.body||{};
  const user=db.prepare("SELECT * FROM users WHERE email=?").get((email||"").trim().toLowerCase());
  if(!user || !(await bcrypt.compare(password||"",user.password_hash)))
    return res.status(401).json({error:"Invalid email or password."});
  const safe={id:user.id,name:user.name,email:user.email,role:user.role,credits:user.credits};
  res.json({token:tokenFor(safe),user:safe});
});

app.get("/api/me",auth,(req,res)=>{
  const user=db.prepare("SELECT id,name,email,role,credits,created_at FROM users WHERE id=?").get(req.user.id);
  res.json({user});
});

app.get("/api/ads",auth,(req,res)=>{
  const ads=db.prepare("SELECT id,brand,product,style,details,result,created_at FROM ads WHERE user_id=? ORDER BY id DESC").all(req.user.id);
  res.json({ads});
});

async function generateWithAI(input){
  if(!process.env.OPENAI_API_KEY){
    return `Ad concept for ${input.brand}: ${input.product}. Style: ${input.style}. ${input.details||""}
HOOK: Make the first 2 seconds visually striking.
VISUAL: Premium cinematic product-focused scene with clean brand placement.
COPY: Create a short memorable headline and a clear call-to-action.
NOTE: Connect an AI provider on the server to turn this concept into production-ready image/video assets.`;
  }
  const r=await fetch("https://api.openai.com/v1/chat/completions",{
    method:"POST",
    headers:{"Content-Type":"application/json","Authorization":"Bearer "+process.env.OPENAI_API_KEY},
    body:JSON.stringify({
      model:"gpt-4o-mini",
      messages:[
        {role:"system",content:"You are an expert advertising creative director. Produce a concise ad concept with hook, visual direction, headline, body copy and CTA."},
        {role:"user",content:`Brand: ${input.brand}\nProduct/service: ${input.product}\nStyle: ${input.style}\nExtra details: ${input.details||"None"}`}
      ],
      temperature:.8
    })
  });
  if(!r.ok) throw new Error("AI provider request failed");
  const data=await r.json();
  return data.choices?.[0]?.message?.content || "No AI result.";
}

app.post("/api/generate",auth,genLimiter,async(req,res)=>{
  const input=req.body||{};
  if(!input.brand || !input.product || !input.style)
    return res.status(400).json({error:"Brand, product/service and style are required."});
  const user=db.prepare("SELECT * FROM users WHERE id=?").get(req.user.id);
  if(user.role!=="admin" && user.credits<1)
    return res.status(402).json({error:"No credits left. Buy more credits to continue."});
  try{
    const result=await generateWithAI(input);
    db.prepare("INSERT INTO ads(user_id,brand,product,style,details,result) VALUES(?,?,?,?,?,?)")
      .run(user.id,input.brand,input.product,input.style,input.details||"",result);
    if(user.role!=="admin") db.prepare("UPDATE users SET credits=credits-1 WHERE id=?").run(user.id);
    const fresh=db.prepare("SELECT id,brand,product,style,details,result,created_at FROM ads WHERE user_id=? ORDER BY id DESC LIMIT 1").get(user.id);
    res.json({ad:fresh,credits:user.role==="admin"?999999:user.credits-1});
  }catch(e){ res.status(502).json({error:"AI generation failed. Check your server AI key/configuration."}); }
});

app.get("/api/admin/stats",auth,adminOnly,(req,res)=>{
  const users=db.prepare("SELECT COUNT(*) c FROM users WHERE role='user'").get().c;
  const ads=db.prepare("SELECT COUNT(*) c FROM ads").get().c;
  const credits=db.prepare("SELECT COALESCE(SUM(credits),0) c FROM users WHERE role='user'").get().c;
  res.json({users,ads,credits});
});

app.get("/api/admin/users",auth,adminOnly,(req,res)=>{
  const users=db.prepare("SELECT id,name,email,role,credits,created_at FROM users ORDER BY id DESC").all();
  res.json({users});
});

app.post("/api/checkout",auth,async(req,res)=>{
  if(!process.env.STRIPE_SECRET_KEY || !process.env.STRIPE_PRICE_ID)
    return res.status(503).json({error:"Payments are not configured yet. Add Stripe keys on the server."});
  const stripe=new Stripe(process.env.STRIPE_SECRET_KEY);
  const session=await stripe.checkout.sessions.create({
    mode:"subscription",
    line_items:[{price:process.env.STRIPE_PRICE_ID,quantity:1}],
    success_url:(process.env.APP_URL||"http://localhost:3000")+"/?paid=1",
    cancel_url:(process.env.APP_URL||"http://localhost:3000")+"/?paid=0",
    client_reference_id:String(req.user.id),
    metadata:{userId:String(req.user.id)}
  });
  res.json({url:session.url});
});

app.get("*",(req,res)=>{
  res.sendFile(path.join(__dirname,"public","index.html"));
});

app.listen(PORT,()=>console.log(`AdForge AI running on http://localhost:${PORT}`));
