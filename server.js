const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const http = require('http');
const https = require('https');
const { Server } = require('socket.io');
const multer = require('multer');
const XLSX = require('xlsx');
const mammoth = require('mammoth');
const QRCode = require('qrcode');

const app = express();
const sslKey = process.env.SSL_KEY;
const sslCert = process.env.SSL_CERT;
let server;

if (sslKey && sslCert && fs.existsSync(sslKey) && fs.existsSync(sslCert)) {
  server = https.createServer({ key: fs.readFileSync(sslKey), cert: fs.readFileSync(sslCert) }, app);
} else {
  server = http.createServer(app);
}
const io = new Server(server, { cors: { origin: true, credentials: false } });

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_FILE = path.join(__dirname, 'data.json');
const SESSION_TTL = 1000 * 60 * 60 * 24 * 7;
const ROOM_TTL = 1000 * 60 * 60 * 2;

app.use(express.json({ limit: '8mb' }));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });
app.use(express.static(path.join(__dirname, 'public')));
app.get('/api/qr', async (req,res)=>{
  try{
    const target=String(req.query.url||'').trim();
    if(!target)return res.status(400).json({error:'缺少二维码地址'});
    const dataUrl=await QRCode.toDataURL(target,{width:280,margin:1,errorCorrectionLevel:'M'});
    res.json({dataUrl});
  }catch(e){res.status(400).json({error:'二维码生成失败'});}
});


function loadData() {
  if (!fs.existsSync(DATA_FILE)) { const d=seedData(); fs.writeFileSync(DATA_FILE, JSON.stringify(d,null,2), 'utf8'); return d; }
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch { return seedData(); }
}
function saveData() { fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2), 'utf8'); }
function seedData() {
  const teacher = makeUser('teacher', 'teacher123', 'teacher', '示例老师');
  const student = makeUser('student', 'student123', 'student', '示例学生');
  const admin = makeUser('admin', 'admin123', 'admin', '系统管理员');
  return {
    users: [teacher, student, admin],
    quizzes: [
      { id: 'demo', ownerId: teacher.id, title: '中国地理趣味挑战', description: '示例题库：适合课堂暖场。', tags: ['地理','中文'], questions: [
        {id:'q1',type:'single',text:'中国最长的河流是哪一条？',options:['黄河','长江','珠江','黑龙江'],answer:1,time:15,image:'',audio:'',video:''},
        {id:'q2',type:'single',text:'中国的首都是哪里？',options:['上海','广州','北京','深圳'],answer:2,time:12,image:'',audio:'',video:''},
        {id:'q3',type:'truefalse',text:'长城是中国最著名的世界文化遗产之一。',options:['正确','错误'],answer:0,time:10,image:'',audio:'',video:''},
        {id:'q4',type:'multi',text:'下列哪些属于中国传统节日？（多选）',options:['春节','万圣节','中秋节','感恩节'],answer:[0,2],time:16,image:'',audio:'',video:''},
        {id:'q5',type:'order',text:'请把这些朝代按时间先后排序。',options:['唐朝','秦朝','清朝','汉朝'],answer:[1,3,0,2],time:20,image:'',audio:'',video:''}
      ]}
    ],
    history: []
  };
}
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(password, stored) {
  const [salt, original] = String(stored).split(':');
  if (!salt || !original) return false;
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(original, 'hex'));
}
function makeUser(username, password, role, displayName) {
  return { id: crypto.randomUUID(), username, displayName, role, passwordHash: hashPassword(password), createdAt: Date.now() };
}
let db = loadData();
const sessions = new Map();
const games = new Map();
const avatars = ['rocket','fox','cat','robot','dragon','panda','alien','ninja','tiger','lion','penguin','koala','owl','shark','unicorn','slime','wizard','knight','monkey','hamster'];
const avatarEmoji = {rocket:'🚀',fox:'🦊',cat:'🐱',robot:'🤖',dragon:'🐲',panda:'🐼',alien:'👽',ninja:'🥷',tiger:'🐯',lion:'🦁',penguin:'🐧',koala:'🐨',owl:'🦉',shark:'🦈',unicorn:'🦄',slime:'🟢',wizard:'🧙',knight:'🛡️',monkey:'🐵',hamster:'🐹'};
const powerups = ['double','time','shield'];

