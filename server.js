const path = require('path');
const express = require('express'), bcrypt = require('bcryptjs'), jwt = require('jsonwebtoken'), cookie = require('cookie-parser'), crypto = require('crypto'), fs = require('fs');
const TZ = process.env.INSTITUTE_TZ || 'Asia/Karachi', PROD = process.env.NODE_ENV === 'production', PORT = process.env.PORT || 3000;
const SECRET = process.env.JWT_SECRET || (() => { if (PROD) throw new Error('JWT_SECRET is not set'); try { return fs.existsSync('.secret') ? fs.readFileSync('.secret', 'utf8') : (s => (fs.writeFileSync('.secret', s), s))(crypto.randomBytes(32).toString('hex')) } catch { return crypto.randomBytes(32).toString('hex') } })();
// ---- database: Turso (cloud, used on Vercel) when TURSO_DATABASE_URL is set, otherwise a local portal.db file
let ex, multi, batch;
if (process.env.TURSO_DATABASE_URL) {
  const { createClient } = require('@libsql/client'); const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });
  ex = async (sql, a) => { const r = await db.execute({ sql, args: a }); return { rows: r.rows.map(x => ({ ...x })), changes: r.rowsAffected, id: Number(r.lastInsertRowid || 0) } };
  multi = sql => db.executeMultiple(sql); batch = st => db.batch(st.map(([sql, ...args]) => ({ sql, args })), 'write')
}
else {
  const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(process.env.DB_FILE || 'portal.db'); db.exec('PRAGMA journal_mode=WAL;PRAGMA foreign_keys=ON;');
  ex = async (sql, a) => { const st = db.prepare(sql); if (/^\s*(select|with)/i.test(sql) || /\breturning\b/i.test(sql)) return { rows: st.all(...a).map(r => ({ ...r })) }; const r = st.run(...a); return { rows: [], changes: r.changes, id: Number(r.lastInsertRowid) } };
  multi = async sql => db.exec(sql); batch = async st => { db.exec('BEGIN'); try { for (const [sql, ...a] of st) db.prepare(sql).run(...a); db.exec('COMMIT') } catch (e) { db.exec('ROLLBACK'); throw e } }
}
const P = sql => ({ get: async (...a) => (await ex(sql, a)).rows[0], all: async (...a) => (await ex(sql, a)).rows, run: async (...a) => { const r = await ex(sql, a); return { changes: r.changes, lastInsertRowid: r.id } } });
const SCHEMA = `create table if not exists users(id integer primary key,role text not null check(role in('admin','teacher','student')),name text not null,email text unique not null,phone text,photo text,pw text not null,code text,admission_date text);
create table if not exists courses(id integer primary key,name text unique not null,fee integer not null default 0,teacher_id integer references users(id) on delete set null);
create table if not exists enrollments(student_id integer references users(id) on delete cascade,course_id integer references courses(id) on delete cascade,fee integer not null,since text,primary key(student_id,course_id));
create table if not exists attendance(student_id integer references users(id) on delete cascade,course_id integer references courses(id) on delete cascade,date text,status text check(status in('Present','Absent','Leave')),marked_by integer,primary key(student_id,course_id,date));
create table if not exists payments(id integer primary key,student_id integer references users(id) on delete cascade,course_id integer references courses(id) on delete cascade,amount integer not null,date text not null,note text);
create table if not exists teacher_attendance(teacher_id integer references users(id) on delete cascade,date text,check_in text,check_out text,primary key(teacher_id,date));
create table if not exists applications(id integer primary key,name text,phone text,email text,course_id integer references courses(id) on delete set null,status text default 'Pending',created_at text,role text default 'student',pw text);
create table if not exists quizzes(id integer primary key,title text not null,created_by integer,per_student integer not null,created_at text,duration integer default 0,expires_at text,pass_pct integer default 60);
create table if not exists quiz_questions(id integer primary key,quiz_id integer,q text not null,opts text not null,answer integer not null);
create table if not exists quiz_students(quiz_id integer,student_id integer,expires_at text,primary key(quiz_id,student_id));
create table if not exists settings(k text primary key,v text);
create table if not exists quiz_attempts(quiz_id integer,student_id integer,plan text not null,answers text,score integer,total integer,passed integer,started_at text,submitted_at text,exits integer default 0,active integer default 0,reason text,primary key(quiz_id,student_id));
create index if not exists ix_qq on quiz_questions(quiz_id);
create index if not exists ix_en on enrollments(course_id);create index if not exists ix_pay on payments(student_id);`;
class E extends Error { constructor(m, s = 400) { super(m); this.status = s } }
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: TZ });
const now = () => new Date().toLocaleTimeString('en-US', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
const envn = (k, d) => process.env[k] !== undefined && process.env[k] !== '' ? +process.env[k] : d; const CUT = envn('CUTOFF_HOUR', 22);
const hr = () => +new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: 'numeric', hourCycle: 'h23' }).format(new Date());
const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const isSun = d => new Date(d + 'T00:00:00Z').getUTCDay() === 0;
const lastClosed = () => hr() >= CUT ? today() : addDays(today(), -1);
const workdays = (from, to) => { const r = []; for (let d = from < addDays(to, -120) ? addDays(to, -120) : from; d <= to; d = addDays(d, 1))if (!isSun(d)) r.push(d); return r };
const IN_FROM = envn('CHECKIN_FROM_HOUR', 15), IN_TO = envn('CHECKIN_TO_HOUR', 21);
const minNow = () => { const p = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).formatToParts(new Date()); return +p.find(x => x.type === 'hour').value * 60 + +p.find(x => x.type === 'minute').value };
const checkinOpen = () => { const m = minNow(); return m >= IN_FROM * 60 && m <= IN_TO * 60 };
const fmtH = h => (h % 12 || 12) + ':00 ' + (h < 12 || h === 24 ? 'AM' : 'PM');
const to12 = t => { const m = /^(\d{2}):(\d{2})$/.exec(t || ''); if (!m || +m[1] > 23 || +m[2] > 59) return null; const h = +m[1]; return String(h % 12 || 12).padStart(2, '0') + ':' + m[2] + ' ' + (h < 12 ? 'AM' : 'PM') };
const isDate = d => /^\d{4}-\d{2}-\d{2}$/.test(d || '') && !isNaN(new Date(d));
const hash = p => bcrypt.hashSync(p, 10), tmp = () => crypto.randomBytes(5).toString('hex');
const dup = async f => { try { return await f() } catch (e) { if (/UNIQUE|constraint/i.test(e.message)) throw new E('Already exists (name or email is taken)'); throw e } };
const person = b => {
  const name = String(b.name || '').trim(), email = String(b.email || '').trim().toLowerCase(), phone = String(b.phone || '').trim();
  if (name.length < 2 || name.length > 80) throw new E('Enter a valid name'); if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new E('Enter a valid email');
  if (!/^[0-9+\-\s]{7,20}$/.test(phone)) throw new E('Enter a valid phone number');
  if (b.photo && (!/^data:image\/(jpeg|png|webp);base64,/.test(b.photo) || b.photo.length > 150000)) throw new E('Invalid photo'); return { name, email, phone, photo: b.photo || null }
};
const needCourse = async id => { const c = await P('select * from courses where id=?').get(+id); if (!c) throw new E('Course not found'); return c };
const canCourse = async (u, cid) => { const c = await needCourse(cid); if (u.role === 'teacher' && c.teacher_id !== u.id) throw new E('Not your course', 403); return c };
const tries = new Map(); const limit = (k, max, ms) => { const t = Date.now(), a = (tries.get(k) || []).filter(x => t - x < ms); if (a.length >= max) throw new E('Too many attempts. Try again later.', 429); a.push(t); tries.set(k, a) };
const setCourses = async (sid, ids) => {
  ids = [...new Set((ids || []).map(Number))].filter(Number.isInteger);
  const ok = ids.length ? (await P(`select id from courses where id in(${ids.map(() => '?').join(',')})`).all(...ids)).map(r => r.id) : [];
  await batch([[`delete from enrollments where student_id=? and course_id not in(${ok.join(',') || 0})`, sid], ...ok.map(c => ['insert or ignore into enrollments(student_id,course_id,fee,since) select ?,id,fee,? from courses where id=?', sid, today(), c])])
};
const createStudent = async (b, ids, adm, pwHash) => {
  const p = person(b), pw = tmp();
  const r = await dup(() => P("insert into users(role,name,email,phone,photo,pw,admission_date) values('student',?,?,?,?,?,?) returning id").get(p.name, p.email, p.phone, p.photo, pwHash || hash(pw), isDate(adm) ? adm : today()));
  await P('update users set code=? where id=?').run('SP-' + new Date().getFullYear() + '-' + String(r.id).padStart(4, '0'), r.id); await setCourses(r.id, ids); return { id: r.id, password: pwHash ? null : pw }
};
const seed = async () => {
  const ins = async (r, n, e, p, pw) => (await P('insert into users(role,name,email,phone,pw,admission_date) values(?,?,?,?,?,?)').run(r, n, e, p, hash(pw), today())).lastInsertRowid;
  await ins('admin', 'Admin', process.env.ADMIN_EMAIL || 'admin@skillpoint.edu', '0300-0000000', process.env.ADMIN_PASSWORD || 'Admin@123');
  if (PROD && process.env.SEED_SAMPLE !== '1') return;
  const t1 = await ins('teacher', 'Ali Ahmed', 'ali@skillpoint.edu', '0301-1111111', 'Teacher@123'), t2 = await ins('teacher', 'Sara Khan', 'sara@skillpoint.edu', '0302-2222222', 'Teacher@123');
  const c = async (n, f, t) => (await P('insert into courses(name,fee,teacher_id) values(?,?,?)').run(n, f, t)).lastInsertRowid, web = await c('Web Development', 30000, t1), gd = await c('Graphic Design', 20000, t2), en = await c('Spoken English', 12000, t2);
  let first; for (const [n, e, cs] of [['Hamza Malik', 'hamza@example.com', [web]], ['Ayesha Noor', 'ayesha@example.com', [gd, en]], ['Bilal Raza', 'bilal@example.com', [web, en]]]) { const r = await createStudent({ name: n, email: e, phone: '0310-555000' }, cs); first = first || r.id; await P('update users set pw=? where id=?').run(hash('Student@123'), r.id) }
  await P("insert into payments(student_id,course_id,amount,date,note) values(?,?,10000,?,'Advance')").run(first, web, today());
  if (!PROD) console.log('\nSample logins:\n admin@skillpoint.edu / Admin@123\n ali@skillpoint.edu / Teacher@123\n hamza@example.com / Student@123\n(change these after first login)\n')
};
const getSet = async (k, d) => { const r = await P('select v from settings where k=?').get(k); return r ? r.v : d };
const setSet = (k, v) => P('insert or replace into settings values(?,?)').run(k, String(v));
const IT_COURSES = [["Web Development", 30000], ["Web Design (HTML & CSS)", 15000], ["JavaScript Programming", 20000], ["React JS", 30000], ["Node JS & Express", 30000], ["Full Stack Web Development (MERN)", 60000], ["PHP & Laravel", 35000], ["Python Programming", 35000], ["Python Django", 35000], ["Java Programming", 30000], ["C++ Programming", 25000], ["C# & .NET", 35000], ["Database & SQL", 20000], ["WordPress Development", 20000], ["Android App Development", 45000], ["Flutter App Development", 45000], ["Graphic Design", 25000], ["UI/UX Design", 30000], ["Video Editing", 25000], ["3D Animation (Blender)", 35000], ["Game Development (Unity)", 40000], ["Digital Marketing", 25000], ["SEO (Search Engine Optimization)", 20000], ["Social Media Marketing", 20000], ["E-Commerce (Shopify & Amazon)", 25000], ["Freelancing", 15000], ["Data Science & Machine Learning", 70000], ["Artificial Intelligence (AI)", 60000], ["Data Analytics (Excel, Power BI)", 35000], ["Cyber Security & Ethical Hacking", 50000], ["Computer Networking (CCNA)", 35000], ["Linux Administration", 30000], ["Cloud Computing (AWS)", 45000], ["DevOps", 50000], ["Software Testing (QA)", 30000], ["Computer Hardware & Troubleshooting", 20000], ["MS Office & Computer Basics", 10000], ["Data Entry & Typing", 8000]];
const itCourses = async () => { if (await getSet('it_courses', '')) return; await batch([...IT_COURSES.map(([n, f]) => ['insert or ignore into courses(name,fee) values(?,?)', n, f]), ['insert or replace into settings values(?,?)', 'it_courses', '1']]) };
let ready; const init = () => ready || (ready = (async () => {
  await multi(SCHEMA);
  const need = [['quizzes', 'duration', 'integer default 0'], ['quizzes', 'expires_at', 'text'], ['quizzes', 'pass_pct', 'integer default 60'], ['quiz_attempts', 'exits', 'integer default 0'], ['quiz_attempts', 'active', 'integer default 0'], ['quiz_attempts', 'reason', 'text'], ['applications', 'role', "text default 'student'"], ['applications', 'pw', 'text'], ['quiz_students', 'expires_at', 'text']];
  const have = await P('select ' + need.map(([t, c], i) => `(select count(*) from pragma_table_info('${t}') where name='${c}') c${i}`).join(',')).get();
  for (const [i, [t, c, d]] of need.entries()) if (!have['c' + i]) await multi(`alter table ${t} add column ${c} ${d}`);
  if (!have.c8) await multi('update quiz_students set expires_at=(select z.expires_at from quizzes z where z.id=quiz_students.quiz_id)');
  if (!await P('select id from users limit 1').get()) await seed(); await itCourses()
})().catch(e => { ready = null; throw e }));

