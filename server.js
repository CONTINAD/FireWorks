const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// ==========================================
// HELIUS RPC CONFIGURATION
// ==========================================
const HELIUS_RPC = 'https://mainnet.helius-rpc.com/?api-key=ae211108-bdbf-40af-90e2-c5418e3f62d3';
const TOKEN_CA = 'G5TDFMyGsgJ4rWXxatzxZEcYJmVkTjG3mZTZMnbRpump';

// ==========================================
// GAME CONFIGURATION
// ==========================================
const CONFIG = {
    ROUND_DURATION: 30, // 30 second rounds
    MIN_FIREWORKS: 12,
    MAX_FIREWORKS: 18,
    TICK_RATE: 60,
    COLORS: [
        '#ff9500', '#ffd700', '#ff6b9d', '#9945FF',
        '#00d4ff', '#00ff88', '#ff4d4d', '#ffffff',
        '#ff3366', '#33ff99', '#6699ff', '#ffcc00'
    ]
};

// Mock wallet addresses (used when Helius not available)
const MOCK_WALLETS = [
    '7xKp4mNw', '3fRt8jKl', '9mNp2xWq', '5kLm7yZa',
    '2pQr9sBt', '8tUv3nCd', '4wXy6mEf', '1aZb5hGi',
    'Fm3nJ7kP', 'Lx9oW2yA', 'Hp6qZ8dB', 'Nv4rS3fC',
    'Qy1tU5gD', 'Sw8uV6hE', 'Ux5vW7iF', 'Wz2wX8jG',
    'Bk7mR4pL', 'Cn9sT6qN'
];

// Real holder wallets (populated from Helius)
let realHolders = [];

// ==========================================
// FETCH TOKEN HOLDERS FROM HELIUS
// ==========================================
async function fetchTokenHolders() {
    try {
        console.log('📡 Fetching token holders from Helius...');

        const response = await fetch(HELIUS_RPC, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'getTokenAccounts',
                params: {
                    mint: TOKEN_CA,
                    limit: 50
                }
            })
        });

        const data = await response.json();

        if (data.result && data.result.token_accounts) {
            realHolders = data.result.token_accounts.map(acc => ({
                wallet: acc.owner.substring(0, 8),
                fullWallet: acc.owner,
                balance: acc.amount
            }));
            console.log(`✅ Found ${realHolders.length} token holders`);
        } else {
            console.log('⚠️ No holders found, using mock wallets');
        }
    } catch (error) {
        console.log('⚠️ Helius fetch failed, using mock wallets:', error.message);
    }
}

// ==========================================
// GAME STATE
// ==========================================
let gameState = {
    currentRound: 1,
    timeRemaining: CONFIG.ROUND_DURATION,
    prizePool: 0.8,
    totalDistributed: 0,
    fireworks: [],
    winner: null,
    phase: 'racing',
    roundStartTime: Date.now(),
    winners: [],
    cameraY: 0
};

// ==========================================
// FIREWORK CLASS
// ==========================================
class ServerFirework {
    constructor(id, wallet, lane, totalLanes) {
        this.id = id;
        this.wallet = wallet;
        this.lane = lane;
        this.totalLanes = totalLanes;

        // Position
        this.x = (lane + 0.5) / totalLanes;
        this.y = 1.0; // Start at bottom (1.0 = bottom, 0.0 = top)
        this.startY = 1.0;

        // Launch timing - Simultaneous start (tiny jitter for decoupling)
        this.launchDelay = Math.random() * 500;

        // Speed - moderate for visible movement
        this.baseSpeed = 0.0005 + Math.random() * 0.0003;
        this.speed = this.baseSpeed;

        // Drift - random slight angle
        this.drift = (Math.random() - 0.5) * 0.0002;
        this.accel = 1.002;

        // Visual
        this.color = CONFIG.COLORS[Math.floor(Math.random() * CONFIG.COLORS.length)];
        this.secondaryColor = CONFIG.COLORS[Math.floor(Math.random() * CONFIG.COLORS.length)];

        // State
        this.hasExploded = false;
        this.heightReached = 0;

        // Predetermined explosion height (in METERS)
        // Some explode early (200m), some go to moon (>2000m)
        // 50% chance to have potential to reach 2000m
        if (Math.random() > 0.5) {
            this.maxHeightMeters = 2000 + Math.random() * 2000; // WINNERS
        } else {
            this.maxHeightMeters = 200 + Math.random() * 1600; // LOSERS
        }
    }

