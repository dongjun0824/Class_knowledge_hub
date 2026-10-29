require("dotenv").config();
const express = require("express");
const path = require("path");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const sqlite3 = require("sqlite3").verbose();
const { open } = require("sqlite");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const JWT_SECRET = process.env.JWT_SECRET || "dev_secret_change_me";

const APP_VERSION = "1.0.0";
const PROFANITY_WORDS = [
  "바보", "멍청", "병신", "개새끼", "시발", "좆", "엿", "개같", "미친", "꺼져",
  "등신", "씨발", "개새"
];

const DEFAULT_SUBJECTS = ["국어", "수학", "사회", "과학"];
const DEFAULT_UNITS = {
  국어: ["독서", "문학", "문법", "작문"],
  수학: ["수와 연산", "함수", "기하", "확률과 통계"],
  사회: ["한국사", "경제", "정치", "세계사"],
  과학: ["생명과학", "화학", "물리", "지구과학"]
};

async function openDb() {
  const db = await open({
    filename: "./data/class_knowledge.db",
    driver: sqlite3.Database
  });

  await db.exec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nickname TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT DEFAULT 'user',
      status TEXT DEFAULT 'active',
      points INTEGER DEFAULT 0,
      level INTEGER DEFAULT 1,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS subjects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      description TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS units (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      subject_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(subject_id) REFERENCES subjects(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      subject_id INTEGER NOT NULL,
      unit_id INTEGER,
      type TEXT NOT NULL CHECK(type IN ('concept','question','note','wrong')),
      title TEXT NOT NULL,
      difficulty TEXT DEFAULT '중',
      content TEXT NOT NULL,
      answer TEXT,
      explanation TEXT,
      required_level INTEGER DEFAULT 1,
      status TEXT DEFAULT 'approved',
      is_hidden INTEGER DEFAULT 0,
      likes_count INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY(subject_id) REFERENCES subjects(id) ON DELETE CASCADE,
      FOREIGN KEY(unit_id) REFERENCES units(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(post_id) REFERENCES posts(id) ON DELETE CASCADE,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS likes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(post_id, user_id),
      FOREIGN KEY(post_id) REFERENCES posts(id) ON DELETE CASCADE,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id INTEGER,
      comment_id INTEGER,
      user_id INTEGER NOT NULL,
      reporter_id INTEGER NOT NULL,
      reason TEXT NOT NULL,
      status TEXT DEFAULT 'open',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(post_id) REFERENCES posts(id) ON DELETE SET NULL,
      FOREIGN KEY(comment_id) REFERENCES comments(id) ON DELETE SET NULL,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY(reporter_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS point_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      reason TEXT NOT NULL,
      points INTEGER NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS point_policies (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  await seedDefaultData(db);
  return db;
}

async function seedDefaultData(db) {
  for (const subjectName of DEFAULT_SUBJECTS) {
    const existing = await db.get("SELECT id FROM subjects WHERE name = ?", [subjectName]);
    if (!existing) {
      await db.run("INSERT INTO subjects (name, description) VALUES (?, ?)", [
        subjectName,
        `${subjectName} 관련 자료를 공유하는 교과 게시판입니다.`
      ]);
    }
  }

  const subjectMap = new Map();
  const subjects = await db.all("SELECT id, name FROM subjects");
  for (const s of subjects) subjectMap.set(s.name, s.id);

  for (const [subjectName, units] of Object.entries(DEFAULT_UNITS)) {
    const subjectId = subjectMap.get(subjectName);
    if (!subjectId) continue;

    for (const unitName of units) {
      const existing = await db.get("SELECT id FROM units WHERE subject_id = ? AND name = ?", [subjectId, unitName]);
      if (!existing) {
        await db.run("INSERT INTO units (subject_id, name) VALUES (?, ?)", [subjectId, unitName]);
      }
    }
  }

  const defaultPolicies = {
    concept: 3,
    question_easy: 3,
    question_medium: 5,
    question_hard: 8,
    note: 5,
    comment: 1,
    like: 1,
    daily_point_cap: 50,
    daily_like_limit: 20,
    daily_comment_limit: 15
  };

  for (const [key, value] of Object.entries(defaultPolicies)) {
    const row = await db.get("SELECT key FROM point_policies WHERE key = ?", [key]);
    if (!row) {
      await db.run("INSERT INTO point_policies (key, value) VALUES (?, ?)", [key, String(value)]);
    }
  }

  const adminExists = await db.get("SELECT id FROM users WHERE nickname = ?", ["admin"]);
  if (!adminExists) {
    const hash = await bcrypt.hash("Admin123!", 10);
    await db.run(
      "INSERT INTO users (nickname, password_hash, role, points, level) VALUES (?, ?, 'admin', 0, 1)",
      [ "admin", hash ]
    );
  }
}

function normalizeText(value, maxLen = 2000) {
  if (value === null || value === undefined) return "";
  return String(value).trim().slice(0, maxLen);
}

function containsProfanity(value) {
  const text = normalizeText(value, 5000).toLowerCase();
  return PROFANITY_WORDS.some(word => text.includes(word.toLowerCase()));
}

function computeLevel(points) {
  if (points >= 22) return 4;
  if (points >= 12) return 3;
  if (points >= 5) return 2;
  return 1;
}

function levelLabel(level) {
  const labels = {
    1: "Lv.1 기초 학습자",
    2: "Lv.2 개념 탐구자",
    3: "Lv.3 심화 도전자",
    4: "Lv.4 지식 마스터"
  };
  return labels[level] || "Lv.1 기초 학습자";
}

function generateToken(user) {
  return jwt.sign(
    {
      id: user.id,
      nickname: user.nickname,
      role: user.role,
      points: user.points,
      level: user.level
    },
    JWT_SECRET,
    { expiresIn: "30d" }
  );
}

function buildUserPayload(user) {
  return {
    id: user.id,
    nickname: user.nickname,
    role: user.role,
    status: user.status,
    points: user.points || 0,
    level: user.level || 1,
    created_at: user.created_at
  };
}

async function getUserById(db, id) {
  return db.get("SELECT * FROM users WHERE id = ?", [id]);
}

async function requireAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

    if (!token) {
      return res.status(401).json({ success: false, message: "로그인이 필요합니다." });
    }

    const payload = jwt.verify(token, JWT_SECRET);
    const db = await openDb();
    const user = await db.get("SELECT * FROM users WHERE id = ?", [payload.id]);
    if (!user || user.status !== "active") {
      return res.status(401).json({ success: false, message: "유효하지 않은 사용자입니다." });
    }
    req.user = user;
    req.db = db;
    next();
  } catch (err) {
    return res.status(401).json({ success: false, message: "토큰이 만료되었거나 잘못되었습니다." });
  }
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== "admin") {
    return res.status(403).json({ success: false, message: "관리자만 접근할 수 있습니다." });
  }
  next();
}

async function getPolicies(db) {
  const rows = await db.all("SELECT key, value FROM point_policies");
  const result = {};
  for (const row of rows) result[row.key] = row.value;
  return result;
}

async function getCurrentPolicyValue(db, key, fallback) {
  const p = await getPolicies(db);
  const value = p[key];
  if (value === undefined || value === null || value === "") return fallback;
  return Number(value);
}

async function awardPoints(db, userId, reason, amount) {
  if (!amount || amount <= 0) return { ok: true, awarded: 0 };

  const policies = await getPolicies(db);
  const cap = Number(policies.daily_point_cap || 50);

  const todayTotal = await db.get(
    `SELECT COALESCE(SUM(points), 0) AS total
     FROM point_events
     WHERE user_id = ? AND date(created_at) = date('now')`,
    [userId]
  );

  const totalNow = Number(todayTotal.total || 0);
  if (totalNow + amount > cap) {
    return { ok: false, reason: "daily_cap" };
  }

  await db.run(
    "INSERT INTO point_events (user_id, reason, points) VALUES (?, ?, ?)",
    [userId, reason, amount]
  );

  await db.run("UPDATE users SET points = points + ? WHERE id = ?", [amount, userId]);

  const user = await db.get("SELECT * FROM users WHERE id = ?", [userId]);
  const newLevel = computeLevel(Number(user.points || 0));
  await db.run("UPDATE users SET level = ? WHERE id = ?", [newLevel, userId]);

  return { ok: true, awarded: amount, newLevel };
}

async function ensureUserLevelAccess(db, user, requiredLevel) {
  if (!user) return false;
  const userFromDb = await db.get("SELECT level FROM users WHERE id = ?", [user.id]);
  return Number(userFromDb.level || 1) >= Number(requiredLevel || 1);
}

async function createPostFromPayload(db, user, payload) {
  const type = ["concept", "question", "note", "wrong"].includes(payload.type) ? payload.type : "concept";
  const title = normalizeText(payload.title, 200);
  const content = normalizeText(payload.content, 5000);
  const answer = normalizeText(payload.answer, 3000);
  const explanation = normalizeText(payload.explanation, 5000);
  const subjectId = Number(payload.subject_id || 0);
  const unitId = Number(payload.unit_id || 0) || null;

  if (!title || !content || !subjectId) {
    throw new Error("필수 값이 누락되었습니다.");
  }

  if (containsProfanity(title) || containsProfanity(content) || containsProfanity(answer) || containsProfanity(explanation)) {
    throw new Error("욕설/비하 표현이 포함되어 있어 등록할 수 없습니다.");
  }

  if (payload.type === "question" && (!payload.difficulty || !["하", "중", "상"].includes(payload.difficulty))) {
    throw new Error("문제는 난이도를 선택해야 합니다.");
  }

  const requiredLevel = Number(payload.required_level || 1);
  if (requiredLevel < 1 || requiredLevel > 4) {
    throw new Error("필수 레벨은 1~4 사이여야 합니다.");
  }

  const result = await db.run(
    `INSERT INTO posts (
      user_id, subject_id, unit_id, type, title, difficulty, content, answer, explanation, required_level, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'approved')`,
    [
      user.id,
      subjectId,
      unitId,
      type,
      title,
      payload.difficulty || "중",
      content,
      answer,
      explanation,
      requiredLevel
    ]
  );

  // 포인트 지급
  let pAward = 0;
  if (type === "concept") pAward = await getCurrentPolicyValue(db, "concept", 3);
  if (type === "note") pAward = await getCurrentPolicyValue(db, "note", 5);
  if (type === "question") {
    const diff = (payload.difficulty || "중").trim();
    pAward = diff === "하" ? await getCurrentPolicyValue(db, "question_easy", 3)
      : diff === "중" ? await getCurrentPolicyValue(db, "question_medium", 5)
      : await getCurrentPolicyValue(db, "question_hard", 8);
  }

  const payout = await awardPoints(db, user.id, `post:${type}`, Number(pAward || 0));
  return { id: result.lastID, payout };
}

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(cors({ origin: true, credentials: true }));
app.use(express.static(path.join(__dirname, "public")));

const dbPromise = openDb();

app.get("/api/health", async (req, res) => {
  try {
    const db = await dbPromise;
    const result = await db.get("SELECT 1 AS ok");
    res.json({ success: true, ok: result.ok, version: APP_VERSION });
  } catch (err) {
    res.status(500).json({ success: false, message: "서버 오류" });
  }
});

app.post("/api/auth/register", async (req, res) => {
  try {
    const db = await dbPromise;
    const nickname = normalizeText(req.body.nickname, 30);
    const password = String(req.body.password || "");
    if (!nickname || !password || password.length < 6) {
      return res.status(400).json({ success: false, message: "닉네임과 비밀번호(6자 이상)를 입력하세요." });
    }
    if (containsProfanity(nickname)) {
      return res.status(400).json({ success: false, message: "닉네임에 부적절한 표현이 포함되어 있습니다." });
    }
    const exists = await db.get("SELECT id FROM users WHERE nickname = ?", [nickname]);
    if (exists) {
      return res.status(409).json({ success: false, message: "이미 사용 중인 닉네임입니다." });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const result = await db.run(
      "INSERT INTO users (nickname, password_hash, role, points, level) VALUES (?, ?, 'user', 0, 1)",
      [nickname, passwordHash]
    );
    const user = await db.get("SELECT * FROM users WHERE id = ?", [result.lastID]);

    res.json({
      success: true,
      message: "회원가입이 완료되었습니다.",
      token: generateToken(user),
      user: buildUserPayload(user)
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message || "회원가입 실패" });
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const db = await dbPromise;
    const nickname = normalizeText(req.body.nickname, 30);
    const password = String(req.body.password || "");
    if (!nickname || !password) {
      return res.status(400).json({ success: false, message: "닉네임과 비밀번호를 입력하세요." });
    }

    const user = await db.get("SELECT * FROM users WHERE nickname = ?", [nickname]);
    if (!user) {
      return res.status(401).json({ success: false, message: "존재하지 않는 사용자입니다." });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ success: false, message: "비밀번호가 올바르지 않습니다." });
    }

    if (user.status !== "active") {
      return res.status(403).json({ success: false, message: "정지된 계정입니다." });
    }

    const token = generateToken(user);
    res.json({
      success: true,
      token,
      user: buildUserPayload(user)
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message || "로그인 실패" });
  }
});

app.get("/api/auth/me", requireAuth, async (req, res) => {
  const db = await dbPromise;
  const user = await db.get("SELECT * FROM users WHERE id = ?", [req.user.id]);

  if (!user) {
    return res.status(404).json({ success: false, message: "유저를 찾을 수 없습니다." });
  }

  res.json({
    success: true,
    user: buildUserPayload(user)
  });
});

app.get("/api/subjects", async (req, res) => {
  try {
    const db = await dbPromise;
    const subjects = await db.all(
      `SELECT s.*, 
        (SELECT COUNT(*) FROM posts p WHERE p.subject_id = s.id AND p.is_hidden = 0 AND p.status = 'approved') AS post_count
       FROM subjects s ORDER BY s.name`
    );

    const units = await db.all("SELECT * FROM units ORDER BY subject_id, name");
    const subjectMap = {};
    for (const subject of subjects) subjectMap[subject.id] = subject;

    for (const unit of units) {
      if (!subjectMap[unit.subject_id]) continue;
      if (!subjectMap[unit.subject_id].units) subjectMap[unit.subject_id].units = [];
      subjectMap[unit.subject_id].units.push(unit);
    }

    res.json({ success: true, subjects });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message || "과목 조회 실패" });
  }
});

