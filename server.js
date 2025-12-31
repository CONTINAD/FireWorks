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
// GAME CONFIGURATION
// ==========================================
const CONFIG = {
    ROUND_DURATION: 45, // 45 seconds per round
    HOLDER_COUNT: 50, // Start with 50 holders
    TICK_RATE: 60,
    COLORS: [
        '#ff9500', '#ffd700', '#ff6b9d', '#9945FF',
        '#00d4ff', '#00ff88', '#ff4d4d', '#ffffff',
        '#ff3366', '#33ff99', '#6699ff', '#ffcc00',
        '#ff8800', '#44aaff', '#ff55aa', '#88ff44'
    ],
    // Elimination settings - gradual elimination
    ELIMINATION_PHASES: [
        { time: 40, targetCount: 40 }, // At 40s left, reduce to ~40
        { time: 30, targetCount: 25 }, // At 30s left, reduce to ~25
        { time: 20, targetCount: 15 }, // At 20s left, reduce to ~15
        { time: 10, targetCount: 8 },  // At 10s left, reduce to ~8
        { time: 5, targetCount: 3 },   // At 5s left, reduce to ~3
        { time: 2, targetCount: 1 }    // At 2s left, only 1 left
    ]
};

// More wallet addresses for bigger holder count
const MOCK_WALLETS = [];
const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
for (let i = 0; i < 100; i++) {
    let wallet = '';
    for (let j = 0; j < 8; j++) {
        wallet += chars[Math.floor(Math.random() * chars.length)];
    }
    MOCK_WALLETS.push(wallet);
}

// ==========================================
// GAME STATE
// ==========================================
let gameState = {
    currentRound: 127,
    timeRemaining: CONFIG.ROUND_DURATION,
    prizePool: 0.8,
    totalDistributed: 127.5,
    fireworks: [],
    winner: null,
    phase: 'racing',
    roundStartTime: Date.now(),
    winners: [],
    cameraY: 0, // Camera position (how far we've scrolled up)
    totalHeight: 0, // Total height of the race track
    lastEliminationPhase: -1
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

        // Position - x is lane position, y starts at 0 (bottom)
        this.x = (lane + 0.5) / totalLanes;
        this.y = 0; // Height climbed (increases as we go up)

        // Racing properties - different speeds create spread
        this.baseSpeed = 0.008 + Math.random() * 0.006;
        this.speed = this.baseSpeed;
        this.wobble = Math.random() * Math.PI * 2;
        this.wobbleAmount = 0.002 + Math.random() * 0.003;

        // Visual
        this.color = CONFIG.COLORS[Math.floor(Math.random() * CONFIG.COLORS.length)];
        this.secondaryColor = CONFIG.COLORS[Math.floor(Math.random() * CONFIG.COLORS.length)];

        // State
        this.hasExploded = false;
        this.eliminationOrder = 0; // When eliminated (higher = survived longer)

        // Survival score - determines who gets eliminated (randomized each round)
        this.survivalScore = Math.random();
    }

    update(elapsedTime) {
        if (this.hasExploded) return;

        // Move upward - speed varies slightly over time
        this.speed = this.baseSpeed + Math.sin(elapsedTime * 0.002 + this.id) * 0.001;
        this.y += this.speed;

        // Wobble side to side
        this.wobble += 0.03;
        this.x += Math.sin(this.wobble) * this.wobbleAmount;

        // Keep in bounds
        this.x = Math.max(0.05, Math.min(0.95, this.x));
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
            heightReached: Math.floor(this.y * 1000)
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
    gameState.lastEliminationPhase = -1;

    // Generate ALL holders
    const count = CONFIG.HOLDER_COUNT;

    for (let i = 0; i < count; i++) {
        const wallet = MOCK_WALLETS[i % MOCK_WALLETS.length];
        gameState.fireworks.push(new ServerFirework(i, wallet, i, count));
    }

    gameState.prizePool = (0.5 + Math.random() * 1.5).toFixed(2);

    console.log(`🎆 Round #${gameState.currentRound} started with ${count} holders`);

    io.emit('newRound', getGameStateForClient());
}