function getToken(req) { const h=req.headers.authorization||''; return h.startsWith('Bearer ')?h.slice(7):null; }
function auth(req,res,next){
  const token=getToken(req); const s=token&&sessions.get(token);
  if(!s || s.expiresAt<Date.now()){ if(token) sessions.delete(token); return res.status(401).json({error:'请先登录'}); }
  const user=db.users.find(u=>u.id===s.userId); if(!user) return res.status(401).json({error:'账号不存在'});
  req.user=user; next();
}
function role(...roles){ return (req,res,next)=> roles.includes(req.user.role)?next():res.status(403).json({error:'无权限'}); }
function publicUser(u){ return {id:u.id,username:u.username,displayName:u.displayName,role:u.role}; }
function makePin(){ let p; do p=String(Math.floor(100000+Math.random()*900000)); while(games.has(p)); return p; }
function sanitizeQuestion(q){ const x={...q}; delete x.answer; return x; }
function getPublicState(game, forPlayerId=null){
  const players=[...game.players.values()].map(p=>({id:p.id,userId:p.userId||null,name:p.name,avatar:p.avatar,score:p.score,correct:p.correct,streak:p.streak,powerups:p.powerups,connected:p.connected!==false}));
  const ranking=[...game.players.values()].sort((a,b)=>b.score-a.score||b.correct-a.correct).map((p,i)=>({rank:i+1,id:p.id,name:p.name,avatar:p.avatar,score:p.score,correct:p.correct,streak:p.streak,powerups:p.powerups}));
  return {
    pin:game.pin,title:game.quiz.title,status:game.status,current:game.current,total:game.quiz.questions.length,
    question:game.status==='question'?sanitizeQuestion(game.quiz.questions[game.current]):null,
    players,ranking,questionEndsAt:game.questionEndsAt,questionStartedAt:game.questionStartedAt,
    answeredCount:game.answered.size, settings:game.settings,
    player:forPlayerId?(()=>{const p=game.players.get(forPlayerId);return p?{id:p.id,name:p.name,avatar:p.avatar,score:p.score,correct:p.correct,streak:p.streak,powerups:p.powerups}:null})():null
  };
}
function emitState(game){ io.to(`game:${game.pin}`).emit('game:state', getPublicState(game)); }
function clearTimer(game){ if(game.timer) clearTimeout(game.timer); game.timer=null; }
function recordHistory(game){
  const now=Date.now();
  db.history.push({id:crypto.randomUUID(),pin:game.pin,quizId:game.quiz.id,title:game.quiz.title,startedAt:game.startedAt||now,finishedAt:now,players:[...game.players.values()].sort((a,b)=>b.score-a.score).map(p=>sanitizePlayerRecord(p))});
  if(db.history.length>500) db.history=db.history.slice(-500);
  saveData();
}
function sanitizePlayerRecord(p){return {id:p.id,userId:p.userId||null,name:p.name,avatar:p.avatar,score:p.score,correct:p.correct,streak:p.streak};}
function scheduleExpiry(game){ clearTimeout(game.expiryTimer); game.expiryTimer=setTimeout(()=>{ if(games.has(game.pin) && Date.now()-game.lastActivity>=ROOM_TTL){ clearTimer(game); games.delete(game.pin); }}, ROOM_TTL+1000); }
function startQuestion(game){
  clearTimer(game); game.lastActivity=Date.now(); game.current+=1; game.answered.clear();
  game.players.forEach(p=>{p.answered=false;p.personalEndsAt=null;p.usedPowerupThisQuestion=false;});
  if(game.current>=game.quiz.questions.length){
    game.status='finished'; game.questionStartedAt=null; game.questionEndsAt=null; recordHistory(game); emitState(game); io.to(`game:${game.pin}`).emit('game:finished',{ranking:getPublicState(game).ranking,mvp:getPublicState(game).ranking[0]||null}); scheduleExpiry(game); return;
  }
  game.status='question'; const q=game.quiz.questions[game.current]; const now=Date.now(); game.questionStartedAt=now; game.questionEndsAt=now+q.time*1000; emitState(game);
  game.timer=setTimeout(()=>endQuestion(game),q.time*1000+150);
}
function endQuestion(game){
  if(game.status!=='question') return; clearTimer(game); game.status='transition'; game.lastActivity=Date.now();
  const s=getPublicState(game); emitState(game); io.to(`game:${game.pin}`).emit('question:ended',{current:game.current,ranking:s.ranking,next:game.current+1<game.quiz.questions.length});
}
function evaluateAnswer(q, answer){
  if(q.type==='single'||q.type==='truefalse') return Number(answer)===Number(q.answer);
  if(q.type==='multi') { const a=[...(Array.isArray(answer)?answer:[])].map(Number).sort((a,b)=>a-b); const b=[...(Array.isArray(q.answer)?q.answer:[])].map(Number).sort((a,b)=>a-b); return JSON.stringify(a)===JSON.stringify(b); }
  if(q.type==='order') return JSON.stringify((Array.isArray(answer)?answer:[]).map(Number))===JSON.stringify((q.answer||[]).map(Number));
  return false;
}
function normalizeType(q){ return ['single','truefalse','multi','order'].includes(q.type)?q.type:'single'; }