function buildPostRow(db, row, currentUser = null) {
  let canView = true;
  if (currentUser) {
    canView = Number(row.required_level || 1) <= Number(currentUser.level || 1);
  } else {
    canView = Number(row.required_level || 1) <= 1;
  }

  return {
    id: row.id,
    user_id: row.user_id,
    author: row.author_name,
    subject_id: row.subject_id,
    subject_name: row.subject_name,
    unit_id: row.unit_id,
    unit_name: row.unit_name,
    type: row.type,
    title: row.title,
    difficulty: row.difficulty || "중",
    content: canView ? row.content : "이 자료는 레벨 조건을 만족해야 볼 수 있습니다.",
    answer: canView ? row.answer : null,
    explanation: canView ? row.explanation : null,
    required_level: row.required_level || 1,
    status: row.status,
    likes_count: Number(row.likes_count || 0),
    comments_count: Number(row.comments_count || 0),
    created_at: row.created_at,
    can_view: canView
  };
}

app.get("/api/board", async (req, res) => {
  try {
    const db = await dbPromise;
    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    let currentUser = null;

    if (token) {
      try {
        const payload = jwt.verify(token, JWT_SECRET);
        currentUser = await db.get("SELECT * FROM users WHERE id = ?", [payload.id]);
      } catch (_) {
        currentUser = null;
      }
    }

    const subjectId = Number(req.query.subject_id || 0);
    const unitId = Number(req.query.unit_id || 0);
    const type = req.query.type || "";
    const difficulty = req.query.difficulty || "";
    const search = normalizeText(req.query.q || "", 100);
    const sort = req.query.sort || "latest";

    let sql = `
      SELECT p.*, 
             u.nickname AS author_name,
             s.name AS subject_name,
             un.name AS unit_name,
             (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id) AS comments_count,
             (SELECT COUNT(*) FROM likes l WHERE l.post_id = p.id) AS likes_count
      FROM posts p
      JOIN users u ON u.id = p.user_id
      JOIN subjects s ON s.id = p.subject_id
      LEFT JOIN units un ON un.id = p.unit_id
      WHERE p.status = 'approved' AND p.is_hidden = 0
    `;

    const params = [];

    if (subjectId) {
      sql += " AND p.subject_id = ?";
      params.push(subjectId);
    }
    if (unitId) {
      sql += " AND p.unit_id = ?";
      params.push(unitId);
    }
    if (type) {
      sql += " AND p.type = ?";
      params.push(type);
    }
    if (difficulty) {
      sql += " AND p.difficulty = ?";
      params.push(difficulty);
    }
    if (search) {
      sql += " AND (p.title LIKE ? OR p.content LIKE ? OR p.answer LIKE ? OR p.explanation LIKE ?)";
      const like = `%${search}%`;
      params.push(like, like, like, like);
    }

    if (currentUser) {
      sql += " AND p.required_level <= ?";
      params.push(currentUser.level || 1);
    } else {
      sql += " AND p.required_level <= 1";
    }

    if (sort === "likes") {
      sql += " ORDER BY p.likes_count DESC, p.created_at DESC";
    } else {
      sql += " ORDER BY p.created_at DESC";
    }

    const rows = await db.all(sql, params);
    const posts = rows.map(row => buildPostRow(db, row, currentUser));

    res.json({ success: true, posts });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message || "게시글 조회 실패" });
  }
});

