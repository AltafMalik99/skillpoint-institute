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
create table if not exists applications(id integer primary key,name text,phone text,email text,course_id integer references courses(id) on delete set null,status text default 'Pending',created_at text);
create index if not exists ix_en on enrollments(course_id);create index if not exists ix_pay on payments(student_id);`;
class E extends Error { constructor(m, s = 400) { super(m); this.status = s } }
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: TZ });
const now = () => new Date().toLocaleTimeString('en-US', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
const CUT = +process.env.CUTOFF_HOUR || 22;
const hr = () => +new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: 'numeric', hourCycle: 'h23' }).format(new Date());
const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const isSun = d => new Date(d + 'T00:00:00Z').getUTCDay() === 0;
const lastClosed = () => hr() >= CUT ? today() : addDays(today(), -1);
const workdays = (from, to) => { const r = []; for (let d = from < addDays(to, -120) ? addDays(to, -120) : from; d <= to; d = addDays(d, 1))if (!isSun(d)) r.push(d); return r };
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
const createStudent = async (b, ids, adm) => {
    const p = person(b), pw = tmp();
    const r = await dup(() => P("insert into users(role,name,email,phone,photo,pw,admission_date) values('student',?,?,?,?,?,?) returning id").get(p.name, p.email, p.phone, p.photo, hash(pw), isDate(adm) ? adm : today()));
    await P('update users set code=? where id=?').run('SP-' + new Date().getFullYear() + '-' + String(r.id).padStart(4, '0'), r.id); await setCourses(r.id, ids); return { id: r.id, password: pw }
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
let ready; const init = () => ready || (ready = (async () => { await multi(SCHEMA); if (!await P('select id from users limit 1').get()) await seed() })().catch(e => { ready = null; throw e }));

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
    if (!u || !ok) throw new E('Wrong email or password', 401);
    s.cookie('sp', jwt.sign({ id: u.id }, SECRET, { expiresIn: '30d' }), { httpOnly: true, sameSite: 'strict', secure: PROD, maxAge: 2592e6 }); s.json({ ok: 1 })
});
app.post('/api/logout', (q, s) => { s.clearCookie('sp'); s.json({ ok: 1 }) });
app.get('/api/me', auth(), async (q, s) => { const u = q.user; if (u.role === 'teacher') { u.closed = isSun(today()); u.today = await P('select * from teacher_attendance where teacher_id=? and date=?').get(u.id, today()) || null } s.json(u) });
app.post('/api/password', auth(), async (q, s) => {
    const { current, next } = q.body; const u = await P('select pw from users where id=?').get(q.user.id);
    if (!bcrypt.compareSync(String(current || ''), u.pw)) throw new E('Current password is wrong'); if (String(next || '').length < 8) throw new E('New password needs 8+ characters');
    await P('update users set pw=? where id=?').run(hash(next), q.user.id); s.json({ ok: 1 })
});

// ---- public admission
app.get('/api/public/courses', async (q, s) => s.json(await P('select id,name from courses order by name').all()));
app.post('/api/apply', async (q, s) => {
    limit('a' + q.ip, 8, 36e5); const b = person(q.body); await needCourse(q.body.course_id);
    await P('insert into applications(name,phone,email,course_id,created_at) values(?,?,?,?,?)').run(b.name, b.phone, b.email, +q.body.course_id, today()); s.json({ ok: 1 })
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
app.put('/api/students/:id', auth('admin'), async (q, s) => {
    const p = person(q.body), id = +q.params.id;
    await dup(() => P("update users set name=?,email=?,phone=?,photo=?,admission_date=coalesce(?,admission_date) where id=? and role='student'").run(p.name, p.email, p.phone, p.photo, isDate(q.body.admission_date) ? q.body.admission_date : null, id));
    if (q.body.password) { if (String(q.body.password).length < 8) throw new E('Password needs 8+ characters'); await P('update users set pw=? where id=?').run(hash(q.body.password), id) } await setCourses(id, q.body.course_ids); s.json({ ok: 1 })
});
const detail = async (id, withFees = true) => {
    const u = await P("select id,name,email,phone,photo,code,admission_date from users where id=? and role='student'").get(id); if (!u) return null;
    u.courses = await P('select c.id,c.name,e.fee,e.since,t.name teacher,coalesce((select sum(amount) from payments where student_id=e.student_id and course_id=c.id),0) paid from enrollments e join courses c on c.id=e.course_id left join users t on t.id=c.teacher_id where e.student_id=?').all(id);
    const total = u.courses.reduce((a, c) => a + c.fee, 0), pays = await P('select p.*,c.name course from payments p join courses c on c.id=p.course_id where p.student_id=? order by p.date desc,p.id desc').all(id), paid = pays.reduce((a, p) => a + p.amount, 0);
    u.fees = { total, paid, remaining: total - paid, status: paid >= total && total > 0 ? 'Paid' : paid > 0 ? 'Partial' : 'Unpaid', advance: Math.max(0, paid - total), payments: pays };
    const rec = await P('select a.date,a.status,a.course_id,c.name course from attendance a join courses c on c.id=a.course_id where a.student_id=?').all(id), have = new Set(rec.map(r => r.course_id + '|' + r.date));
    for (const c of u.courses) for (const d of workdays(c.since || u.admission_date || today(), lastClosed())) if (!have.has(c.id + '|' + d)) rec.push({ date: d, course_id: c.id, course: c.name, status: 'Absent', auto: 1 });
    u.attendance = rec.filter(r => !isSun(r.date)).sort((a, b) => b.date.localeCompare(a.date)); u.summary = { Present: 0, Absent: 0, Leave: 0 }; u.attendance.forEach(r => u.summary[r.status]++);
    if (!withFees) { delete u.fees; u.courses.forEach(c => { delete c.fee; delete c.paid }) } return u
};
app.get('/api/students/:id', auth(), async (q, s) => {
    const u = q.user, id = q.params.id === 'me' ? u.id : +q.params.id;
    if (u.role === 'student' && id !== u.id) throw new E('Not allowed', 403);
    if (u.role === 'teacher' && !await P(myStudents + '? and u.id=?').get(u.id, id)) throw new E('Not your student', 403);
    const d = await detail(id, u.role !== 'teacher'); if (!d) throw new E('Student not found', 404);
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
    if (await P('select id from users where id=? and role=?').get(id, r.slice(0, -1))) await batch([['delete from enrollments where student_id=?', id], ['delete from attendance where student_id=?', id], ['delete from payments where student_id=?', id], ['delete from teacher_attendance where teacher_id=?', id], ['update courses set teacher_id=null where teacher_id=?', id], ['delete from users where id=?', id]]); s.json({ ok: 1 })
});

// ---- student attendance
app.get('/api/roster', auth('admin', 'teacher'), async (q, s) => {
    const cid = +q.query.course, date = isDate(q.query.date) ? q.query.date : today(); await canCourse(q.user, cid);
    s.json(await P('select u.id,u.name,u.code,u.photo,a.status from enrollments e join users u on u.id=e.student_id left join attendance a on a.student_id=u.id and a.course_id=e.course_id and a.date=? where e.course_id=? order by u.name').all(date, cid))
});
app.post('/api/attendance', auth('admin', 'teacher'), async (q, s) => {
    const { course_id, date, records } = q.body; await canCourse(q.user, course_id); if (!isDate(date) || date > today()) throw new E('Choose a valid date (not in the future)'); if (isSun(date)) throw new E('Sunday is a holiday. Attendance is not taken.');
    const en = new Set((await P('select student_id from enrollments where course_id=?').all(+course_id)).map(r => r.student_id)), st = [];
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
    if (isSun(today())) throw new E('The institute is closed on Sunday'); const r = await P('insert or ignore into teacher_attendance(teacher_id,date,check_in) values(?,?,?)').run(q.user.id, today(), now());
    if (!r.changes) throw new E('You have already checked in today'); s.json({ ok: 1 })
});
app.post('/api/checkout', auth('teacher'), async (q, s) => {
    const r = await P('update teacher_attendance set check_out=? where teacher_id=? and date=? and check_out is null').run(now(), q.user.id, today());
    if (!r.changes) throw new E('Check in first, or you already checked out'); s.json({ ok: 1 })
});
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
app.get('/api/applications', auth('admin'), async (q, s) => s.json(await P("select a.*,c.name course from applications a left join courses c on c.id=a.course_id order by (a.status='Pending') desc,a.id desc").all()));
app.post('/api/applications/:id/:act', auth('admin'), async (q, s) => {
    const a = await P('select * from applications where id=?').get(+q.params.id); if (!a) throw new E('Not found', 404); if (a.status !== 'Pending') throw new E('Already reviewed');
    if (q.params.act === 'reject') { await P("update applications set status='Rejected' where id=?").run(a.id); return s.json({ ok: 1 }) }
    const r = await createStudent(a, a.course_id ? [a.course_id] : []); await P("update applications set status='Approved' where id=?").run(a.id); s.json({ ...r, email: a.email })
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

app.use(express.static(require('path').join(__dirname, 'public'))), { maxAge: '1h' }));
app.use((e, q, s, n) => { if (!(e instanceof E)) console.error(e); s.status(e.status || 500).json({ error: e instanceof E ? e.message : 'Something went wrong' }) });
module.exports = app;
if (require.main === module) app.listen(PORT, () => console.log('Skill Point Institute portal running on http://localhost:' + PORT));