app.get('/api/health',(req,res)=>res.json({ok:true,secure:Boolean(sslKey&&sslCert)}));
app.post('/api/auth/register',(req,res)=>{
  const username=String(req.body.username||'').trim().toLowerCase(); const password=String(req.body.password||''); const displayName=String(req.body.displayName||username).trim().slice(0,30); const requestedRole=req.body.role==='teacher'?'teacher':'student';
  if(username.length<3||password.length<6) return res.status(400).json({error:'用户名至少3位，密码至少6位'});
  if(db.users.some(u=>u.username===username)) return res.status(409).json({error:'用户名已存在'});
  const u=makeUser(username,password,requestedRole,displayName); db.users.push(u); saveData(); res.json({user:publicUser(u)});
});
app.post('/api/auth/login',(req,res)=>{
  const username=String(req.body.username||'').trim().toLowerCase(); const password=String(req.body.password||''); const u=db.users.find(x=>x.username===username);
  if(!u || !verifyPassword(password,u.passwordHash)) return res.status(401).json({error:'用户名或密码错误'});
  const token=crypto.randomBytes(32).toString('hex'); sessions.set(token,{userId:u.id,expiresAt:Date.now()+SESSION_TTL}); res.json({token,user:publicUser(u)});
});
app.get('/api/auth/me',auth,(req,res)=>res.json({user:publicUser(req.user)}));
app.post('/api/auth/logout',auth,(req,res)=>{sessions.forEach((v,k)=>{if(v.userId===req.user.id)sessions.delete(k)});res.json({ok:true})});

app.get('/api/quizzes',auth,(req,res)=>{
  const q=String(req.query.q||'').toLowerCase().trim();
  const mine=req.query.mine==='1';
  const list=db.quizzes.filter(x=>(!mine||x.ownerId===req.user.id)&&(!q||x.title.toLowerCase().includes(q)||x.description?.toLowerCase().includes(q)||(x.tags||[]).some(t=>t.toLowerCase().includes(q))));
  res.json(list.map(x=>({id:x.id,title:x.title,description:x.description,tags:x.tags,count:x.questions.length,ownerId:x.ownerId})));
});
app.get('/api/quizzes/:id',auth,(req,res)=>{const q=db.quizzes.find(x=>x.id===req.params.id);if(!q)return res.status(404).json({error:'题库不存在'});res.json(q)});

function parseAnswerToken(token, options, type) {
  token = String(token || '').trim();
  if (type === 'truefalse') {
    if (/^(正确|对|true|t|yes|是)$/i.test(token)) return 0;
    if (/^(错误|错|false|f|no|否)$/i.test(token)) return 1;
  }
  const parts = token.toUpperCase().match(/[A-H]/g) || [];
  if (type === 'multi' || parts.length > 1) return [...new Set(parts.map(x => x.charCodeAt(0) - 65).filter(i => i >= 0 && i < options.length))];
  const m = token.toUpperCase().match(/[A-H]/);
  if (m) return m[0].charCodeAt(0) - 65;
  const idx = options.findIndex(x => x.trim() === token);
  return idx >= 0 ? idx : 0;
}

