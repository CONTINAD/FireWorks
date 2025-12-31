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
    ROUND_DURATION: 30,
    MIN_FIREWORKS: 12,
    MAX_FIREWORKS: 18,
    TICK_RATE: 60, // 60 FPS
    COLORS: [
        '#ff9500', '#ffd700', '#ff6b9d', '#9945FF',
        '#00d4ff', '#00ff88', '#ff4d4d', '#ffffff',
        '#ff3366', '#33ff99', '#6699ff', '#ffcc00'
    ]
};

// Mock wallet addresses
const MOCK_WALLETS = [
    '7xKp4mNw', '3fRt8jKl', '9mNp2xWq', '5kLm7yZa',
    '2pQr9sBt', '8tUv3nCd', '4wXy6mEf', '1aZb5hGi',
    'Fm3nJ7kP', 'Lx9oW2yA', 'Hp6qZ8dB', 'Nv4rS3fC',
    'Qy1tU5gD', 'Sw8uV6hE', 'Ux5vW7iF', 'Wz2wX8jG',
    'Bk7mR4pL', 'Cn9sT6qN'
];

// ==========================================
// GAME STATE (Server-side, shared by all)
// ==========================================
let gameState = {
    currentRound: 127,
    timeRemaining: CONFIG.ROUND_DURATION,
    prizePool: 0.8,
    totalDistributed: 127.5,
    fireworks: [],
    winner: null,
    phase: 'racing', // 'racing', 'ended', 'waiting'
    roundStartTime: Date.now(),
    winners: [], // History of winners
    cameraY: 0 // Camera position (follows fireworks up)
};

// ==========================================
// FIREWORK CLASS (Server-side)
// ==========================================
class ServerFirework {
    constructor(id, wallet, lane, totalLanes) {
        this.id = id;
        this.wallet = wallet;
        this.lane = lane;
        this.totalLanes = totalLanes;

        // Position (normalized 0-1, client scales to canvas)
        this.x = (lane + 0.5) / totalLanes;
        this.y = 1.0; // Start at bottom
        this.startY = 1.0;

        // Racing properties
        this.baseSpeed = 0.003 + Math.random() * 0.002;
        this.speed = this.baseSpeed;
        this.wobble = Math.random() * Math.PI * 2;

        // Visual
        this.color = CONFIG.COLORS[Math.floor(Math.random() * CONFIG.COLORS.length)];
        this.secondaryColor = CONFIG.COLORS[Math.floor(Math.random() * CONFIG.COLORS.length)];

        // State
        this.hasExploded = false;
        this.heightReached = 0;
        this.survivalStrength = Math.random();
    }

    update(elapsedTime) {
        if (this.hasExploded) return;

        // Move upward
        this.y -= this.speed;

        // Speed variation
        this.speed = this.baseSpeed + Math.sin(elapsedTime * 0.001 + this.id) * 0.0005;

        // Wobble
        this.wobble += 0.05;
        this.x += Math.sin(this.wobble) * 0.001;

        // Keep in bounds
        this.x = Math.max(0.05, Math.min(0.95, this.x));

        // Height reached
        this.heightReached = (this.startY - this.y) * 1000;

        // Random explosion chance
        const heightPercent = this.heightReached / 800;
        const explosionChance = 0.001 + (heightPercent * 0.002) - (this.survivalStrength * 0.001);

        if (heightPercent > 0.1 && Math.random() < explosionChance) {
            this.explode();
        }

        // Force explode at top
        if (this.y < 0.05) {
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
    gameState.cameraY = 0; // Reset camera

    // Generate fireworks
    const count = CONFIG.MIN_FIREWORKS + Math.floor(Math.random() * (CONFIG.MAX_FIREWORKS - CONFIG.MIN_FIREWORKS));

    for (let i = 0; i < count; i++) {
        const wallet = MOCK_WALLETS[i % MOCK_WALLETS.length];
        gameState.fireworks.push(new ServerFirework(i, wallet, i, count));
    }

    gameState.prizePool = (0.5 + Math.random() * 1.5).toFixed(2);

    console.log(`🎆 Round #${gameState.currentRound} started with ${count} fireworks`);

    // Broadcast new round
    io.emit('newRound', getGameStateForClient());
}

function updateGame() {
    if (gameState.phase !== 'racing') return;

    const elapsedTime = Date.now() - gameState.roundStartTime;

    // Update all fireworks
    gameState.fireworks.forEach(fw => fw.update(elapsedTime));

    // Update camera to follow the pack (average height of active fireworks)
    const active = gameState.fireworks.filter(fw => !fw.hasExploded);
    if (active.length > 0) {
        const avgHeight = active.reduce((sum, fw) => sum + (1 - fw.y), 0) / active.length;
        // Smooth camera follow
        gameState.cameraY += (avgHeight - gameState.cameraY) * 0.05;
    }

    // Check winner conditions
    if (active.length === 1 && !gameState.winner) {
        // Last one standing!
        const winner = active[0];
        winner.explode();
        endRound(winner);
    } else if (active.length === 0 && !gameState.winner) {
        // All exploded - find highest
        const winner = gameState.fireworks.reduce((max, fw) =>
            fw.heightReached > max.heightReached ? fw : max
        );
        endRound(winner);
    }
}

function endRound(winner) {
    gameState.winner = winner.toJSON();
    gameState.phase = 'ended';

    // Add to winners history
    gameState.winners.unshift({
        wallet: winner.wallet,
        round: gameState.currentRound,
        prize: gameState.prizePool,
        height: Math.floor(winner.heightReached),
        timestamp: Date.now()
    });

    // Keep only last 20 winners
    if (gameState.winners.length > 20) {
        gameState.winners = gameState.winners.slice(0, 20);
    }

    gameState.totalDistributed += parseFloat(gameState.prizePool);

    console.log(`🏆 Round #${gameState.currentRound} winner: ${winner.wallet} (${Math.floor(winner.heightReached)}m)`);

    // Broadcast winner
    io.emit('roundEnded', {
        winner: gameState.winner,
        prizePool: gameState.prizePool,
        round: gameState.currentRound
    });

    // Schedule next round
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
        cameraY: gameState.cameraY // Send camera position to client
    };
}

// ==========================================
// GAME LOOPS
// ==========================================

// Physics update (60 FPS)
setInterval(() => {
    updateGame();
}, 1000 / CONFIG.TICK_RATE);

// Broadcast state to all clients (30 FPS for network efficiency)
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
            // Force end round
            const active = gameState.fireworks.filter(fw => !fw.hasExploded);
            active.forEach(fw => fw.explode());

            const winner = gameState.fireworks.reduce((max, fw) =>
                fw.heightReached > max.heightReached ? fw : max
            );
            endRound(winner);
        }
    }
}, 1000);

// ==========================================
// SOCKET.IO CONNECTIONS
// ==========================================
io.on('connection', (socket) => {
    console.log(`👤 User connected: ${socket.id}`);

    // Send current game state to new connection
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

    // Start first round
    startNewRound();
});
