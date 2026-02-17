const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 3000;
const DB_PATH = path.join(__dirname, 'leaderboard.json');
const ACCOUNTS_PATH = path.join(__dirname, 'accounts.json');

app.use(express.json());
app.disable('etag');

app.use((req, res, next) => {
  const isHtmlRequest = req.path === '/' || req.path.endsWith('.html');
  if (isHtmlRequest) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Surrogate-Control', 'no-store');
  }
  next();
});

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});
app.use(express.static(__dirname, {
  etag: false,
  lastModified: false,
  maxAge: 0
}));

function loadLeaderboard() {
  try {
    const raw = fs.readFileSync(DB_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    let board = Array.isArray(parsed) ? parsed : [];
    
    // 기존 데이터에 rebirth 정보가 없으면 0으로 설정
    board = board.map(item => ({
      ...item,
      rebirth: item.rebirth !== undefined ? item.rebirth : 0
    }));
    
    return board;
  } catch {
    return [];
  }
}

function saveLeaderboard(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2), 'utf8');
}

// 계정 관련 함수
function loadAccounts() {
  try {
    const raw = fs.readFileSync(ACCOUNTS_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveAccounts(data) {
  fs.writeFileSync(ACCOUNTS_PATH, JSON.stringify(data, null, 2), 'utf8');
}

function generatePlayerId(accounts) {
  let candidate = '';
  do {
    candidate = `player${Math.floor(1000 + Math.random() * 9000)}`;
  } while (accounts.some((acc) => acc.id === candidate));
  return candidate;
}

app.get('/api/leaderboard', (req, res) => {
  const leaderboard = loadLeaderboard()
    .sort((a, b) => b.money - a.money)
    .slice(0, 10);
  res.json(leaderboard);
});

app.post('/api/leaderboard', (req, res) => {
  const { name, money, rebirth } = req.body || {};

  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ message: '이름을 입력하세요.' });
  }

  const safeMoney = Number(money);
  if (!Number.isFinite(safeMoney) || safeMoney < 0) {
    return res.status(400).json({ message: '점수가 올바르지 않습니다.' });
  }

  // 부정행위 방지: 너무 높은 금액 거부 (최대 합리적 상한선: 500억)
  if (safeMoney > 5000000000) {
    return res.status(400).json({ message: '비정상적인 값입니다.' });
  }

  const safeRebirth = Number(rebirth) || 0;
  if (!Number.isInteger(safeRebirth) || safeRebirth < 0) {
    return res.status(400).json({ message: '환생 정보가 올바르지 않습니다.' });
  }

  const cleanName = name.trim().slice(0, 40);
  const entry = {
    name: cleanName,
    money: Math.floor(safeMoney),
    rebirth: safeRebirth,
    updatedAt: Date.now()
  };

  const leaderboard = loadLeaderboard();
  const existingIndex = leaderboard.findIndex((item) => item.name === cleanName);

  // 부정행위 방지: 이전 기록과의 합리성 검증
  if (existingIndex >= 0) {
    const previousEntry = leaderboard[existingIndex];
    const timeDiffSeconds = (entry.updatedAt - previousEntry.updatedAt) / 1000;
    
    // 최소 5초 이상 경과해야 업데이트 허용
    if (timeDiffSeconds < 5) {
      return res.status(429).json({ message: '너무 자주 제출할 수 없습니다.' });
    }
    
    // 시간당 합리적 증가량 계산 (최대: 초당 150000원 * 시간초)
    const maxReasonableIncrease = 150000 * Math.min(timeDiffSeconds, 3600);
    const actualIncrease = entry.money - previousEntry.money;
    
    // 증가량이 비정상적으로 높으면 거부
    if (actualIncrease > maxReasonableIncrease * 1.5 && actualIncrease > 100000000) {
      return res.status(400).json({ message: '비정상적인 증가량입니다.' });
    }
    
    // 이전 금액보다 유의미하게 높을 때만 업데이트, 또는 환생 횟수가 더 많으면 업데이트
    if (entry.money > previousEntry.money || entry.rebirth > previousEntry.rebirth) {
      leaderboard[existingIndex] = entry;
    }
  } else {
    leaderboard.push(entry);
  }

  const sorted = leaderboard
    .sort((a, b) => {
      // 먼저 환생 횟수로 정렬, 같으면 금액으로 정렬
      if (b.rebirth !== a.rebirth) return b.rebirth - a.rebirth;
      return b.money - a.money;
    })
    .slice(0, 100);

  saveLeaderboard(sorted);
  res.json({ ok: true });
});

// 계정 생성 API
app.post('/api/accounts/register', (req, res) => {
  const { username, password } = req.body || {};

  if (!username || !password) {
    return res.status(400).json({ message: '유저네임과 비밀번호를 입력하세요.' });
  }

  const cleanUsername = String(username).trim();
  const cleanPassword = String(password).trim();

  if (cleanUsername.length < 1 || cleanUsername.length > 16) {
    return res.status(400).json({ message: '유저네임은 1~16자여야 합니다.' });
  }

  const accounts = loadAccounts();
  const exists = accounts.some((acc) => acc.username === cleanUsername);

  if (exists) {
    return res.status(400).json({ message: '이미 존재하는 유저네임입니다.' });
  }

  const newAccount = {
    id: generatePlayerId(accounts),
    username: cleanUsername,
    password: cleanPassword,
    createdAt: Date.now(),
    gameData: {
      money: 0,
      power: 1,
      upgradeCost: 50,
      incomePerSecond: 0,
      rebirth: 0,
      catData: {}
    }
  };

  accounts.push(newAccount);
  saveAccounts(accounts);

  res.json({ 
    ok: true, 
    account: { id: newAccount.id, username: newAccount.username }
  });
});

// 로그인 API
app.post('/api/accounts/login', (req, res) => {
  const { username, password } = req.body || {};

  if (!username || !password) {
    return res.status(400).json({ message: '유저네임과 비밀번호를 입력하세요.' });
  }

  const cleanUsername = String(username).trim();
  const cleanPassword = String(password).trim();

  const accounts = loadAccounts();
  const account = accounts.find((acc) => acc.username === cleanUsername);

  if (!account) {
    return res.status(404).json({ message: '존재하지 않는 계정입니다.' });
  }

  if (account.password !== cleanPassword) {
    return res.status(401).json({ message: '비밀번호가 일치하지 않습니다.' });
  }

  res.json({ 
    ok: true, 
    account: { 
      id: account.id, 
      username: account.username,
      gameData: account.gameData 
    }
  });
});

// 게임 세이브 로드 API
app.get('/api/accounts/:username/save', (req, res) => {
  const { username } = req.params;

  const accounts = loadAccounts();
  const account = accounts.find((acc) => acc.username === username);

  if (!account) {
    return res.status(404).json({ message: '계정을 찾을 수 없습니다.' });
  }

  res.json({ ok: true, gameData: account.gameData || {} });
});

// 게임 세이브 저장 API
app.post('/api/accounts/:username/save', (req, res) => {
  const { username } = req.params;
  const { gameData } = req.body || {};

  if (!gameData) {
    return res.status(400).json({ message: '게임 데이터가 필요합니다.' });
  }

  const accounts = loadAccounts();
  const accountIndex = accounts.findIndex((acc) => acc.username === username);

  if (accountIndex < 0) {
    return res.status(404).json({ message: '계정을 찾을 수 없습니다.' });
  }

  accounts[accountIndex].gameData = gameData;
  accounts[accountIndex].lastSaved = Date.now();
  saveAccounts(accounts);

  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Leaderboard server running: http://localhost:${PORT}`);
});