function parseQuestionText(text) {
  const normalized = String(text || '').replace(/\r/g, '').replace(/[\u00a0\t]+/g, ' ').trim();
  if (!normalized) return [];
  const lines = normalized.split('\n').map(x => x.trim()).filter(Boolean);
  const blocks = [];
  let current = null;
  const push = () => {
    if (!current) return;
    current.options = current.options.filter(Boolean);
    if (current.text && current.options.length) blocks.push(current);
    current = null;
  };
  for (const line of lines) {
    const qMatch = line.match(/^(?:第\s*)?(\d+)[\.、\)）:]\s*(.+)$/);
    const optMatch = line.match(/^([A-Ha-h])[\.、\)）:]\s*(.+)$/);
    const answerMatch = line.match(/^(?:答案|正确答案|answer)\s*[:：]?\s*(.+)$/i);
    const typeMatch = line.match(/^(?:类型|题型|type)\s*[:：]?\s*(.+)$/i);
    const timeMatch = line.match(/^(?:时间|答题时间|time)\s*[:：]?\s*(\d+)\s*秒?$/i);
    if (qMatch) { push(); current = { text: qMatch[2].trim(), options: [], answerRaw: '', typeRaw: '单选题', time: 15 }; continue; }
    if (!current) {
      // 允许不带编号：遇到连续 A-D 之前的第一段作为题目
      current = { text: line, options: [], answerRaw: '', typeRaw: '单选题', time: 15 };
      continue;
    }
    if (optMatch) { current.options.push(optMatch[2].trim()); continue; }
    if (answerMatch) { current.answerRaw = answerMatch[1].trim(); continue; }
    if (typeMatch) { current.typeRaw = typeMatch[1].trim(); continue; }
    if (timeMatch) { current.time = Math.max(5, Math.min(180, Number(timeMatch[1]))); continue; }
    // “题目：”形式
    const explicitQ = line.match(/^(?:题目|问题)\s*[:：]\s*(.+)$/);
    if (explicitQ) { current.text = explicitQ[1].trim(); continue; }
  }
  push();
  return blocks.map((b, i) => {
    const type = /多选|multiple|multi/i.test(b.typeRaw) ? 'multi' : /判断|true\s*false/i.test(b.typeRaw) ? 'truefalse' : /排序|order/i.test(b.typeRaw) ? 'order' : 'single';
    let options = b.options.slice();
    if (type === 'truefalse' && options.length === 0) options = ['正确', '错误'];
    let answer = parseAnswerToken(b.answerRaw, options, type);
    if (type === 'order') {
      if (Array.isArray(answer) && answer.length) answer = answer;
      else answer = [...options.keys()];
    }
    return { id: `import_q_${i + 1}`, type, text: b.text, options, answer, time: b.time || 15, image: '', audio: '', video: '' };
  }).filter(q => q.text && q.options.length);
}

function parseCsvOrTsv(text) {
  const rows = String(text || '').split(/\r?\n/).map(r => r.split(r.includes('\t') ? '\t' : ',').map(x => x.replace(/^\s*"|"\s*$/g, '').trim())).filter(r => r.some(Boolean));
  if (!rows.length) return [];
  const header = rows[0].map(x => x.toLowerCase());
  const find = (...names) => names.map(n => header.indexOf(n)).find(i => i >= 0);
  const qI = find('题目','问题','question') ?? 0;
  const aI = find('a','选项a','option a','选项1');
  const bI = find('b','选项b','option b','选项2');
  const cI = find('c','选项c','option c','选项3');
  const dI = find('d','选项d','option d','选项4');
  const ansI = find('正确答案','答案','answer');
  const typeI = find('题型','类型','type');
  const timeI = find('时间','答题时间','time');
  return rows.slice(1).map((r,i)=>{
    const options=[aI,bI,cI,dI].filter(x=>x!==undefined).map(x=>r[x]||'').filter(Boolean);
    const rawType=typeI===undefined?'':r[typeI];
    const type=/多选|multi/i.test(rawType)?'multi':/判断|true/i.test(rawType)?'truefalse':/排序|order/i.test(rawType)?'order':'single';
    if(type==='truefalse'&&options.length===0) options.push('正确','错误');
    return {id:`import_row_${i+1}`,type,text:r[qI]||'',options,answer:parseAnswerToken(ansI===undefined?'':r[ansI],options,type),time:Math.max(5,Math.min(180,Number(timeI===undefined?15:r[timeI])||15)),image:'',audio:'',video:''};
  }).filter(q=>q.text&&q.options.length);
}