const app = express(); app.disable('x-powered-by'); app.use(express.json({ limit: '400kb' }), cookie());
app.use((q, s, n) => { s.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin', 'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'" }); n() });
app.use('/api', (q, s, n) => { if (q.method !== 'GET' && q.get('x-sp') !== '1') return s.status(403).json({ error: 'Blocked request' }); n() });
app.use('/api', async (q, s, n) => { await init(); n() });
const auth = (...roles) => async (q, s, n) => {
  let u; try { const t = jwt.verify(q.cookies.sp, SECRET); u = await P('select id,role,name,email,phone,photo,code from users where id=?').get(t.id) } catch { }
  if (!u) return s.status(401).json({ error: 'Please sign in' }); if (roles.length && !roles.includes(u.role)) return s.status(403).json({ error: 'Not allowed' }); q.user = u; n()
};

// ---- auth
app.post('/api/login', async (q, s) => {
  const email = String(q.body.email || '').trim().toLowerCase(); limit(q.ip + email, 10, 9e5);
  const u = await P('select * from users where email=?').get(email); const ok = bcrypt.compareSync(String(q.body.password || ''), u ? u.pw : '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvali');
  if (!u) {
    const ap = await P("select status,pw from applications where email=? and pw is not null order by id desc").get(email);
    if (ap && bcrypt.compareSync(String(q.body.password || ''), ap.pw)) { if (ap.status === 'Pending') throw new E('Your sign-up is waiting for approval from the institute.', 403); if (ap.status === 'Rejected') throw new E('Your sign-up was not approved. Please contact the institute.', 403) }
  }
  if (!u || !ok) throw new E('Wrong email or password', 401);
  const as = q.body.as; if (as === 'student' && u.role !== 'student') throw new E('This is not a student account. Please choose Teacher.', 403); if (as === 'teacher' && u.role === 'student') throw new E('This is a student account. Please choose Student.', 403);
  s.cookie('sp', jwt.sign({ id: u.id }, SECRET, { expiresIn: '30d' }), { httpOnly: true, sameSite: 'strict', secure: PROD, maxAge: 2592e6 }); s.json({ ok: 1, role: u.role })
});
app.post('/api/logout', (q, s) => { s.clearCookie('sp'); s.json({ ok: 1 }) });
app.get('/api/me', auth(), async (q, s) => { const u = q.user; if (u.role === 'teacher') { u.closed = isSun(today()); u.window = { open: checkinOpen(), from: fmtH(IN_FROM), to: fmtH(IN_TO) }; u.today = await P('select * from teacher_attendance where teacher_id=? and date=?').get(u.id, today()) || null } s.json(u) });
app.post('/api/password', auth(), async (q, s) => {
  const { current, next } = q.body; const u = await P('select pw from users where id=?').get(q.user.id);
  if (!bcrypt.compareSync(String(current || ''), u.pw)) throw new E('Current password is wrong'); if (String(next || '').length < 8) throw new E('New password needs 8+ characters');
  await P('update users set pw=? where id=?').run(hash(next), q.user.id); s.json({ ok: 1 })
});

app.post('/api/email', auth(), async (q, s) => {
  limit('e' + q.user.id, 6, 9e5); const email = String(q.body.email || '').trim().toLowerCase(); if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new E('Enter a valid email');
  const u = await P('select pw from users where id=?').get(q.user.id); if (!bcrypt.compareSync(String(q.body.password || ''), u.pw)) throw new E('Password is wrong');
  await dup(() => P('update users set email=? where id=?').run(email, q.user.id)); s.json({ ok: 1 })
});

app.post('/api/photo', auth(), async (q, s) => { const p = q.body.photo; if (p && (!/^data:image\/(jpeg|png|webp);base64,/.test(p) || p.length > 150000)) throw new E('Invalid photo'); await P('update users set photo=? where id=?').run(p || null, q.user.id); s.json({ ok: 1 }) });
app.get('/api/public/config', async (q, s) => s.json({ teacherSignup: (await getSet('teacher_signup', '1')) === '1' }));
app.put('/api/settings', auth('admin'), async (q, s) => { if (q.body.teacher_signup !== undefined) await setSet('teacher_signup', q.body.teacher_signup ? '1' : '0'); s.json({ ok: 1 }) });

// ---- public admission
app.get('/api/public/courses', async (q, s) => s.json(await P('select id,name from courses order by name').all()));
app.post('/api/apply', async (q, s) => {
  limit('a' + q.ip, 8, 36e5); const b = person(q.body); await needCourse(q.body.course_id);
  await P('insert into applications(name,phone,email,course_id,created_at) values(?,?,?,?,?)').run(b.name, b.phone, b.email, +q.body.course_id, today()); s.json({ ok: 1 })
});

app.post('/api/signup', async (q, s) => {
  limit('s' + q.ip, 8, 36e5); const b = q.body, role = b.role; if (!['student', 'teacher'].includes(role)) throw new E('Choose student or teacher');
  if (role === 'teacher' && (await getSet('teacher_signup', '1')) !== '1') throw new E('Teacher sign-up is closed right now. Please contact the institute.', 403); const p = person(b), pw = String(b.password || '');
  if (pw.length < 8 || pw.length > 72) throw new E('Password needs 8 to 72 characters'); if (role === 'student') await needCourse(b.course_id);
  if (await P('select id from users where email=?').get(p.email) || await P("select id from applications where email=? and status='Pending'").get(p.email)) throw new E('This email is already registered or waiting for approval');
  await P('insert into applications(name,phone,email,course_id,created_at,role,pw) values(?,?,?,?,?,?,?)').run(p.name, p.phone, p.email, role === 'student' ? +b.course_id : null, today(), role, hash(pw)); s.json({ ok: 1 })
});

// ---- courses
app.get('/api/courses', auth(), async (q, s) => {
  const u = q.user; let w = '', a = []; if (u.role === 'teacher') { w = 'where c.teacher_id=?'; a = [u.id] } if (u.role === 'student') { w = 'where c.id in(select course_id from enrollments where student_id=?)'; a = [u.id] }
  s.json(await P(`select c.*,t.name teacher,(select count(*) from enrollments where course_id=c.id) students from courses c left join users t on t.id=c.teacher_id ${w} order by c.name`).all(...a))
});
const courseBody = async b => {
  const name = String(b.name || '').trim(), fee = Math.round(+b.fee), tid = b.teacher_id ? +b.teacher_id : null;
  if (name.length < 2) throw new E('Enter a course name'); if (!(fee >= 0)) throw new E('Enter a valid fee'); if (tid && !await P("select id from users where id=? and role='teacher'").get(tid)) throw new E('Teacher not found'); return [name, fee, tid]
};
app.post('/api/courses', auth('admin'), async (q, s) => { const b = await courseBody(q.body); await dup(() => P('insert into courses(name,fee,teacher_id) values(?,?,?)').run(...b)); s.json({ ok: 1 }) });
app.put('/api/courses/:id', auth('admin'), async (q, s) => { const b = await courseBody(q.body); await dup(() => P('update courses set name=?,fee=?,teacher_id=? where id=?').run(...b, +q.params.id)); s.json({ ok: 1 }) });
app.delete('/api/courses/:id', auth('admin'), async (q, s) => { const id = +q.params.id; await batch([['delete from attendance where course_id=?', id], ['delete from payments where course_id=?', id], ['delete from enrollments where course_id=?', id], ['update applications set course_id=null where course_id=?', id], ['delete from courses where id=?', id]]); s.json({ ok: 1 }) });

// ---- people
const myStudents = `select distinct u.id from users u join enrollments e on e.student_id=u.id join courses c on c.id=e.course_id where c.teacher_id=`;
app.get('/api/students', auth('admin', 'teacher'), async (q, s) => {
  const like = '%' + String(q.query.q || '').replace(/[%_]/g, '') + '%', u = q.user;
  s.json(await P(`select u.id,u.name,u.code,u.phone,u.email,u.photo,u.admission_date,(select group_concat(c.name,', ') from enrollments e join courses c on c.id=e.course_id where e.student_id=u.id) courses,(select group_concat(course_id) from enrollments where student_id=u.id) course_ids
 from users u where u.role='student' and u.name like ? ${u.role === 'teacher' ? 'and u.id in(' + myStudents + '?)' : ''} order by u.name`).all(...(u.role === 'teacher' ? [like, u.id] : [like])))
});
app.post('/api/students', auth('admin'), async (q, s) => s.json(await createStudent(q.body, q.body.course_ids, q.body.admission_date)));
app.put('/api/students/:id', auth('admin', 'teacher'), async (q, s) => {
  const p = person(q.body), id = +q.params.id;
  if (q.user.role === 'teacher') { if (!await P(myStudents + '? and u.id=?').get(q.user.id, id)) throw new E('Not your student', 403); await dup(() => P("update users set name=?,email=?,phone=?,photo=? where id=? and role='student'").run(p.name, p.email, p.phone, p.photo, id)); return s.json({ ok: 1 }) }
  await dup(() => P("update users set name=?,email=?,phone=?,photo=?,admission_date=coalesce(?,admission_date) where id=? and role='student'").run(p.name, p.email, p.phone, p.photo, isDate(q.body.admission_date) ? q.body.admission_date : null, id));
  if (q.body.password) { if (String(q.body.password).length < 8) throw new E('Password needs 8+ characters'); await P('update users set pw=? where id=?').run(hash(q.body.password), id) } await setCourses(id, q.body.course_ids); s.json({ ok: 1 })
});
const detail = async (id, withFees = true, onlyTeacher = 0) => {
  const u = await P("select id,name,email,phone,photo,code,admission_date from users where id=? and role='student'").get(id); if (!u) return null;
  u.courses = await P('select c.id,c.name,e.fee,e.since,t.name teacher,coalesce((select sum(amount) from payments where student_id=e.student_id and course_id=c.id),0) paid from enrollments e join courses c on c.id=e.course_id left join users t on t.id=c.teacher_id where e.student_id=?').all(id);
  const total = u.courses.reduce((a, c) => a + c.fee, 0), pays = await P('select p.*,c.name course from payments p join courses c on c.id=p.course_id where p.student_id=? order by p.date desc,p.id desc').all(id), paid = pays.reduce((a, p) => a + p.amount, 0);
  u.fees = { total, paid, remaining: total - paid, status: paid >= total && total > 0 ? 'Paid' : paid > 0 ? 'Partial' : 'Unpaid', advance: Math.max(0, paid - total), payments: pays };
  const rec = await P('select a.date,a.status,a.course_id,c.name course from attendance a join courses c on c.id=a.course_id where a.student_id=?').all(id), have = new Set(rec.map(r => r.course_id + '|' + r.date));
  for (const c of u.courses) for (const d of workdays(c.since || u.admission_date || today(), lastClosed())) if (!have.has(c.id + '|' + d)) rec.push({ date: d, course_id: c.id, course: c.name, status: 'Absent', auto: 1 });
  u.quizzes = await P(`select z.title,a.score,a.total,a.passed,a.submitted_at,a.reason,z.pass_pct from quiz_attempts a join quizzes z on z.id=a.quiz_id where a.student_id=? and a.submitted_at is not null ${onlyTeacher ? 'and z.created_by=?' : ''} order by a.submitted_at desc`).all(...(onlyTeacher ? [id, onlyTeacher] : [id]));
  u.attendance = rec.filter(r => !isSun(r.date)).sort((a, b) => b.date.localeCompare(a.date)); u.summary = { Present: 0, Absent: 0, Leave: 0 }; u.attendance.forEach(r => u.summary[r.status]++);
  if (!withFees) { delete u.fees; u.courses.forEach(c => { delete c.fee; delete c.paid }) } return u
};
app.get('/api/students/:id', auth(), async (q, s) => {
  const u = q.user, id = q.params.id === 'me' ? u.id : +q.params.id;
  if (u.role === 'student' && id !== u.id) throw new E('Not allowed', 403);
  if (u.role === 'teacher' && !await P(myStudents + '? and u.id=?').get(u.id, id)) throw new E('Not your student', 403);
  const d = await detail(id, u.role !== 'teacher', u.role === 'teacher' ? u.id : 0); if (!d) throw new E('Student not found', 404);
  if (u.role === 'teacher') d.attendance = d.attendance.filter(a => d.courses.some(c => c.id === a.course_id)); s.json(d)
});
app.get('/api/teachers', auth('admin'), async (q, s) => s.json(await P("select u.id,u.name,u.email,u.phone,u.photo,(select group_concat(name,', ') from courses where teacher_id=u.id) courses from users u where role='teacher' order by name").all()));
app.post('/api/teachers', auth('admin'), async (q, s) => { const p = person(q.body), pw = tmp(); const r = await dup(() => P("insert into users(role,name,email,phone,photo,pw,admission_date) values('teacher',?,?,?,?,?,?) returning id").get(p.name, p.email, p.phone, p.photo, hash(pw), today())); s.json({ id: r.id, password: pw }) });
app.put('/api/teachers/:id', auth('admin'), async (q, s) => {
  const p = person(q.body), id = +q.params.id; await dup(() => P("update users set name=?,email=?,phone=?,photo=? where id=? and role='teacher'").run(p.name, p.email, p.phone, p.photo, id));
  if (q.body.password) { if (String(q.body.password).length < 8) throw new E('Password needs 8+ characters'); await P('update users set pw=? where id=?').run(hash(q.body.password), id) } s.json({ ok: 1 })
});
for (const r of ['students', 'teachers']) app.delete(`/api/${r}/:id`, auth('admin'), async (q, s) => {
  const id = +q.params.id;
  if (await P('select id from users where id=? and role=?').get(id, r.slice(0, -1))) await batch([['delete from enrollments where student_id=?', id], ['delete from attendance where student_id=?', id], ['delete from payments where student_id=?', id], ['delete from quiz_students where student_id=?', id], ['delete from quiz_attempts where student_id=?', id], ['delete from teacher_attendance where teacher_id=?', id], ['update courses set teacher_id=null where teacher_id=?', id], ['delete from users where id=?', id]]); s.json({ ok: 1 })
});

// ---- student attendance
app.get('/api/roster', auth('admin', 'teacher'), async (q, s) => {
  const cid = +q.query.course, date = isDate(q.query.date) ? q.query.date : today(); await canCourse(q.user, cid);
  s.json(await P('select u.id,u.name,u.code,u.photo,a.status from enrollments e join users u on u.id=e.student_id left join attendance a on a.student_id=u.id and a.course_id=e.course_id and a.date=? where e.course_id=? order by u.name').all(date, cid))
});
app.post('/api/attendance', auth('admin', 'teacher'), async (q, s) => {
  const { course_id, date, records } = q.body; await canCourse(q.user, course_id); if (!isDate(date) || date > today()) throw new E('Choose a valid date (not in the future)'); if (isSun(date)) throw new E('Sunday is a holiday. Attendance is not taken.');
  if (q.user.role === 'teacher' && date !== today()) throw new E('Teachers can mark attendance for today only. Ask the admin to change other days.', 403);
  const en = new Set((await P('select student_id from enrollments where course_id=?').all(+course_id)).map(r => r.student_id)), st = [];
  if (q.user.role === 'teacher') {
    const had = new Set((await P('select student_id from attendance where course_id=? and date=?').all(+course_id, date)).map(r => r.student_id)); let sk = 0; for (const i of had) if (en.has(i)) { en.delete(i); sk++ }
    if (sk && !(records || []).some(r => en.has(+r.student_id))) throw new E('Attendance is already saved. Only the admin can edit it.', 403)
  }
  for (const r of records || []) { if (!['Present', 'Absent', 'Leave'].includes(r.status)) throw new E('Bad status'); if (en.has(+r.student_id)) st.push(['insert or replace into attendance values(?,?,?,?,?)', +r.student_id, +course_id, date, r.status, q.user.id]) }
  if (st.length) await batch(st); s.json({ ok: 1 })
});

// ---- fees
app.get('/api/fees', auth('admin'), async (q, s) => s.json((await P(`select u.id,u.name,u.code,(select coalesce(sum(fee),0) from enrollments where student_id=u.id) total,(select coalesce(sum(amount),0) from payments where student_id=u.id) paid from users u where role='student' order by u.name`).all())
  .map(r => ({ ...r, remaining: r.total - r.paid, status: r.total > 0 && r.paid >= r.total ? 'Paid' : r.paid > 0 ? 'Partial' : 'Unpaid' }))));
app.post('/api/payments', auth('admin'), async (q, s) => {
  const b = q.body, amt = Math.round(+b.amount), date = b.date || today();
  if (!(amt > 0)) throw new E('Enter a valid amount'); if (!isDate(date)) throw new E('Enter a valid date'); if (!await P('select student_id from enrollments where student_id=? and course_id=?').get(+b.student_id, +b.course_id)) throw new E('Student is not enrolled in that course');
  await P('insert into payments(student_id,course_id,amount,date,note) values(?,?,?,?,?)').run(+b.student_id, +b.course_id, amt, date, String(b.note || '').slice(0, 100)); s.json({ ok: 1 })
});
app.delete('/api/payments/:id', auth('admin'), async (q, s) => { await P('delete from payments where id=?').run(+q.params.id); s.json({ ok: 1 }) });
app.put('/api/enrollments', auth('admin'), async (q, s) => { const fee = Math.round(+q.body.fee); if (!(fee >= 0)) throw new E('Enter a valid fee'); await P('update enrollments set fee=? where student_id=? and course_id=?').run(fee, +q.body.student_id, +q.body.course_id); s.json({ ok: 1 }) });

// ---- teacher check-in
app.post('/api/checkin', auth('teacher'), async (q, s) => {
  if (isSun(today())) throw new E('The institute is closed on Sunday'); if (!checkinOpen()) throw new E(`Check-in is open only from ${fmtH(IN_FROM)} to ${fmtH(IN_TO)}`); const r = await P('insert or ignore into teacher_attendance(teacher_id,date,check_in) values(?,?,?)').run(q.user.id, today(), now());
  if (!r.changes) throw new E('You have already checked in today'); s.json({ ok: 1 })
});
app.post('/api/checkout', auth('teacher'), async (q, s) => {
  const r = await P('update teacher_attendance set check_out=? where teacher_id=? and date=? and check_out is null').run(now(), q.user.id, today());
  if (!r.changes) throw new E('Check in first, or you already checked out'); s.json({ ok: 1 })
});
app.put('/api/teacher-attendance', auth('admin'), async (q, s) => {
  const { teacher_id, date, check_in, check_out } = q.body; if (!isDate(date) || date > today()) throw new E('Choose a valid date (not in the future)'); if (isSun(date)) throw new E('Sunday is a holiday');
  if (!await P("select id from users where id=? and role='teacher'").get(+teacher_id)) throw new E('Teacher not found'); const ci = to12(check_in), co = check_out ? to12(check_out) : null; if (!ci || (check_out && !co)) throw new E('Enter valid times');
  await P('insert or replace into teacher_attendance(teacher_id,date,check_in,check_out) values(?,?,?,?)').run(+teacher_id, date, ci, co); s.json({ ok: 1 })
});
app.delete('/api/teacher-attendance', auth('admin'), async (q, s) => { if (!isDate(q.query.date)) throw new E('Choose a valid date'); await P('delete from teacher_attendance where teacher_id=? and date=?').run(+q.query.teacher_id, q.query.date); s.json({ ok: 1 }) });
const tstat = async (id, joined) => {
  const rec = new Map((await P('select date,check_in,check_out from teacher_attendance where teacher_id=?').all(id)).map(r => [r.date, r]));
  const rows = [...rec.values()].map(r => ({ ...r, status: 'Present' }));
  for (const d of workdays(joined || today(), lastClosed())) if (!rec.has(d)) rows.push({ date: d, check_in: null, check_out: null, status: 'Absent', auto: 1 });
  return rows.filter(r => !isSun(r.date)).sort((a, b) => b.date.localeCompare(a.date))
};
app.get('/api/teacher-attendance', auth('admin', 'teacher'), async (q, s) => {
  if (q.user.role === 'teacher') return s.json((await tstat(q.user.id, (await P('select admission_date d from users where id=?').get(q.user.id)).d)).slice(0, 120).map(r => ({ ...r, name: q.user.name })));
  const d = isDate(q.query.date) ? q.query.date : today(), sun = isSun(d);
  s.json((await P("select u.id,u.name,u.photo,t.check_in,t.check_out from users u left join teacher_attendance t on t.teacher_id=u.id and t.date=? where u.role='teacher' order by u.name").all(d)).map(r => ({ ...r, date: d, status: r.check_in ? 'Present' : sun ? 'Holiday' : d <= lastClosed() ? 'Absent' : 'Pending' })))
});
app.get('/api/teachers/:id', auth('admin'), async (q, s) => {
  const id = +q.params.id, u = await P("select id,name,email,phone,photo,admission_date from users where id=? and role='teacher'").get(id); if (!u) throw new E('Not found', 404);
  u.courses = await P('select c.id,c.name,(select count(*) from enrollments where course_id=c.id) students from courses c where teacher_id=?').all(id);
  u.students = await P(`select u.id,u.name,u.code from users u where u.id in(${myStudents}?) order by u.name`).all(id); const all = await tstat(id, u.admission_date); u.attendance = all.slice(0, 60);
  u.summary = all.reduce((a, r) => (a[r.status]++, a), { Present: 0, Absent: 0 }); s.json(u)
});

// ---- applications & stats
app.get('/api/applications', auth('admin'), async (q, s) => s.json(await P("select a.id,a.name,a.phone,a.email,a.course_id,a.status,a.created_at,a.role,c.name course from applications a left join courses c on c.id=a.course_id order by (a.status='Pending') desc,a.id desc").all()));
app.post('/api/applications/:id/:act', auth('admin'), async (q, s) => {
  const a = await P('select * from applications where id=?').get(+q.params.id); if (!a) throw new E('Not found', 404); if (a.status !== 'Pending') throw new E('Already reviewed');
  if (q.params.act === 'reject') { await P("update applications set status='Rejected' where id=?").run(a.id); return s.json({ ok: 1 }) }
  let r; if (a.role === 'teacher') { const p = person(a); r = { ...await dup(() => P("insert into users(role,name,email,phone,pw,admission_date) values('teacher',?,?,?,?,?) returning id").get(p.name, p.email, p.phone, a.pw, today())), password: null } }
  else r = await createStudent(a, a.course_id ? [a.course_id] : [], undefined, a.pw);
  await P("update applications set status='Approved' where id=?").run(a.id); s.json({ ...r, email: a.email, role: a.role || 'student' })
});
app.get('/api/stats', auth('admin'), async (q, s) => {
  const c = async r => (await P("select count(*) n from users where role=?").get(r)).n;
  const f = await P('select (select coalesce(sum(fee),0) from enrollments) total,(select coalesce(sum(amount),0) from payments) paid').get();
  s.json({
    fees: { total: f.total, paid: f.paid, remaining: f.total - f.paid, month: (await P('select coalesce(sum(amount),0) n from payments where substr(date,1,7)=?').get(today().slice(0, 7))).n, months: await P('select substr(date,1,7) m,sum(amount) amt from payments group by m order by m desc limit 12').all() },
    students: await c('student'), teachers: await c('teacher'), courses: (await P('select count(*) n from courses').get()).n, pending: (await P("select count(*) n from applications where status='Pending'").get()).n,
    checkins: (await P("select u.name,t.check_in,t.check_out from users u left join teacher_attendance t on t.teacher_id=u.id and t.date=? where u.role='teacher' order by t.check_in is null,t.check_in").all(today())).map(r => ({ ...r, status: r.check_in ? 'Present' : isSun(today()) ? 'Holiday' : hr() >= CUT ? 'Absent' : 'Pending' }))
  })
});


// ---- quizzes: timer, one attempt, max 3 exits, each student gets a different random set
const PASS = +process.env.PASS_PERCENT || 60, MAXEXIT = 3, GRACE = 15000;
const expAt = m => { m = +m; return m > 0 ? new Date(Date.now() + Math.min(m, 43200) * 60000).toISOString() : null };
const shuffle = a => { a = [...a]; for (let i = a.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1);[a[i], a[j]] = [a[j], a[i]] } return a };
const quizAccess = async (u, id) => { const z = await P('select * from quizzes where id=?').get(+id); if (!z) throw new E('Quiz not found', 404); if (u.role === 'teacher' && z.created_by !== u.id) throw new E('Not your quiz', 403); return z };
const myQuiz = async (u, id) => { const z = await P('select z.*,qs.expires_at sexp from quizzes z join quiz_students qs on qs.quiz_id=z.id where z.id=? and qs.student_id=?').get(+id, u.id); if (!z) throw new E('Quiz not found', 404); return z };
const attempt = (zid, sid) => P('select * from quiz_attempts where quiz_id=? and student_id=?').get(zid, sid);
const endsAt = (z, a) => Date.parse(a.started_at) + z.duration * 60000;
const secLeft = (z, a) => z.duration ? Math.max(0, Math.round((endsAt(z, a) - Date.now()) / 1000)) : null;
const grade = async (z, a) => {
  const zid = z.id, pp = z.pass_pct || PASS, plan = JSON.parse(a.plan), ans = JSON.parse(a.answers || '[]'), qs = new Map((await P('select id,q,opts,answer from quiz_questions where quiz_id=?').all(zid)).map(x => [x.id, x])); let score = 0;
  const review = plan.map((p, i) => { const x = qs.get(p.id), o = JSON.parse(x.opts), pick = p.perm[ans[i]], ok = pick === x.answer; if (ok) score++; return { q: x.q, yours: o[pick] ?? null, correct: o[x.answer], ok } });
  const pct = Math.round(score * 100 / plan.length); return { score, total: plan.length, pct, passed: pct >= pp, pass: pp, review, reason: a.reason || 'done' }
};
const finalize = async (z, a, reason) => {
  const plan = JSON.parse(a.plan); let ans = JSON.parse(a.answers || 'null'); if (!Array.isArray(ans)) ans = plan.map(() => null); a.answers = JSON.stringify(ans); a.reason = reason; const r = await grade(z, a);
  await P('update quiz_attempts set answers=?,score=?,total=?,passed=?,submitted_at=?,reason=?,exits=?,active=0 where quiz_id=? and student_id=?').run(a.answers, r.score, r.total, r.passed ? 1 : 0, new Date().toISOString(), reason, a.exits || 0, z.id, a.student_id); return r
};
app.get('/api/quizzes', auth(), async (q, s) => {
  const u = q.user;
  if (u.role === 'student') return s.json(await P('select z.id,z.title,z.per_student,z.duration,z.pass_pct,qs.expires_at,(select count(*) from quiz_questions where quiz_id=z.id) pool,t.name teacher,a.started_at,a.submitted_at,a.score,a.total,a.passed,a.exits,a.reason from quiz_students qs join quizzes z on z.id=qs.quiz_id left join users t on t.id=z.created_by left join quiz_attempts a on a.quiz_id=z.id and a.student_id=qs.student_id where qs.student_id=? order by z.id desc').all(u.id));
  s.json(await P(`select z.id,z.title,z.per_student,z.duration,z.pass_pct,z.expires_at,z.created_at,t.name teacher,(select count(*) from quiz_questions where quiz_id=z.id) pool,(select count(*) from quiz_students where quiz_id=z.id) assigned,(select count(*) from quiz_attempts where quiz_id=z.id and submitted_at is not null) done from quizzes z left join users t on t.id=z.created_by ${u.role === 'teacher' ? 'where z.created_by=?' : ''} order by z.id desc`).all(...(u.role === 'teacher' ? [u.id] : [])))
});
app.post('/api/quizzes', auth('admin', 'teacher'), async (q, s) => {
  const b = q.body, u = q.user, title = String(b.title || '').trim(); if (title.length < 2 || title.length > 100) throw new E('Enter a quiz title');
  const qs = (Array.isArray(b.questions) ? b.questions : []).map(x => {
    const opts = (Array.isArray(x.opts) ? x.opts : []).map(o => String(o || '').trim()), text = String(x.q || '').trim(), ans = +x.answer, keep = []; opts.forEach((o, i) => { if (o) keep.push(i) });
    if (!text || keep.length < 2 || !opts[ans]) throw new E('Every question needs text, at least 2 options and one correct answer'); return { q: text.slice(0, 300), opts: keep.map(i => opts[i].slice(0, 150)), answer: keep.indexOf(ans) }
  });
  if (!qs.length) throw new E('Add at least one question'); if (qs.length > 100) throw new E('Maximum 100 questions');
  const per = Math.min(Math.max(1, Math.round(+b.per_student) || qs.length), qs.length), dur = Math.min(300, Math.max(0, Math.round(+b.duration) || 0)), pp = Math.min(100, Math.max(1, Math.round(+b.pass_pct) || PASS)), exp = expAt(b.expires_minutes), ids = [...new Set((b.student_ids || []).map(Number))].filter(Number.isInteger);
  const ok = new Set((await (u.role === 'teacher' ? P(myStudents + '?').all(u.id) : P("select id from users where role='student'").all())).map(r => r.id)); if (ids.some(i => !ok.has(i))) throw new E('You can only select your own students', 403);
  const z = await P('insert into quizzes(title,created_by,per_student,created_at,duration,pass_pct,expires_at) values(?,?,?,?,?,?,?) returning id').get(title, u.id, per, today(), dur, pp, null);
  await batch([...qs.map(x => ['insert into quiz_questions(quiz_id,q,opts,answer) values(?,?,?,?)', z.id, x.q, JSON.stringify(x.opts), x.answer]), ...ids.map(i => ['insert into quiz_students(quiz_id,student_id,expires_at) values(?,?,?)', z.id, i, exp])]); s.json({ id: z.id })
});
app.get('/api/quizzes/:id', auth('admin', 'teacher'), async (q, s) => {
  const z = await quizAccess(q.user, q.params.id);
  z.questions = (await P('select id,q,opts,answer from quiz_questions where quiz_id=? order by id').all(z.id)).map(x => ({ ...x, opts: JSON.parse(x.opts) }));
  z.students = await P('select u.id,u.name,u.code,qs.expires_at,a.started_at,a.submitted_at,a.score,a.total,a.passed,a.exits,a.reason from quiz_students qs join users u on u.id=qs.student_id left join quiz_attempts a on a.quiz_id=qs.quiz_id and a.student_id=qs.student_id where qs.quiz_id=? order by u.name').all(z.id); z.pass = z.pass_pct || PASS; s.json(z)
});
app.put('/api/quizzes/:id', auth('admin', 'teacher'), async (q, s) => {
  const z = await quizAccess(q.user, q.params.id), b = q.body, u = q.user, title = String(b.title || '').trim(); if (title.length < 2 || title.length > 100) throw new E('Enter a quiz title');
  const used = (await P('select count(*) n from quiz_attempts where quiz_id=?').get(z.id)).n > 0, st = []; let pool;
  if (used) pool = (await P('select count(*) n from quiz_questions where quiz_id=?').get(z.id)).n;
  else {
    const qs = (Array.isArray(b.questions) ? b.questions : []).map(x => {
      const opts = (Array.isArray(x.opts) ? x.opts : []).map(o => String(o || '').trim()), text = String(x.q || '').trim(), ans = +x.answer, keep = []; opts.forEach((o, i) => { if (o) keep.push(i) });
      if (!text || keep.length < 2 || !opts[ans]) throw new E('Every question needs text, at least 2 options and one correct answer'); return { q: text.slice(0, 300), opts: keep.map(i => opts[i].slice(0, 150)), answer: keep.indexOf(ans) }
    });
    if (!qs.length) throw new E('Add at least one question'); if (qs.length > 100) throw new E('Maximum 100 questions'); pool = qs.length;
    st.push(['delete from quiz_questions where quiz_id=?', z.id], ...qs.map(x => ['insert into quiz_questions(quiz_id,q,opts,answer) values(?,?,?,?)', z.id, x.q, JSON.stringify(x.opts), x.answer]))
  }
  const per = Math.min(Math.max(1, Math.round(+b.per_student) || pool), pool), dur = Math.min(300, Math.max(0, Math.round(+b.duration) || 0)), pp = Math.min(100, Math.max(1, Math.round(+b.pass_pct) || PASS));
  st.unshift(['update quizzes set title=?,per_student=?,duration=?,pass_pct=? where id=?', title, per, dur, pp, z.id]);
  await batch(st); s.json({ ok: 1, locked: used })
});
app.post('/api/quizzes/:id/send', auth('admin', 'teacher'), async (q, s) => {
  const z = await quizAccess(q.user, q.params.id), u = q.user;
  const ids = [...new Set((q.body.student_ids || []).map(Number))].filter(Number.isInteger); if (!ids.length) throw new E('Select at least one student');
  if (!(await P('select count(*) n from quiz_questions where quiz_id=?').get(z.id)).n) throw new E('Add questions before sending');
  const ok = new Set((await (u.role === 'teacher' ? P(myStudents + '?').all(u.id) : P("select id from users where role='student'").all())).map(r => r.id)); if (ids.some(i => !ok.has(i))) throw new E('You can only select your own students', 403);
  const cur = new Set((await P('select student_id from quiz_students where quiz_id=?').all(z.id)).map(r => r.student_id)), busy = new Set((await P('select student_id from quiz_attempts where quiz_id=? and submitted_at is null').all(z.id)).map(r => r.student_id));
  const exp = expAt(q.body.expires_minutes), st = []; let skipped = 0;
  for (const i of ids) { if (busy.has(i)) { skipped++; continue } if (cur.has(i)) st.push(['delete from quiz_attempts where quiz_id=? and student_id=?', z.id, i], ['update quiz_students set expires_at=? where quiz_id=? and student_id=?', exp, z.id, i]); else st.push(['insert into quiz_students(quiz_id,student_id,expires_at) values(?,?,?)', z.id, i, exp]) }
  if (st.length) await batch(st); s.json({ ok: 1, sent: ids.length - skipped, skipped })
});
app.delete('/api/quizzes/:id', auth('admin', 'teacher'), async (q, s) => { const z = await quizAccess(q.user, q.params.id); await batch([['delete from quiz_questions where quiz_id=?', z.id], ['delete from quiz_students where quiz_id=?', z.id], ['delete from quiz_attempts where quiz_id=?', z.id], ['delete from quizzes where id=?', z.id]]); s.json({ ok: 1 }) });
app.post('/api/quizzes/:id/reset/:sid', auth('admin', 'teacher'), async (q, s) => { const z = await quizAccess(q.user, q.params.id); await P('delete from quiz_attempts where quiz_id=? and student_id=?').run(z.id, +q.params.sid); s.json({ ok: 1 }) });
app.post('/api/quizzes/:id/start', auth('student'), async (q, s) => {
  const u = q.user, z = await myQuiz(u, q.params.id); let a = await attempt(z.id, u.id);
  if (a && a.submitted_at) return s.json({ ended: await grade(z, a) });
  if (a && z.duration && Date.now() > endsAt(z, a)) return s.json({ ended: await finalize(z, a, 'time') });
  const pool = await P('select id,q,opts from quiz_questions where quiz_id=?').all(z.id);
  if (!a && z.sexp && Date.now() > Date.parse(z.sexp)) throw new E('This quiz has expired. You can no longer start it.');
  if (!a) {
    const plan = shuffle(pool).slice(0, Math.min(z.per_student, pool.length)).map(x => ({ id: x.id, perm: shuffle([...Array(JSON.parse(x.opts).length).keys()]) }));
    a = { plan: JSON.stringify(plan), answers: JSON.stringify(plan.map(() => null)), exits: 0, student_id: u.id, started_at: new Date().toISOString() };
    await P('insert into quiz_attempts(quiz_id,student_id,plan,answers,started_at,exits,active) values(?,?,?,?,?,0,1)').run(z.id, u.id, a.plan, a.answers, a.started_at)
  }
  else { if (a.active) a.exits++; if (a.exits >= MAXEXIT) return s.json({ ended: await finalize(z, a, 'exits') }); await P('update quiz_attempts set active=1,exits=? where quiz_id=? and student_id=?').run(a.exits, z.id, u.id) }
  const by = new Map(pool.map(x => [x.id, x]));
  s.json({ title: z.title, max: MAXEXIT, exits: a.exits, left: secLeft(z, a), answers: JSON.parse(a.answers || '[]'), questions: JSON.parse(a.plan).map(p => { const x = by.get(p.id), o = JSON.parse(x.opts); return { q: x.q, opts: p.perm.map(i => o[i]) } }) })
});
app.post('/api/quizzes/:id/answer', auth('student'), async (q, s) => {
  const u = q.user, z = await myQuiz(u, q.params.id), a = await attempt(z.id, u.id); if (!a || a.submitted_at) throw new E('This quiz is not active');
  if (z.duration && Date.now() > endsAt(z, a) + GRACE) return s.json({ ended: await finalize(z, a, 'time') });
  const plan = JSON.parse(a.plan), i = +q.body.i, v = +q.body.v; if (!Number.isInteger(i) || i < 0 || i >= plan.length || !Number.isInteger(v) || v < 0 || v >= plan[i].perm.length) throw new E('Bad answer');
  const ans = JSON.parse(a.answers || '[]'); ans[i] = v; await P('update quiz_attempts set answers=? where quiz_id=? and student_id=?').run(JSON.stringify(ans), z.id, u.id); s.json({ ok: 1 })
});
app.post('/api/quizzes/:id/leave', auth('student'), async (q, s) => {
  const u = q.user, z = await myQuiz(u, q.params.id), a = await attempt(z.id, u.id); if (!a || a.submitted_at || !a.active) return s.json({ ok: 1 });
  if (z.duration && Date.now() > endsAt(z, a)) return s.json({ ended: await finalize(z, a, 'time') });
  a.exits++; if (a.exits >= MAXEXIT) return s.json({ ended: await finalize(z, a, 'exits') });
  await P('update quiz_attempts set active=0,exits=? where quiz_id=? and student_id=?').run(a.exits, z.id, u.id); s.json({ ok: 1, exits: a.exits })
});
app.post('/api/quizzes/:id/submit', auth('student'), async (q, s) => {
  const u = q.user, z = await myQuiz(u, q.params.id), a = await attempt(z.id, u.id);
  if (!a) throw new E('Start the quiz first'); if (a.submitted_at) throw new E('You have already completed this quiz');
  if (z.duration && Date.now() > endsAt(z, a) + GRACE) return s.json(await finalize(z, a, 'time'));
  const plan = JSON.parse(a.plan), ans = Array.isArray(q.body.answers) ? q.body.answers : [], auto = !!q.body.auto;
  if (ans.length !== plan.length || ans.some((x, i) => x !== null && (!Number.isInteger(x) || x < 0 || x >= plan[i].perm.length))) throw new E('Bad answers');
  if (!auto && ans.some(x => x === null)) throw new E('Please answer every question');
  a.answers = JSON.stringify(ans); s.json(await finalize(z, a, auto ? 'time' : 'done'))
});
app.get('/api/quizzes/:id/result', auth('student'), async (q, s) => { const z = await myQuiz(q.user, q.params.id), a = await attempt(z.id, q.user.id); if (!a || !a.submitted_at) throw new E('Quiz not completed yet'); s.json(await grade(z, a)) });


app.get('/', (q, s) => {
  s.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '1h'
}));