app.get("/api/board/:id", requireAuth, async (req, res) => {
  try {
    const db = await dbPromise;
    const postId = Number(req.params.id);
    const post = await db.get(`
      SELECT p.*, u.nickname AS author_name, s.name AS subject_name, un.name AS unit_name
      FROM posts p
      JOIN users u ON u.id = p.user_id
      JOIN subjects s ON s.id = p.subject_id
      LEFT JOIN units un ON un.id = p.unit_id
      WHERE p.id = ? AND p.status = 'approved' AND p.is_hidden = 0
    `, [postId]);

    if (!post) {
      return res.status(404).json({ success: false, message: "게시글을 찾을 수 없습니다." });
    }

    const allowed = await ensureUserLevelAccess(db, req.user, post.required_level);
    if (!allowed) {
      return res.status(403).json({ success: false, message: "레벨이 부족해 해당 자료를 볼 수 없습니다." });
    }

    const comments = await db.all(`
      SELECT c.*, u.nickname AS author_name
      FROM comments c
      JOIN users u ON u.id = c.user_id
      WHERE c.post_id = ?
      ORDER BY c.created_at DESC
    `, [postId]);

    const liked = await db.get("SELECT id FROM likes WHERE post_id = ? AND user_id = ?", [postId, req.user.id]);

    res.json({
      success: true,
      post: buildPostRow(db, post, req.user),
      comments,
      liked: !!liked
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message || "게시글 상세 조회 실패" });
  }
});