    update(elapsedTime) {
        if (this.hasExploded) return;

        // Wait for launch delay
        if (elapsedTime < this.launchDelay) return;

        // Move upward with slight acceleration
        this.y -= this.speed;
        this.speed *= this.accel; // Accelerate like a rocket

        // Cap max speed
        if (this.speed > 0.003) this.speed = 0.003;

        // Apply constant drift (wind/angle)
        this.x += this.drift;

        // Keep in bounds
        this.x = Math.max(0.05, Math.min(0.95, this.x));

        // Height reached (1.0 y = 0m. 0.0 y = 1000m. -1.0 y = 2000m)
        // Formula: (1.0 - y) * 1000
        this.heightReached = (this.startY - this.y) * 1000;

        // Explode if we passed our max height
        if (this.heightReached >= this.maxHeightMeters && this.maxHeightMeters < 2000) {
            this.explode();
        }
    }

    explode() {
        this.hasExploded = true;
    }

    toJSON() {
        return {
            id: this.id,
            wallet: this.wallet,
            x: this.x,
            y: this.y,
            color: this.color,
            secondaryColor: this.secondaryColor,
            hasExploded: this.hasExploded,
            heightReached: Math.floor(this.heightReached)
        };
    }
}

// ==========================================
// GAME LOGIC
// ==========================================
function startNewRound() {
    gameState.timeRemaining = CONFIG.ROUND_DURATION;
    gameState.winner = null;
    gameState.phase = 'racing';
    gameState.roundStartTime = Date.now();
    gameState.fireworks = [];
    gameState.cameraY = 0;

    // Use real holders if available, otherwise mock
    const wallets = realHolders.length > 0
        ? realHolders.map(h => h.wallet)
        : MOCK_WALLETS;

    // SCALABILITY: Cap at 50 fireworks per round
    // If more holders, pick random 50 contenders
    const MAX_CONCURRENT = 50;
    let contenders = [...wallets];

    if (contenders.length > MAX_CONCURRENT) {
        // Shuffle and pick 50
        for (let i = contenders.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [contenders[i], contenders[j]] = [contenders[j], contenders[i]];
        }
        contenders = contenders.slice(0, MAX_CONCURRENT);
        console.log(`⚠️ Too many holders (${wallets.length}). Selected 50 random contenders.`);
    }

    const count = contenders.length;

    for (let i = 0; i < count; i++) {
        const wallet = contenders[i];
        gameState.fireworks.push(new ServerFirework(i, wallet, i, count));
    }

    gameState.prizePool = (0.5 + Math.random() * 1.5).toFixed(2);

    console.log(`🎆 Round #${gameState.currentRound} started with ${count} fireworks`);

    io.emit('newRound', getGameStateForClient());
}

function updateGame() {
    if (gameState.phase !== 'racing' && gameState.phase !== 'celebrating') return;

    const elapsedTime = Date.now() - gameState.roundStartTime;

    if (gameState.phase === 'racing') {
        // Update all fireworks
        gameState.fireworks.forEach(fw => fw.update(elapsedTime));

        // Update camera to follow the LEADER (highest firework)
        const active = gameState.fireworks.filter(fw => !fw.hasExploded);

        if (active.length > 0) {
            const minY = Math.min(...active.map(fw => fw.y));
            // Camera tracks leader. 1.0 - y is normal height.
            // If y goes negative, camera goes > 1.0.
            const targetHeight = 1.0 - minY;
            gameState.cameraY += (targetHeight - gameState.cameraY) * 0.12;
        }

        // Win Condition 1: FIRST TO 2000m (-1.0 y)
        const winner = active.find(fw => fw.heightReached >= 2000);
        if (winner && !gameState.winner) {
            startCelebration(winner);
        }

        // Win Condition 2: Last survivor (if no one reached 2000 yet and others died)
        if (active.length === 1 && !gameState.winner && gameState.fireworks.length > 1) {
            // Only declare if "Last Man Standing" logic is desired, 
            // BUT user said "keep going". So maybe we wait?
            // If the last guy is at 500m, should he win? 
            // User said "first one to 2k".
            // Let's let him fly solo until 2k? 
            // Or just trigger celebration which lets him fly.
            startCelebration(active[0]);
        }
    }
    else if (gameState.phase === 'celebrating') {
        // Update ONLY the winner
        if (gameState.winner) {
            const winnerFw = gameState.fireworks.find(fw => fw.id === gameState.winner.id);
            if (winnerFw) {
                winnerFw.update(elapsedTime);
                // Tight camera lock on winner
                const targetHeight = 1.0 - winnerFw.y;
                gameState.cameraY += (targetHeight - gameState.cameraY) * 0.1;
            }
        }
    }
}