function updateGame() {
    if (gameState.phase !== 'racing') return;

    const elapsedTime = Date.now() - gameState.roundStartTime;

    // Update all fireworks
    gameState.fireworks.forEach(fw => fw.update(elapsedTime));

    // Update camera position - follow the average position of active fireworks
    const active = gameState.fireworks.filter(fw => !fw.hasExploded);
    if (active.length > 0) {
        const avgY = active.reduce((sum, fw) => sum + fw.y, 0) / active.length;
        // Smooth camera follow
        gameState.cameraY += (avgY - gameState.cameraY - 0.3) * 0.05;
        gameState.cameraY = Math.max(0, gameState.cameraY);
    }

    // Gradual elimination based on time phases
    eliminateByPhase();

    // Check winner conditions
    if (active.length === 1 && !gameState.winner) {
        // Last one standing - let them climb a bit more before winning
        setTimeout(() => {
            if (!gameState.winner) {
                const winner = gameState.fireworks.find(fw => !fw.hasExploded);
                if (winner) {
                    winner.explode();
                    endRound(winner);
                }
            }
        }, 2000);
    } else if (active.length === 0 && !gameState.winner) {
        // All exploded - find highest
        const winner = gameState.fireworks.reduce((max, fw) =>
            fw.y > max.y ? fw : max
        );
        endRound(winner);
    }
}

function eliminateByPhase() {
    const active = gameState.fireworks.filter(fw => !fw.hasExploded);
    const currentTime = gameState.timeRemaining;

    // Find which phase we're in
    for (let i = 0; i < CONFIG.ELIMINATION_PHASES.length; i++) {
        const phase = CONFIG.ELIMINATION_PHASES[i];

        if (currentTime <= phase.time && gameState.lastEliminationPhase < i) {
            gameState.lastEliminationPhase = i;

            // How many to eliminate
            const toEliminate = Math.max(0, active.length - phase.targetCount);

            if (toEliminate > 0) {
                // Sort by survival score (lowest gets eliminated)
                const sorted = [...active].sort((a, b) => a.survivalScore - b.survivalScore);

                // Eliminate the weakest ones gradually with delay
                for (let j = 0; j < toEliminate; j++) {
                    const fw = sorted[j];
                    // Stagger eliminations over 1 second for visual effect
                    setTimeout(() => {
                        if (!fw.hasExploded) {
                            fw.explode();
                            console.log(`💥 ${fw.wallet} eliminated at height ${Math.floor(fw.y * 1000)}m`);
                        }
                    }, j * (1000 / toEliminate));
                }
            }
            break;
        }
    }
}

function endRound(winner) {
    gameState.winner = winner.toJSON();
    gameState.phase = 'ended';

    gameState.winners.unshift({
        wallet: winner.wallet,
        round: gameState.currentRound,
        prize: gameState.prizePool,
        height: Math.floor(winner.y * 1000),
        timestamp: Date.now()
    });

    if (gameState.winners.length > 20) {
        gameState.winners = gameState.winners.slice(0, 20);
    }

    gameState.totalDistributed += parseFloat(gameState.prizePool);

    console.log(`🏆 Round #${gameState.currentRound} winner: ${winner.wallet} (${Math.floor(winner.y * 1000)}m)`);

    io.emit('roundEnded', {
        winner: gameState.winner,
        prizePool: gameState.prizePool,
        round: gameState.currentRound
    });

    setTimeout(() => {
        gameState.currentRound++;
        startNewRound();
    }, 5000);
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
        cameraY: gameState.cameraY,
        activeCount: gameState.fireworks.filter(fw => !fw.hasExploded).length,
        totalCount: gameState.fireworks.length
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
    if (gameState.phase === 'racing') {
        io.emit('gameState', getGameStateForClient());
    }
}, 1000 / 30);

// Timer countdown
setInterval(() => {
    if (gameState.phase === 'racing' && gameState.timeRemaining > 0) {
        gameState.timeRemaining--;

        if (gameState.timeRemaining === 0) {
            // Force final winner
            const active = gameState.fireworks.filter(fw => !fw.hasExploded);
            if (active.length > 0) {
                // Winner is the highest one
                const winner = active.reduce((max, fw) => fw.y > max.y ? fw : max);
                active.forEach(fw => fw.explode());
                endRound(winner);
            }
        }
    }
}, 1000);

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

server.listen(PORT, () => {
    console.log(`🚀 $FIREWORK Server running on port ${PORT}`);
    console.log(`🎆 Happy New Year 2025!`);
    startNewRound();
});