app.post("/api/board", requireAuth, async (req, res) => {
  try {
    const db = await dbPromise;
    const payload = req.body || {};

    const result = await createPostFromPayload(db, req.user, payload);
    res.status(201).json({ success: true, message: "게시글이 작성되었습니다.", post_id: result.id, payout: result.payout });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message || "게시글 작성 실패" });
  }
});

app.post("/api/board/:id/like", requireAuth, async (req, res) => {
  try {
    const db = await dbPromise;
    const postId = Number(req.params.id);

    const post = await db.get("SELECT * FROM posts WHERE id = ?", [postId]);
    if (!post) {
      return res.status(404).json({ success: false, message: "게시글을 찾을 수 없습니다." });
    }
    if (post.user_id === req.user.id) {
      return res.status(400).json({ success: false, message: "자기 게시물에는 좋아요를 할 수 없습니다." });
    }

    const policies = await getPolicies(db);
    const dailyLikeLimit = Number(policies.daily_like_limit || 20);
    const todayLikeCount = await db.get(
      "SELECT COUNT(*) AS cnt FROM likes WHERE user_id = ? AND date(created_at) = date('now')",
      [req.user.id]
    );
    if (Number(todayLikeCount.cnt || 0) >= dailyLikeLimit) {
      return res.status(400).json({ success: false, message: "오늘 좋아요 한도를 초과했습니다." });
    }

    const existing = await db.get("SELECT id FROM likes WHERE post_id = ? AND user_id = ?", [postId, req.user.id]);
    if (existing) {
      return res.status(409).json({ success: false, message: "이미 좋아요를 누른 게시글입니다." });
    }

    await db.run("INSERT INTO likes (post_id, user_id) VALUES (?, ?)", [postId, req.user.id]);
    await db.run("UPDATE posts SET likes_count = likes_count + 1 WHERE id = ?", [postId]);

    const likeAward = Number((await getPolicies(db)).like || 1);
    const payout = await awardPoints(db, post.user_id, `like:${postId}`, likeAward);

    res.json({
      success: true,
      message: "좋아요를 반영했습니다.",
      likes_count: Number(post.likes_count || 0) + 1,
      payout
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message || "좋아요 처리 실패" });
  }
});