app.post('/api/import/parse', auth, role('teacher','admin'), async (req,res)=>{
  try {
    const text=String(req.body.text||'');
    const questions=parseQuestionText(text);
    if(!questions.length) return res.status(400).json({error:'没有识别到题目。建议使用“1.题目 + A-D + 答案：B”的格式。'});
    res.json({questions, count:questions.length});
  } catch(e){ res.status(400).json({error:e.message||'解析失败'}); }
});

app.post('/api/import/file', auth, role('teacher','admin'), upload.single('file'), async (req,res)=>{
  try {
    if(!req.file) return res.status(400).json({error:'没有上传文件'});
    const ext=String(path.extname(req.file.originalname||'')).toLowerCase();
    let questions=[];
    if(ext==='.xlsx'||ext==='.xls') {
      const wb=XLSX.read(req.file.buffer,{type:'buffer'});
      const ws=wb.Sheets[wb.SheetNames[0]];
      const rows=XLSX.utils.sheet_to_json(ws,{header:1,defval:''});
      const text=rows.map(r=>r.join('\t')).join('\n');
      questions=parseCsvOrTsv(text);
    } else if(ext==='.docx') {
      const r=await mammoth.extractRawText({buffer:req.file.buffer});
      questions=parseQuestionText(r.value);
    } else {
      questions=parseQuestionText(req.file.buffer.toString('utf8'));
      if(!questions.length && (ext==='.csv'||ext==='.tsv')) questions=parseCsvOrTsv(req.file.buffer.toString('utf8'));
    }
    if(!questions.length) return res.status(400).json({error:'文件已读取，但没有识别出题目。请检查格式。'});
    res.json({filename:req.file.originalname,count:questions.length,questions});
  } catch(e){ res.status(400).json({error:e.message||'文件解析失败'}); }
});

app.post('/api/quizzes',auth,role('teacher','admin'),(req,res)=>{
  const title=String(req.body.title||'').trim(); const questions=Array.isArray(req.body.questions)?req.body.questions:[]; if(!title||!questions.length)return res.status(400).json({error:'题库名称和题目不能为空'});
  const quiz={id:crypto.randomUUID(),ownerId:req.user.id,title,description:String(req.body.description||''),tags:Array.isArray(req.body.tags)?req.body.tags.map(String).slice(0,10):[],questions:questions.map((q,i)=>({...q,id:q.id||`q_${i+1}`,type:normalizeType(q),time:Math.max(5,Math.min(180,Number(q.time)||15)),text:String(q.text||''),options:Array.isArray(q.options)?q.options.map(String).slice(0,8):[],image:String(q.image||''),audio:String(q.audio||''),video:String(q.video||'')}))};
  db.quizzes.push(quiz);saveData();res.json(quiz);
});
app.put('/api/quizzes/:id',auth,role('teacher','admin'),(req,res)=>{const q=db.quizzes.find(x=>x.id===req.params.id);if(!q)return res.status(404).json({error:'题库不存在'});if(req.user.role!=='admin'&&q.ownerId!==req.user.id)return res.status(403).json({error:'无权限'});Object.assign(q,{title:req.body.title||q.title,description:req.body.description??q.description,tags:req.body.tags||q.tags,questions:req.body.questions||q.questions});saveData();res.json(q)});
app.delete('/api/quizzes/:id',auth,role('teacher','admin'),(req,res)=>{const i=db.quizzes.findIndex(x=>x.id===req.params.id);if(i<0)return res.status(404).json({error:'题库不存在'});if(req.user.role!=='admin'&&db.quizzes[i].ownerId!==req.user.id)return res.status(403).json({error:'无权限'});db.quizzes.splice(i,1);saveData();res.json({ok:true})});