function startCelebration(winner) {
    if (gameState.phase === 'celebrating') return;

    console.log(`🎉 Celebration started for ${winner.wallet}`);
    gameState.phase = 'celebrating';
    gameState.winner = winner.toJSON(); // Mark winner early

    // Explode everyone else
    gameState.fireworks.forEach(fw => {
        if (fw.id !== winner.id) fw.explode();
    });

    // 3 Seconds of Solo Flight/Zoom
    setTimeout(() => {
        endRound(winner);
    }, 3000);
}

function endRound(winner) {
    gameState.winner = winner.toJSON();
    gameState.phase = 'ended';

    gameState.winners.unshift({
        wallet: winner.wallet,
        round: gameState.currentRound,
        prize: gameState.prizePool,
        height: Math.floor(winner.heightReached),
        timestamp: Date.now()
    });

    if (gameState.winners.length > 20) {
        gameState.winners = gameState.winners.slice(0, 20);
    }

    gameState.totalDistributed += parseFloat(gameState.prizePool);

    console.log(`🏆 Round #${gameState.currentRound} winner: ${winner.wallet} (${Math.floor(winner.heightReached)}m)`);

    gameState.timeRemaining = 30; // Start 30s break countdown

    // Broadcast immediately so client sees "ended" state logic
    io.emit('roundEnded', {
        winner: gameState.winner,
        prizePool: gameState.prizePool,
        round: gameState.currentRound
    });
}

function getGameStateForClient() {
    return {
        currentRound: gameState.currentRound,
        timeRemaining: gameState.timeRemaining,
        prizePool: gameState.prizePool,
        totalDistributed: gameState.totalDistributed.toFixed(1),
        fireworks: gameState.fireworks.map(fw => fw.toJSON()),
        winner: gameState.winner,
        phase: gameState.phase,
        winners: gameState.winners.slice(0, 10),
        cameraY: gameState.cameraY
    };
}

// ==========================================
// GAME LOOPS
// ==========================================

// Physics update (60 FPS)
setInterval(() => {
    updateGame();
}, 1000 / CONFIG.TICK_RATE);

// Broadcast state (30 FPS)
setInterval(() => {
    if (gameState.phase === 'racing' || gameState.phase === 'celebrating' || gameState.phase === 'ended') {
        io.emit('gameState', getGameStateForClient());
    }
}, 1000 / 30);

// Timer countdown
setInterval(() => {
    // RACING PHASE
    if (gameState.phase === 'racing' && gameState.timeRemaining > 0) {
        gameState.timeRemaining--;

        if (gameState.timeRemaining === 0) {
            const active = gameState.fireworks.filter(fw => !fw.hasExploded);
            if (active.length > 0) {
                const winner = gameState.fireworks.reduce((max, fw) =>
                    fw.heightReached > max.heightReached ? fw : max
                );
                startCelebration(winner);
            } else {
                // Technically impossible if loop is right, but fallback
                startNewRound();
            }
        }
    }
    // BREAK PHASE (Intermission)
    else if (gameState.phase === 'ended') {
        if (gameState.timeRemaining > 0) {
            gameState.timeRemaining--;
        } else {
            // Break is over
            gameState.currentRound++;
            startNewRound();
        }
    }
}, 1000);

// Refresh holders every 5 minutes
setInterval(() => {
    fetchTokenHolders();
}, 5 * 60 * 1000);

// ==========================================
// SOCKET.IO
// ==========================================
io.on('connection', (socket) => {
    console.log(`👤 User connected: ${socket.id}`);
    socket.emit('gameState', getGameStateForClient());
    socket.emit('winners', gameState.winners);

    socket.on('disconnect', () => {
        console.log(`👤 User disconnected: ${socket.id}`);
    });
});

// ==========================================
// START SERVER
// ==========================================
const PORT = process.env.PORT || 3000;

server.listen(PORT, async () => {
    console.log(`🚀 $FIREWORK Server running on port ${PORT}`);
    console.log(`🎆 Happy New Year 2025!`);
    console.log(`📍 Token: ${TOKEN_CA}`);

    // Fetch real holders first
    await fetchTokenHolders();

    // Start first round
    startNewRound();
});