app.post("/api/board/:id/comment", requireAuth, async (req, res) => {
  try {
    const db = await dbPromise;
    const postId = Number(req.params.id);
    const content = normalizeText(req.body.content, 1000);

    if (!content) {
      return res.status(400).json({ success: false, message: "댓글 내용을 입력하세요." });
    }
    if (containsProfanity(content)) {
      return res.status(400).json({ success: false, message: "댓글에 부적절한 표현이 포함되어 있습니다." });
    }

    const post = await db.get("SELECT * FROM posts WHERE id = ?", [postId]);
    if (!post) {
      return res.status(404).json({ success: false, message: "게시글을 찾을 수 없습니다." });
    }

    const policies = await getPolicies(db);
    const dailyCommentLimit = Number(policies.daily_comment_limit || 15);
    const todayCommentCount = await db.get(
      "SELECT COUNT(*) AS cnt FROM comments WHERE user_id = ? AND date(created_at) = date('now')",
      [req.user.id]
    );

    if (Number(todayCommentCount.cnt || 0) >= dailyCommentLimit) {
      return res.status(400).json({ success: false, message: "오늘 댓글 작성 한도를 초과했습니다." });
    }

    await db.run(
      "INSERT INTO comments (post_id, user_id, content) VALUES (?, ?, ?)",
      [postId, req.user.id, content]
    );

    const commentAward = Number((await getPolicies(db)).comment || 1);
    const payout = await awardPoints(db, req.user.id, `comment:${postId}`, commentAward);

    const comments = await db.all(`
      SELECT c.*, u.nickname AS author_name
      FROM comments c
      JOIN users u ON u.id = c.user_id
      WHERE c.post_id = ?
      ORDER BY c.created_at DESC
    `, [postId]);

    res.json({
      success: true,
      message: "댓글이 작성되었습니다.",
      comments,
      payout
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message || "댓글 작성 실패" });
  }
});

