require('dotenv').config();

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Low } = require('lowdb');
const { JSONFile } = require('lowdb/node');
const path = require('path');
const multer = require('multer');
const bcrypt = require('bcrypt');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const fs = require('fs');
const os = require('os');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const port = Number.parseInt(process.env.PORT, 10) || 3000;

const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}

const DEFAULT_CATEGORIES = Object.freeze([
    { id: 1, name: 'Talent', percentage: 40 },
    { id: 2, name: 'Evening Gown', percentage: 30 },
    { id: 3, name: 'Interview', percentage: 30 },
]);
const SCORE_MIN = 0;
const SCORE_MAX = 100;
const SCORE_PRECISION = 2;

const db = new Low(
    new JSONFile(path.join(__dirname, 'db.json')),
    { admins: [], judges: [], contestants: [], categories: [], scores: [] }
);

const upload = multer({
    storage: multer.diskStorage({
        destination: (_req, _file, cb) => cb(null, uploadsDir),
        filename: (_req, file, cb) => {
            const extension = path.extname(file.originalname || '').toLowerCase();
            cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${extension}`);
        },
    }),
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
        if (!file.mimetype.startsWith('image/')) {
            cb(new Error('Only image uploads are allowed.'));
            return;
        }

        cb(null, true);
    },
});

function getDefaultCategories() {
    return DEFAULT_CATEGORIES.map(category => ({ ...category }));
}

function normalizeText(value) {
    return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
}

function parseId(value) {
    const parsed = Number.parseInt(value, 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function parseBooleanFlag(value) {
    if (value === true || value === 'true') return true;
    if (value === false || value === 'false') return false;
    return null;
}

function normalizeScoreValue(value) {
    if (value === '' || value === null || value === undefined) {
        return null;
    }

    const normalized = typeof value === 'string' ? value.trim() : value;
    if (normalized === '') {
        return null;
    }

    const numeric = Number(normalized);
    if (!Number.isFinite(numeric) || numeric < SCORE_MIN || numeric > SCORE_MAX) {
        return null;
    }

    return Number(numeric.toFixed(SCORE_PRECISION));
}

function getNextId(collectionName) {
    const items = db.data[collectionName];
    return items.length ? Math.max(...items.map(item => item.id)) + 1 : 1;
}

function getLocalIPs() {
    const interfaces = os.networkInterfaces();
    const preferredAddresses = [];
    const fallbackAddresses = [];
    const seenAddresses = new Set();
    const excludedInterfacePattern = /(vmware|virtualbox|vbox|hyper-v|docker|wsl|loopback|hamachi|tailscale|zerotier)/i;

    const isPrivateIPv4 = address =>
        /^10\./.test(address) ||
        /^192\.168\./.test(address) ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(address);

    Object.entries(interfaces).forEach(([interfaceName, networks]) => {
        (networks || []).forEach(network => {
            if (network.family !== 'IPv4' || network.internal) {
                return;
            }

            const address = network.address;
            if (!address || address.startsWith('169.254.') || seenAddresses.has(address)) {
                return;
            }

            seenAddresses.add(address);

            if (!excludedInterfacePattern.test(interfaceName) && isPrivateIPv4(address)) {
                preferredAddresses.push(address);
                return;
            }

            fallbackAddresses.push(address);
        });
    });

    return preferredAddresses.length ? preferredAddresses : fallbackAddresses;
}

function buildPublicContestant(contestant) {
    return {
        id: contestant.id,
        name: contestant.name,
        image_path: contestant.image_path || null,
        eliminated: Boolean(contestant.eliminated),
    };
}

function isContestantActive(contestant) {
    return !contestant.eliminated;
}

function setContestantEliminationState(contestant, eliminated) {
    const nextState = Boolean(eliminated);
    const changed = contestant.eliminated !== nextState;

    contestant.eliminated = nextState;
    contestant.eliminated_at = nextState ? contestant.eliminated_at || new Date().toISOString() : null;

    return changed;
}

function removeUploadedTempFile(file) {
    if (!file?.path) return;

    const resolvedPath = path.resolve(file.path);
    if (resolvedPath.startsWith(uploadsDir) && fs.existsSync(resolvedPath)) {
        fs.unlinkSync(resolvedPath);
    }
}

function removeContestantImage(imagePath) {
    if (!imagePath) return;

    const resolvedPath = path.resolve(__dirname, imagePath);
    if (resolvedPath.startsWith(uploadsDir) && fs.existsSync(resolvedPath)) {
        fs.unlinkSync(resolvedPath);
    }
}

function totalCategoryWeight(excludedCategoryId = null) {
    return db.data.categories.reduce((sum, category) => {
        if (category.id === excludedCategoryId) {
            return sum;
        }

        return sum + Number(category.percentage || 0);
    }, 0);
}

function validateContestantName(name, excludedId = null) {
    const normalizedName = normalizeText(name);

    if (!normalizedName) {
        return { message: 'Contestant name is required.' };
    }

    const duplicate = db.data.contestants.some(
        contestant =>
            contestant.id !== excludedId &&
            normalizeText(contestant.name).toLowerCase() === normalizedName.toLowerCase()
    );

    if (duplicate) {
        return { message: 'A contestant with that name already exists.' };
    }

    return { value: normalizedName };
}

function validateJudgeInput({ name, username, password }, options = {}) {
    const { excludedId = null, requirePassword = true } = options;
    const normalizedName = normalizeText(name);
    const normalizedUsername = normalizeText(username).toLowerCase();

    if (!normalizedName) {
        return { message: 'Judge name is required.' };
    }

    if (!normalizedUsername) {
        return { message: 'Judge username is required.' };
    }

    const duplicateUsername = db.data.judges.some(
        judge =>
            judge.id !== excludedId &&
            normalizeText(judge.username).toLowerCase() === normalizedUsername
    );

    if (duplicateUsername) {
        return { message: 'That judge username is already in use.' };
    }

    if (requirePassword) {
        if (typeof password !== 'string' || password.length === 0) {
            return { message: 'Judge password is required.' };
        }
    } else if (
        password !== undefined &&
        password !== null &&
        typeof password !== 'string'
    ) {
        return { message: 'Judge password is invalid.' };
    }

    return {
        value: {
            name: normalizedName,
            username: normalizedUsername,
            password: typeof password === 'string' ? password : '',
        },
    };
}

function validateCategoryInput(name, percentage, excludedId = null) {
    const normalizedName = normalizeText(name);
    const parsedPercentage = Number.parseInt(percentage, 10);

    if (!normalizedName) {
        return { message: 'Category name is required.' };
    }

    if (!Number.isInteger(parsedPercentage) || parsedPercentage < 1 || parsedPercentage > 100) {
        return { message: 'Category weight must be a whole number between 1 and 100.' };
    }

    const duplicate = db.data.categories.some(
        category =>
            category.id !== excludedId &&
            normalizeText(category.name).toLowerCase() === normalizedName.toLowerCase()
    );

    if (duplicate) {
        return { message: 'A category with that name already exists.' };
    }

    const proposedTotal = totalCategoryWeight(excludedId) + parsedPercentage;
    if (proposedTotal > 100) {
        return { message: `Category weights cannot exceed 100%. Current total would become ${proposedTotal}%.` };
    }

    return {
        value: {
            name: normalizedName,
            percentage: parsedPercentage,
        },
    };
}

function adminAuth(req, res, next) {
    if (!req.session.adminId) {
        res.status(401).json({ message: 'Unauthorized' });
        return;
    }

    next();
}

function judgeAuth(req, res, next) {
    if (!req.session.judgeId) {
        res.status(401).json({ message: 'Unauthorized' });
        return;
    }

    next();
}

async function initDb() {
    await db.read();

    let shouldWrite = false;

    if (!Array.isArray(db.data.admins)) db.data.admins = [];
    if (!Array.isArray(db.data.judges)) db.data.judges = [];
    if (!Array.isArray(db.data.contestants)) db.data.contestants = [];
    if (!Array.isArray(db.data.categories)) db.data.categories = [];
    if (!Array.isArray(db.data.scores)) db.data.scores = [];

    if (!db.data.admins.length) {
        const passwordHash = await bcrypt.hash('password', 10);
        db.data.admins.push({
            id: 1,
            username: 'admin',
            password: passwordHash,
            name: 'Admin',
        });
        shouldWrite = true;
    }

    if (!db.data.categories.length) {
        db.data.categories = getDefaultCategories();
        shouldWrite = true;
    }

    db.data.contestants.forEach(contestant => {
        if (typeof contestant.eliminated !== 'boolean') {
            contestant.eliminated = false;
            shouldWrite = true;
        }

        if (!Object.prototype.hasOwnProperty.call(contestant, 'eliminated_at')) {
            contestant.eliminated_at = null;
            shouldWrite = true;
        }

        if (!contestant.eliminated && contestant.eliminated_at !== null) {
            contestant.eliminated_at = null;
            shouldWrite = true;
        }
    });

    if (shouldWrite) {
        await db.write();
    }
}

async function calculateLeaderboard() {
    await db.read();

    const { contestants, categories, judges, scores } = db.data;
    const activeContestants = contestants.filter(isContestantActive);

    return activeContestants
        .map(contestant => {
            let weightedScore = 0;
            const judgesScored = new Set();

            categories.forEach(category => {
                const categoryScores = scores.filter(
                    score =>
                        score.contestant_id === contestant.id &&
                        score.category_id === category.id
                );

                categoryScores.forEach(score => judgesScored.add(score.judge_id));

                if (!categoryScores.length) {
                    return;
                }

                const average =
                    categoryScores.reduce((total, score) => total + score.score_value, 0) /
                    categoryScores.length;

                weightedScore += average * (Number(category.percentage) / 100);
            });

            return {
                contestant_id: contestant.id,
                contestant_name: contestant.name,
                final_score: Number(weightedScore.toFixed(2)),
                judges_scored: judgesScored.size,
                judge_total: judges.length,
            };
        })
        .sort((left, right) => right.final_score - left.final_score);
}

async function emitLeaderboardUpdate() {
    io.emit('leaderboard_update', await calculateLeaderboard());
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(
    session({
        secret: process.env.SESSION_SECRET || 'pageant2025',
        resave: false,
        saveUninitialized: false,
        cookie: {
            httpOnly: true,
            sameSite: 'lax',
            maxAge: 24 * 60 * 60 * 1000,
        },
    })
);
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(uploadsDir));

app.get(['/', '/index.html'], (_req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/admin.html', (_req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/elimination.html', (_req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'elimination.html'));
});

app.get('/judge.html', (_req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'judge.html'));
});

app.get('/api/leaderboard', async (_req, res) => {
    res.json(await calculateLeaderboard());
});

app.get('/api/categories', async (_req, res) => {
    await db.read();
    res.json(db.data.categories);
});

app.get('/api/contestants', async (_req, res) => {
    await db.read();
    res.json(db.data.contestants.filter(isContestantActive).map(buildPublicContestant));
});

app.get('/api/admin/session', adminAuth, async (req, res) => {
    await db.read();
    const admin = db.data.admins.find(item => item.id === req.session.adminId);

    res.json({
        authenticated: true,
        username: admin?.username || 'admin',
        name: admin?.name || 'Admin',
    });
});

app.post('/api/admin/login', async (req, res) => {
    await db.read();

    const username = normalizeText(req.body.username).toLowerCase();
    const password = req.body.password;
    const admin = db.data.admins.find(
        item => normalizeText(item.username).toLowerCase() === username
    );

    if (!admin || !(await bcrypt.compare(password || '', admin.password))) {
        res.status(401).json({ message: 'Invalid username or password.' });
        return;
    }

    req.session.adminId = admin.id;
    res.json({ message: 'Login successful.' });
});

app.post('/api/admin/logout', (req, res) => {
    req.session.destroy(() => {
        res.json({ message: 'Logged out.' });
    });
});

app.post('/api/admin/change-password', adminAuth, async (req, res) => {
    await db.read();

    const current = req.body.current;
    const newPassword = req.body.newPassword;
    const admin = db.data.admins.find(item => item.id === req.session.adminId);

    if (!admin) {
        res.status(404).json({ message: 'Admin account not found.' });
        return;
    }

    if (!(await bcrypt.compare(current || '', admin.password))) {
        res.status(400).json({ message: 'Current password is incorrect.' });
        return;
    }

    if (typeof newPassword !== 'string' || newPassword.length < 6) {
        res.status(400).json({ message: 'New password must be at least 6 characters.' });
        return;
    }

    admin.password = await bcrypt.hash(newPassword, 10);
    await db.write();

    res.json({ message: 'Admin password updated successfully.' });
});

app.get('/api/judge/session', judgeAuth, async (req, res) => {
    await db.read();
    const judge = db.data.judges.find(item => item.id === req.session.judgeId);

    if (!judge) {
        req.session.destroy(() => {
            res.status(401).json({ message: 'Unauthorized' });
        });
        return;
    }

    res.json({
        authenticated: true,
        judgeId: judge.id,
        judgeName: judge.name,
    });
});

app.post('/api/judge/login', async (req, res) => {
    await db.read();

    const username = normalizeText(req.body.username).toLowerCase();
    const password = req.body.password;
    const judge = db.data.judges.find(
        item => normalizeText(item.username).toLowerCase() === username
    );

    if (!judge || !(await bcrypt.compare(password || '', judge.password))) {
        res.status(401).json({ message: 'Invalid username or password.' });
        return;
    }

    req.session.judgeId = judge.id;
    res.json({ message: 'Login successful.', judgeId: judge.id, judgeName: judge.name });
});

app.post('/api/judge/logout', (req, res) => {
    req.session.destroy(() => {
        res.json({ message: 'Logged out.' });
    });
});

app.get('/api/judge/scores', judgeAuth, async (req, res) => {
    await db.read();
    const activeContestantIds = new Set(
        db.data.contestants.filter(isContestantActive).map(contestant => contestant.id)
    );

    const scores = db.data.scores
        .filter(
            score =>
                score.judge_id === req.session.judgeId &&
                activeContestantIds.has(score.contestant_id)
        )
        .map(score => ({
            category_id: score.category_id,
            contestant_id: score.contestant_id,
            score: score.score_value,
        }));

    res.json(scores);
});

app.post('/api/judge/scores', judgeAuth, async (req, res) => {
    await db.read();

    if (!Array.isArray(req.body.scores)) {
        res.status(400).json({ message: 'Scores payload must be an array.' });
        return;
    }

    const validContestants = new Set(
        db.data.contestants.filter(isContestantActive).map(contestant => contestant.id)
    );
    const validCategories = new Set(db.data.categories.map(category => category.id));
    const seenScores = new Set();

    let added = 0;
    let updated = 0;
    let skipped = 0;

    req.body.scores.forEach(scoreEntry => {
        const contestantId = parseId(scoreEntry.contestant_id);
        const categoryId = parseId(scoreEntry.category_id);
        const scoreValue = normalizeScoreValue(scoreEntry.score);
        const scoreKey = `${contestantId}:${categoryId}`;

        const isValidScore =
            contestantId &&
            categoryId &&
            validContestants.has(contestantId) &&
            validCategories.has(categoryId) &&
            scoreValue !== null &&
            !seenScores.has(scoreKey);

        if (!isValidScore) {
            skipped += 1;
            return;
        }

        seenScores.add(scoreKey);

        const existingScore = db.data.scores.find(
            item =>
                item.judge_id === req.session.judgeId &&
                item.contestant_id === contestantId &&
                item.category_id === categoryId
        );

        if (existingScore) {
            existingScore.score_value = scoreValue;
            existingScore.timestamp = new Date().toISOString();
            updated += 1;
            return;
        }

        db.data.scores.push({
            id: getNextId('scores'),
            judge_id: req.session.judgeId,
            contestant_id: contestantId,
            category_id: categoryId,
            score_value: scoreValue,
            timestamp: new Date().toISOString(),
        });
        added += 1;
    });

    if (!added && !updated) {
        res.status(400).json({ message: 'No valid scores were submitted.' });
        return;
    }

    await db.write();
    await emitLeaderboardUpdate();

    res.json({ added, updated, skipped });
});

app.get('/api/admin/contestants', adminAuth, async (_req, res) => {
    await db.read();
    res.json(db.data.contestants.map(buildPublicContestant));
});

app.post('/api/admin/contestants', adminAuth, upload.single('image'), async (req, res) => {
    await db.read();

    const validation = validateContestantName(req.body.name);
    if (validation.message) {
        removeUploadedTempFile(req.file);
        res.status(400).json({ message: validation.message });
        return;
    }

    db.data.contestants.push({
        id: getNextId('contestants'),
        name: validation.value,
        image_path: req.file ? `uploads/${req.file.filename}` : null,
        eliminated: false,
        eliminated_at: null,
    });

    await db.write();
    await emitLeaderboardUpdate();

    res.json({ message: 'Contestant added successfully.' });
});

app.put('/api/admin/contestants/:id', adminAuth, upload.single('image'), async (req, res) => {
    await db.read();

    const contestantId = parseId(req.params.id);
    const contestant = db.data.contestants.find(item => item.id === contestantId);

    if (!contestant) {
        removeUploadedTempFile(req.file);
        res.status(404).json({ message: 'Contestant not found.' });
        return;
    }

    const validation = validateContestantName(req.body.name, contestantId);
    if (validation.message) {
        removeUploadedTempFile(req.file);
        res.status(400).json({ message: validation.message });
        return;
    }

    contestant.name = validation.value;

    if (req.file) {
        removeContestantImage(contestant.image_path);
        contestant.image_path = `uploads/${req.file.filename}`;
    }

    await db.write();
    await emitLeaderboardUpdate();

    res.json({ message: 'Contestant updated successfully.' });
});

app.post('/api/admin/elimination/apply', adminAuth, async (req, res) => {
    await db.read();

    const mode = normalizeText(req.body.mode).toLowerCase();
    const contestantIds = [
        ...new Set(
            (Array.isArray(req.body.contestantIds) ? req.body.contestantIds : [])
                .map(parseId)
                .filter(Boolean)
        ),
    ];

    if (!['eliminate-selected', 'advance-selected'].includes(mode)) {
        res.status(400).json({
            message: 'Mode must be either "eliminate-selected" or "advance-selected".',
        });
        return;
    }

    if (!contestantIds.length) {
        res.status(400).json({ message: 'Select at least one contestant first.' });
        return;
    }

    const activeContestants = db.data.contestants.filter(isContestantActive);
    const activeContestantIds = new Set(activeContestants.map(contestant => contestant.id));

    if (!activeContestants.length) {
        res.status(400).json({ message: 'There are no active contestants to update.' });
        return;
    }

    const invalidSelection = contestantIds.some(contestantId => !activeContestantIds.has(contestantId));
    if (invalidSelection) {
        res.status(400).json({
            message: 'Selections must come from the current active contestant list.',
        });
        return;
    }

    const selectedIds = new Set(contestantIds);
    let changedCount = 0;
    let eliminatedCount = 0;

    activeContestants.forEach(contestant => {
        const shouldEliminate =
            mode === 'eliminate-selected' ? selectedIds.has(contestant.id) : !selectedIds.has(contestant.id);

        if (shouldEliminate) {
            eliminatedCount += 1;
        }

        if (setContestantEliminationState(contestant, shouldEliminate)) {
            changedCount += 1;
        }
    });

    if (changedCount) {
        await db.write();
        await emitLeaderboardUpdate();
    }

    if (mode === 'eliminate-selected') {
        res.json({
            message: `${contestantIds.length} contestant${contestantIds.length === 1 ? '' : 's'} marked as eliminated.`,
        });
        return;
    }

    res.json({
        message: eliminatedCount
            ? `${contestantIds.length} contestant${contestantIds.length === 1 ? '' : 's'} moved to the next round. ${eliminatedCount} contestant${eliminatedCount === 1 ? '' : 's'} eliminated.`
            : `All ${contestantIds.length} selected contestant${contestantIds.length === 1 ? '' : 's'} remain active for the next round.`,
    });
});

app.post('/api/admin/contestants/:id/elimination', adminAuth, async (req, res) => {
    await db.read();

    const contestantId = parseId(req.params.id);
    const contestant = db.data.contestants.find(item => item.id === contestantId);
    const eliminated = parseBooleanFlag(req.body.eliminated);

    if (!contestant) {
        res.status(404).json({ message: 'Contestant not found.' });
        return;
    }

    if (eliminated === null) {
        res.status(400).json({ message: 'Elimination state must be true or false.' });
        return;
    }

    setContestantEliminationState(contestant, eliminated);

    await db.write();
    await emitLeaderboardUpdate();

    res.json({
        message: eliminated
            ? `${contestant.name} has been marked as eliminated.`
            : `${contestant.name} has been restored to the contest.`,
    });
});

app.delete('/api/admin/contestants/:id', adminAuth, async (req, res) => {
    await db.read();

    const contestantId = parseId(req.params.id);
    const contestant = db.data.contestants.find(item => item.id === contestantId);

    if (!contestant) {
        res.status(404).json({ message: 'Contestant not found.' });
        return;
    }

    removeContestantImage(contestant.image_path);
    db.data.contestants = db.data.contestants.filter(item => item.id !== contestantId);
    db.data.scores = db.data.scores.filter(score => score.contestant_id !== contestantId);

    await db.write();
    await emitLeaderboardUpdate();

    res.json({ message: 'Contestant deleted successfully.' });
});

app.get('/api/admin/judges', adminAuth, async (_req, res) => {
    await db.read();

    res.json(
        db.data.judges.map(judge => ({
            id: judge.id,
            name: judge.name,
            username: judge.username,
        }))
    );
});

app.post('/api/admin/judges', adminAuth, async (req, res) => {
    await db.read();

    const validation = validateJudgeInput(req.body);
    if (validation.message) {
        res.status(400).json({ message: validation.message });
        return;
    }

    const { name, username, password } = validation.value;

    db.data.judges.push({
        id: getNextId('judges'),
        name,
        username,
        password: await bcrypt.hash(password, 10),
    });

    await db.write();
    await emitLeaderboardUpdate();

    res.json({ message: 'Judge added successfully.' });
});

app.put('/api/admin/judges/:id', adminAuth, async (req, res) => {
    await db.read();

    const judgeId = parseId(req.params.id);
    const judge = db.data.judges.find(item => item.id === judgeId);

    if (!judge) {
        res.status(404).json({ message: 'Judge not found.' });
        return;
    }

    const validation = validateJudgeInput(req.body, {
        excludedId: judgeId,
        requirePassword: false,
    });

    if (validation.message) {
        res.status(400).json({ message: validation.message });
        return;
    }

    const { name, username, password } = validation.value;

    judge.name = name;
    judge.username = username;

    if (password) {
        judge.password = await bcrypt.hash(password, 10);
    }

    await db.write();
    await emitLeaderboardUpdate();

    res.json({ message: 'Judge updated successfully.' });
});

app.delete('/api/admin/judges/:id', adminAuth, async (req, res) => {
    await db.read();

    const judgeId = parseId(req.params.id);
    const judge = db.data.judges.find(item => item.id === judgeId);

    if (!judge) {
        res.status(404).json({ message: 'Judge not found.' });
        return;
    }

    db.data.judges = db.data.judges.filter(item => item.id !== judgeId);
    db.data.scores = db.data.scores.filter(score => score.judge_id !== judgeId);

    await db.write();
    await emitLeaderboardUpdate();

    res.json({ message: 'Judge deleted successfully.' });
});

app.post('/api/admin/judges/:id/reset-password', adminAuth, async (req, res) => {
    await db.read();

    const judgeId = parseId(req.params.id);
    const judge = db.data.judges.find(item => item.id === judgeId);
    const password = req.body.password;

    if (!judge) {
        res.status(404).json({ message: 'Judge not found.' });
        return;
    }

    if (typeof password !== 'string' || password.length === 0) {
        res.status(400).json({ message: 'New password is required.' });
        return;
    }

    judge.password = await bcrypt.hash(password, 10);
    await db.write();

    res.json({ message: `Password reset for ${judge.name}.` });
});

app.get('/api/admin/categories', adminAuth, async (_req, res) => {
    await db.read();
    res.json(db.data.categories);
});

app.post('/api/admin/categories', adminAuth, async (req, res) => {
    await db.read();

    const validation = validateCategoryInput(req.body.name, req.body.percentage);
    if (validation.message) {
        res.status(400).json({ message: validation.message });
        return;
    }

    db.data.categories.push({
        id: getNextId('categories'),
        name: validation.value.name,
        percentage: validation.value.percentage,
    });

    await db.write();
    await emitLeaderboardUpdate();

    res.json({ message: 'Category added successfully.' });
});

app.put('/api/admin/categories/:id', adminAuth, async (req, res) => {
    await db.read();

    const categoryId = parseId(req.params.id);
    const category = db.data.categories.find(item => item.id === categoryId);

    if (!category) {
        res.status(404).json({ message: 'Category not found.' });
        return;
    }

    const validation = validateCategoryInput(req.body.name, req.body.percentage, categoryId);
    if (validation.message) {
        res.status(400).json({ message: validation.message });
        return;
    }

    category.name = validation.value.name;
    category.percentage = validation.value.percentage;

    await db.write();
    await emitLeaderboardUpdate();

    res.json({ message: 'Category updated successfully.' });
});

app.delete('/api/admin/categories/:id', adminAuth, async (req, res) => {
    await db.read();

    const categoryId = parseId(req.params.id);
    const category = db.data.categories.find(item => item.id === categoryId);

    if (!category) {
        res.status(404).json({ message: 'Category not found.' });
        return;
    }

    db.data.categories = db.data.categories.filter(item => item.id !== categoryId);
    db.data.scores = db.data.scores.filter(score => score.category_id !== categoryId);

    await db.write();
    await emitLeaderboardUpdate();

    res.json({ message: 'Category deleted successfully.' });
});

app.post('/api/admin/reset-all', adminAuth, async (_req, res) => {
    await db.read();

    db.data.contestants.forEach(contestant => removeContestantImage(contestant.image_path));
    db.data.contestants = [];
    db.data.judges = [];
    db.data.scores = [];
    db.data.categories = getDefaultCategories();

    await db.write();
    await emitLeaderboardUpdate();

    res.json({ message: 'All pageant data has been reset.' });
});

app.use((error, _req, res, _next) => {
    if (error instanceof multer.MulterError) {
        if (error.code === 'LIMIT_FILE_SIZE') {
            res.status(400).json({ message: 'Uploaded image must be 5 MB or smaller.' });
            return;
        }

        res.status(400).json({ message: error.message });
        return;
    }

    if (error) {
        res.status(400).json({ message: error.message || 'Request failed.' });
        return;
    }
});

io.on('connection', socket => {
    calculateLeaderboard()
        .then(leaderboard => socket.emit('leaderboard_update', leaderboard))
        .catch(err => console.error('Failed to emit leaderboard:', err));
});

server.on('error', error => {
    if (error?.code === 'EADDRINUSE') {
        console.error(`Port ${port} is already in use. Close the other app instance or restart using tabulator.bat.`);
        process.exit(1);
        return;
    }

    console.error('Failed to start server:', error);
    process.exit(1);
});

initDb()
    .then(() => {
        server.listen(port, '0.0.0.0', () => {
            console.log(`Local:   http://localhost:${port}`);

            getLocalIPs().forEach(address => {
                console.log(`LAN:     http://${address}:${port}`);
            });
        });
    })
    .catch(error => {
        console.error('Failed to start server:', error);
        process.exit(1);
    });