app.post('/api/games',auth,role('teacher','admin'),(req,res)=>{
  const quiz=db.quizzes.find(x=>x.id===req.body.quizId); if(!quiz)return res.status(404).json({error:'题库不存在'});
  const pin=makePin(); const game={pin,quiz,ownerId:req.user.id,teacherSocket:null,players:new Map(),status:'lobby',current:-1,answered:new Set(),questionStartedAt:null,questionEndsAt:null,timer:null,expiryTimer:null,lastActivity:Date.now(),startedAt:null,settings:{shuffleAnswers:Boolean(req.body.shuffleAnswers),nicknameMax:20}}; games.set(pin,game); scheduleExpiry(game); res.json({pin,title:quiz.title});
});
app.get('/api/games/:pin',(req,res)=>{const game=games.get(String(req.params.pin));if(!game)return res.status(404).json({error:'房间不存在或已过期'});res.json(getPublicState(game));});
app.get('/api/history',auth,(req,res)=>{const h=db.history.filter(x=>req.user.role==='admin'||x.players.some(p=>p.userId===req.user.id)||db.quizzes.some(q=>q.id===x.quizId&&q.ownerId===req.user.id));res.json(h.slice().reverse())});
app.get('/api/stats',auth,(req,res)=>{let rows=[];if(req.user.role==='teacher'||req.user.role==='admin'){const h=db.history.filter(x=>req.user.role==='admin'||db.quizzes.some(q=>q.id===x.quizId&&q.ownerId===req.user.id));const plays=h.flatMap(x=>x.players);rows=[{label:'场次',value:h.length},{label:'参与人次',value:plays.length},{label:'平均分',value:plays.length?Math.round(plays.reduce((a,b)=>a+b.score,0)/plays.length):0},{label:'平均答对',value:plays.length?Math.round(plays.reduce((a,b)=>a+b.correct,0)/plays.length*10)/10:0}];}else{const plays=db.history.flatMap(x=>x.players.filter(p=>p.userId===req.user.id));rows=[{label:'参加场次',value:plays.length},{label:'总得分',value:plays.reduce((a,b)=>a+b.score,0)},{label:'平均分',value:plays.length?Math.round(plays.reduce((a,b)=>a+b.score,0)/plays.length):0},{label:'平均答对',value:plays.length?Math.round(plays.reduce((a,b)=>a+b.correct,0)/plays.length*10)/10:0}];}res.json(rows)});
app.get('/api/admin/summary',auth,role('admin'),(req,res)=>res.json({users:db.users.length,teachers:db.users.filter(u=>u.role==='teacher').length,students:db.users.filter(u=>u.role==='student').length,quizzes:db.quizzes.length,games:db.history.length,activeRooms:games.size}));
app.get('/api/admin/users',auth,role('admin'),(req,res)=>res.json(db.users.map(publicUser)));