app.post("/api/board/:id/report", requireAuth, async (req, res) => {
  try {
    const db = await dbPromise;
    const postId = Number(req.params.id);
    const reason = normalizeText(req.body.reason, 500);

    const post = await db.get("SELECT * FROM posts WHERE id = ?", [postId]);
    if (!post) {
      return res.status(404).json({ success: false, message: "신고 대상 게시글을 찾을 수 없습니다." });
    }
    if (!reason) {
      return res.status(400).json({ success: false, message: "신고 사유를 반드시 입력해야 합니다." });
    }

    await db.run(
      "INSERT INTO reports (post_id, user_id, reporter_id, reason, status) VALUES (?, ?, ?, ?, 'open')",
      [postId, post.user_id, req.user.id, reason]
    );

    res.json({ success: true, message: "신고가 접수되었습니다." });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message || "신고 처리 실패" });
  }
});

app.post("/api/admin/subjects", requireAuth, requireAdmin, async (req, res) => {
  try {
    const db = await dbPromise;
    const name = normalizeText(req.body.name, 40);
    const description = normalizeText(req.body.description, 500);

    if (!name) {
      return res.status(400).json({ success: false, message: "교과목 이름을 입력하세요." });
    }
    if (containsProfanity(name) || containsProfanity(description)) {
      return res.status(400).json({ success: false, message: "교과목 이름 또는 설명에 부적절한 표현이 포함되어 있습니다." });
    }

    const exists = await db.get("SELECT id FROM subjects WHERE name = ?", [name]);
    if (exists) {
      return res.status(409).json({ success: false, message: "이미 존재하는 교과목입니다." });
    }

    const result = await db.run("INSERT INTO subjects (name, description) VALUES (?, ?)", [name, description]);
    const subject = await db.get("SELECT * FROM subjects WHERE id = ?", [result.lastID]);

    res.status(201).json({ success: true, subject });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message || "교과 관리 실패" });
  }
});

app.post("/api/admin/units", requireAuth, requireAdmin, async (req, res) => {
  try {
    const db = await dbPromise;
    const subjectId = Number(req.body.subject_id || 0);
    const name = normalizeText(req.body.name, 60);

    if (!subjectId || !name) {
      return res.status(400).json({ success: false, message: "과목과 단원을 모두 입력하세요." });
    }
    if (containsProfanity(name)) {
      return res.status(400).json({ success: false, message: "단원 이름에 부적절한 표현이 포함되어 있습니다." });
    }

    const exists = await db.get("SELECT id FROM units WHERE subject_id = ? AND name = ?", [subjectId, name]);
    if (exists) {
      return res.status(409).json({ success: false, message: "이미 존재하는 단원입니다." });
    }

    const result = await db.run("INSERT INTO units (subject_id, name) VALUES (?, ?)", [subjectId, name]);
    const unit = await db.get("SELECT * FROM units WHERE id = ?", [result.lastID]);

    res.status(201).json({ success: true, unit });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message || "단원 추가 실패" });
  }
});

app.get("/api/admin/users", requireAuth, requireAdmin, async (req, res) => {
  try {
    const db = await dbPromise;
    const users = await db.all(`
      SELECT id, nickname, role, status, points, level, created_at
      FROM users
      ORDER BY points DESC, created_at DESC
    `);
    res.json({ success: true, users });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message || "회원 목록 조회 실패" });
  }
});

app.get("/api/admin/reports", requireAuth, requireAdmin, async (req, res) => {
  try {
    const db = await dbPromise;
    const reports = await db.all(`
      SELECT r.*, 
             u.nickname AS reporter_nickname,
             p.title AS post_title
      FROM reports r
      LEFT JOIN users u ON u.id = r.reporter_id
      LEFT JOIN posts p ON p.id = r.post_id
      ORDER BY r.created_at DESC
    `);
    res.json({ success: true, reports });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message || "신고 목록 조회 실패" });
  }
});