io.on('connection',socket=>{
  socket.on('teacher:host',({pin})=>{const game=games.get(String(pin));if(!game)return socket.emit('error:message','房间不存在');game.teacherSocket=socket.id;game.lastActivity=Date.now();socket.join(`game:${pin}`);socket.emit('teacher:ready',getPublicState(game));});
  socket.on('teacher:start',({pin})=>{const g=games.get(String(pin));if(!g||g.teacherSocket!==socket.id)return;g.startedAt=Date.now();startQuestion(g);});
  socket.on('teacher:next',({pin})=>{const g=games.get(String(pin));if(!g||g.teacherSocket!==socket.id)return;startQuestion(g);});
  socket.on('player:join',({pin,name,avatar,userId})=>{const g=games.get(String(pin));if(!g)return socket.emit('join:error','PIN码不存在或房间已过期');if(g.status!=='lobby')return socket.emit('join:error','游戏已经开始，暂时不能加入');const clean=String(name||'').trim().slice(0,g.settings.nicknameMax);if(!clean)return socket.emit('join:error','请输入昵称');if(userId && [...g.players.values()].some(p=>p.userId===userId))return socket.emit('join:error','这个账号已经在房间里');const p={id:socket.id,userId:userId||null,name:clean,avatar:avatars.includes(avatar)?avatar:avatars[0],score:0,correct:0,streak:0,answered:false,personalEndsAt:null,powerups:{double:true,time:true,shield:true},doubleActive:false,shieldActive:false,connected:true,disconnectedAt:null};g.players.set(socket.id,p);g.lastActivity=Date.now();socket.data.pin=pin;socket.join(`game:${pin}`);socket.emit('player:joined',{pin,player:{...p,powerups:p.powerups},game:getPublicState(g,socket.id)});emitState(g);});

  socket.on('player:resume',({pin,userId})=>{
    const g=games.get(String(pin));
    if(!g||!userId)return socket.emit('resume:failed','房间不存在或已过期');
    const entry=[...g.players.entries()].find(([sid,p])=>p.userId===userId && p.connected===false && Date.now()-(p.disconnectedAt||0)<120000);
    if(!entry)return socket.emit('resume:failed','没有找到可恢复的玩家状态');
    const [oldSid,p]=entry;g.players.delete(oldSid);p.id=socket.id;p.connected=true;p.disconnectedAt=null;g.players.set(socket.id,p);socket.data.pin=pin;socket.join(`game:${pin}`);socket.emit('player:resumed',{game:getPublicState(g),player:{id:p.id,name:p.name,avatar:p.avatar,score:p.score,correct:p.correct,streak:p.streak,powerups:p.powerups}});emitState(g);
  });
  socket.on('player:powerup',({pin,type})=>{const g=games.get(String(pin));const p=g&&g.players.get(socket.id);if(!g||!p||g.status!=='question'||!powerups.includes(type)||!p.powerups[type])return;p.powerups[type]=false;if(type==='time')p.personalEndsAt=(g.questionEndsAt||Date.now())+3000; if(type==='shield')p.shieldActive=true; if(type==='double')p.doubleActive=true; socket.emit('powerup:used',{type,personalEndsAt:p.personalEndsAt});emitState(g);});
  socket.on('player:answer',({pin,answer})=>{const g=games.get(String(pin));const p=g&&g.players.get(socket.id);if(!g||!p||g.status!=='question'||p.answered)return;const q=g.quiz.questions[g.current];const deadline=p.personalEndsAt||g.questionEndsAt;if(Date.now()>deadline)return socket.emit('answer:result',{late:true,score:p.score,gained:0});p.answered=true;g.answered.add(socket.id);const correct=evaluateAnswer(q,answer);let gained=0;if(correct){const base=1000+Math.round(Math.max(0,(deadline-Date.now())/(q.time*1000))*500);gained=base+Math.min(p.streak+1,5)*50;if(p.doubleActive)gained*=2;p.correct++;p.streak++;}else{p.streak=0;if(p.shieldActive)gained=200;}p.doubleActive=false;p.shieldActive=false;p.score+=gained;socket.emit('answer:result',{correct,correctOption:q.answer,score:p.score,gained,usedShield:!correct&&gained===200});emitState(g);if(g.answered.size>=g.players.size&&g.players.size>0)endQuestion(g);});
  socket.on('player:doubleNow',({pin})=>{const g=games.get(String(pin));const p=g&&g.players.get(socket.id);if(!g||!p||g.status!=='question'||!p.powerups.double)return;p.powerups.double=false;p._doubleCurrent=true;socket.emit('powerup:used',{type:'double'});});
  socket.on('disconnect',()=>{for(const g of games.values()){const p=g.players.get(socket.id);if(p){p.connected=false;p.disconnectedAt=Date.now();p.id=socket.id;g.lastActivity=Date.now();}if(g.teacherSocket===socket.id)g.teacherSocket=null;emitState(g);}});
});

setInterval(()=>{const now=Date.now();for(const [token,s] of sessions){if(s.expiresAt<now)sessions.delete(token);}for(const [pin,g] of games){if(now-g.lastActivity>ROOM_TTL){clearTimer(g);clearTimeout(g.expiryTimer);games.delete(pin);}}},60_000);

const url=sslKey&&sslCert&&fs.existsSync(sslKey)&&fs.existsSync(sslCert)?`https://localhost:${PORT}`:`http://localhost:${PORT}`;

function lanUrls(port) {
  try {
    const os = require('os');
    const nets = os.networkInterfaces();
    const urls = [];
    for (const entries of Object.values(nets)) {
      for (const net of (entries || [])) {
        if (net.family === 'IPv4' && !net.internal) urls.push(`${sslKey&&sslCert?'https':'http'}://${net.address}:${port}`);
      }
    }
    return [...new Set(urls)];
  } catch { return []; }
}

server.listen(PORT, HOST, ()=>{
  console.log(`QuizRush server running at ${url}`);
  console.log(`LAN access: ${lanUrls(PORT).join('  |  ') || "Unable to detect LAN address; use your computer's local IPv4 address"}`);
});