app.patch("/api/admin/posts/:id", requireAuth, requireAdmin, async (req, res) => {
  try {
    const db = await dbPromise;
    const postId = Number(req.params.id);
    const action = String(req.body.action || "hide");
    const post = await db.get("SELECT * FROM posts WHERE id = ?", [postId]);

    if (!post) {
      return res.status(404).json({ success: false, message: "게시글이 없습니다." });
    }

    if (action === "hide") {
      await db.run("UPDATE posts SET is_hidden = 1, status = 'hidden' WHERE id = ?", [postId]);
      return res.json({ success: true, message: "게시글이 숨김 처리되었습니다." });
    }

    if (action === "restore") {
      await db.run("UPDATE posts SET is_hidden = 0, status = 'approved' WHERE id = ?", [postId]);
      return res.json({ success: true, message: "게시글이 복구되었습니다." });
    }

    if (action === "delete") {
      await db.run("DELETE FROM posts WHERE id = ?", [postId]);
      return res.json({ success: true, message: "게시글이 삭제되었습니다." });
    }

    return res.status(400).json({ success: false, message: "지원하지 않는 작업입니다." });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message || "게시글 관리 실패" });
  }
});

app.post("/api/admin/manual-points", requireAuth, requireAdmin, async (req, res) => {
  try {
    const db = await dbPromise;
    const userId = Number(req.body.user_id);
    const amount = Number(req.body.amount || 0);
    const reason = normalizeText(req.body.reason, 200);

    if (!userId || !reason) {
      return res.status(400).json({ success: false, message: "유저 ID와 사유를 입력하세요." });
    }

    const target = await db.get("SELECT * FROM users WHERE id = ?", [userId]);
    if (!target) {
      return res.status(404).json({ success: false, message: "대상 사용자를 찾을 수 없습니다." });
    }

    if (amount === 0) {
      return res.status(400).json({ success: false, message: "지급/회수 금액을 0보다 크게 입력하세요." });
    }

    const sign = amount > 0 ? 1 : -1;
    const finalAmount = Math.abs(amount);

    const payout = await awardPoints(db, userId, `manual:${reason}`, finalAmount * sign);
    if (!payout.ok && payout.reason === "daily_cap") {
      return res.status(400).json({ success: false, message: "일일 포인트 한도를 초과해 반영할 수 없습니다." });
    }

    res.json({
      success: true,
      message: "포인트가 반영되었습니다.",
      user: buildUserPayload(await db.get("SELECT * FROM users WHERE id = ?", [userId])),
      awarded: finalAmount * sign
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message || "관리자 포인트 처리 실패" });
  }
});

app.get("/api/admin/policies", requireAuth, requireAdmin, async (req, res) => {
  try {
    const db = await dbPromise;
    const policies = await getPolicies(db);
    res.json({ success: true, policies });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message || "정책 조회 실패" });
  }
});

app.put("/api/admin/policies", requireAuth, requireAdmin, async (req, res) => {
  try {
    const db = await dbPromise;
    const payload = req.body || {};
    const entries = Object.entries(payload);

    for (const [key, value] of entries) {
      await db.run("INSERT INTO point_policies (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [key, String(value)]);
    }

    res.json({ success: true, message: "포인트 정책이 저장되었습니다." });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message || "정책 저장 실패" });
  }
});

app.get("/api/me/points", requireAuth, async (req, res) => {
  try {
    const db = await dbPromise;
    const user = await db.get("SELECT * FROM users WHERE id = ?", [req.user.id]);
    const points = await db.all(
      "SELECT * FROM point_events WHERE user_id = ? ORDER BY created_at DESC LIMIT 20",
      [req.user.id]
    );
    res.json({
      success: true,
      user: buildUserPayload(user),
      points
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message || "포인트 조회 실패" });
  }
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Class Knowledge Hub running on http://localhost:${PORT}`);
});
