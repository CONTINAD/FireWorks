/* ==========================================
   $FIREWORK - Client-Side Game Renderer
   Synchronized via Socket.io
   ========================================== */

// ==========================================
// SOCKET.IO CONNECTION
// ==========================================
const socket = io();

// ==========================================
// CONFIGURATION
// ==========================================
const CONFIG = {
    PARTICLE_COUNT: 40,
    GRAVITY: 0.025,
    FRICTION: 0.98,
    ROUND_DURATION: 45
};

// ==========================================
// CLIENT GAME STATE
// ==========================================
let clientState = {
    fireworks: [],
    winner: null,
    phase: 'racing',
    currentRound: 0,
    timeRemaining: 45,
    prizePool: '0.00',
    totalDistributed: '0.0',
    winners: [],
    lastReceivedRound: 0,
    cameraY: 0,
    activeCount: 0,
    totalCount: 0
};

// ==========================================
// PARTICLE CLASS
// ==========================================
class Particle {
    constructor(x, y, color, isTrail = false) {
        this.x = x;
        this.y = y;
        this.color = color;
        this.isTrail = isTrail;

        if (isTrail) {
            this.vx = (Math.random() - 0.5) * 1.5;
            this.vy = Math.random() * 1.5 + 0.5;
            this.life = 0.4 + Math.random() * 0.2;
            this.size = 2 + Math.random() * 2;
            this.decay = 0.025;
        } else {
            const angle = Math.random() * Math.PI * 2;
            const speed = 2 + Math.random() * 4;
            this.vx = Math.cos(angle) * speed;
            this.vy = Math.sin(angle) * speed;
            this.life = 1;
            this.size = 2 + Math.random() * 3;
            this.decay = 0.015 + Math.random() * 0.01;
        }
    }

    update() {
        this.x += this.vx;
        this.y += this.vy;
        this.vy += CONFIG.GRAVITY;
        this.vx *= CONFIG.FRICTION;
        this.vy *= CONFIG.FRICTION;
        this.life -= this.decay;
        this.size *= 0.97;
    }

    draw(ctx) {
        if (this.life <= 0) return;
        ctx.save();
        ctx.globalAlpha = Math.max(0, this.life);
        ctx.fillStyle = this.color;
        ctx.shadowColor = this.color;
        ctx.shadowBlur = this.isTrail ? 5 : 12;
        ctx.beginPath();
        ctx.arc(this.x, this.y, Math.max(0.5, this.size), 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
    }

    isDead() {
        return this.life <= 0;
    }
}

// ==========================================
// CLIENT FIREWORK (with camera offset)
// ==========================================
class ClientFirework {
    constructor(data, canvasWidth, canvasHeight) {
        this.id = data.id;
        this.wallet = data.wallet;
        this.color = data.color;
        this.secondaryColor = data.secondaryColor;
        this.hasExploded = data.hasExploded;
        this.heightReached = data.heightReached;

        // Store normalized positions
        this.normalizedX = data.x;
        this.normalizedY = data.y;

        this.canvasWidth = canvasWidth;
        this.canvasHeight = canvasHeight;

        this.trail = [];
        this.particles = [];
        this.wasExploded = data.hasExploded;
        this.size = 4;
    }

    update(newData, canvasWidth, canvasHeight, cameraY) {
        this.normalizedX = newData.x;
        this.normalizedY = newData.y;
        this.heightReached = newData.heightReached;
        this.canvasWidth = canvasWidth;
        this.canvasHeight = canvasHeight;

        // Convert to screen position with camera offset
        this.x = this.normalizedX * canvasWidth;
        // Y position: higher normalizedY = higher up = lower screen Y
        // Camera follows upward, so we offset by cameraY
        const relativeY = this.normalizedY - cameraY;
        this.y = canvasHeight - (relativeY * canvasHeight * 1.5) - 60;

        // Check if just exploded
        if (newData.hasExploded && !this.wasExploded) {
            this.explode();
            this.wasExploded = true;
        }
        this.hasExploded = newData.hasExploded;

        // Add trail if moving and not exploded
        if (!this.hasExploded && Math.random() > 0.4) {
            this.trail.push(new Particle(
                this.x + (Math.random() - 0.5) * 3,
                this.y + 5,
                this.color,
                true
            ));
        }

        // Update particles
        this.trail = this.trail.filter(p => {
            p.update();
            return !p.isDead();
        });

        this.particles = this.particles.filter(p => {
            p.update();
            return !p.isDead();
        });
    }

    explode() {
        for (let i = 0; i < CONFIG.PARTICLE_COUNT; i++) {
            this.particles.push(new Particle(this.x, this.y, this.color, false));
        }
        for (let i = 0; i < 20; i++) {
            this.particles.push(new Particle(this.x, this.y, this.secondaryColor, false));
        }
        for (let i = 0; i < 15; i++) {
            this.particles.push(new Particle(this.x, this.y, '#ffffff', false));
        }
    }

    isOnScreen(canvasHeight) {
        return this.y > -100 && this.y < canvasHeight + 100;
    }

    draw(ctx) {
        // Draw trail
        this.trail.forEach(p => p.draw(ctx));

        // Draw explosion particles
        this.particles.forEach(p => p.draw(ctx));

        if (this.hasExploded) return;

        // Only draw if on screen
        if (!this.isOnScreen(this.canvasHeight)) return;

        // Draw firework
        ctx.save();
        ctx.shadowColor = this.color;
        ctx.shadowBlur = 15;
        ctx.fillStyle = this.color;
        ctx.beginPath();
        ctx.arc(this.x, this.y, this.size, 0, Math.PI * 2);
        ctx.fill();

        // Inner core
        ctx.fillStyle = '#ffffff';
        ctx.shadowBlur = 8;
        ctx.beginPath();
        ctx.arc(this.x, this.y, this.size * 0.4, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();

        // Wallet label (smaller for more holders)
        ctx.save();
        ctx.font = 'bold 9px monospace';
        ctx.textAlign = 'center';
        ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
        const label = this.wallet.substring(0, 6);
        const textWidth = ctx.measureText(label).width;
        ctx.fillRect(this.x - textWidth / 2 - 3, this.y - 20, textWidth + 6, 12);
        ctx.fillStyle = this.color;
        ctx.fillText(label, this.x, this.y - 11);
        ctx.restore();
    }
}

// ==========================================
// BACKGROUND FIREWORK
// ==========================================
class BackgroundFirework {
    constructor(canvas) {
        this.canvas = canvas;
        this.x = Math.random() * canvas.width;
        this.y = canvas.height;
        this.targetY = 100 + Math.random() * (canvas.height * 0.5);
        this.vy = -4 - Math.random() * 3;
        this.color = ['#ff9500', '#ffd700', '#ff6b9d', '#9945FF', '#00d4ff', '#00ff88'][Math.floor(Math.random() * 6)];
        this.trail = [];
        this.particles = [];
        this.hasExploded = false;
    }

    update() {
        if (!this.hasExploded) {
            this.y += this.vy;
            this.vy += 0.03;
            if (Math.random() > 0.5) {
                this.trail.push(new Particle(this.x, this.y, this.color, true));
            }
            if (this.y <= this.targetY || this.vy >= 0) {
                this.explode();
            }
        }
        this.trail = this.trail.filter(p => { p.update(); return !p.isDead(); });
        this.particles = this.particles.filter(p => { p.update(); return !p.isDead(); });
    }

    explode() {
        this.hasExploded = true;
        for (let i = 0; i < 35; i++) {
            this.particles.push(new Particle(this.x, this.y, this.color, false));
        }
    }

    draw(ctx) {
        this.trail.forEach(p => p.draw(ctx));
        if (!this.hasExploded) {
            ctx.save();
            ctx.fillStyle = this.color;
            ctx.shadowColor = this.color;
            ctx.shadowBlur = 10;
            ctx.beginPath();
            ctx.arc(this.x, this.y, 3, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
        }
        this.particles.forEach(p => p.draw(ctx));
    }

    isComplete() {
        return this.hasExploded && this.particles.length === 0 && this.trail.length === 0;
    }
}

// ==========================================
// GAME RENDERER
// ==========================================
class GameRenderer {
    constructor() {
        this.gameCanvas = document.getElementById('game-canvas');
        this.gameCtx = this.gameCanvas.getContext('2d');
        this.bgCanvas = document.getElementById('bg-fireworks');
        this.bgCtx = this.bgCanvas.getContext('2d');

        this.clientFireworks = new Map();
        this.bgFireworks = [];
        this.cameraY = 0;
        this.targetCameraY = 0;

        this.setupCanvases();
        this.bindEvents();
        this.startBackgroundShow();
        this.startRenderLoop();
        this.setupSocketListeners();
        this.startNewYearCountdowns();
    }

    setupCanvases() {
        this.resizeBgCanvas();
        window.addEventListener('resize', () => this.resizeBgCanvas());
        this.resizeGameCanvas();
        const resizeObserver = new ResizeObserver(() => this.resizeGameCanvas());
        resizeObserver.observe(this.gameCanvas.parentElement);
    }

    resizeBgCanvas() {
        this.bgCanvas.width = window.innerWidth;
        this.bgCanvas.height = window.innerHeight;
    }

    resizeGameCanvas() {
        const parent = this.gameCanvas.parentElement;
        this.gameCanvas.width = parent.clientWidth;
        this.gameCanvas.height = parent.clientHeight;
    }

    bindEvents() {
        document.querySelector('.hero')?.addEventListener('click', () => {
            this.bgFireworks.push(new BackgroundFirework(this.bgCanvas));
        });

        document.getElementById('copy-ca')?.addEventListener('click', () => {
            const ca = document.getElementById('contract-address').textContent;
            navigator.clipboard.writeText(ca);
            this.showToast('Copied!');
        });

        document.getElementById('mobile-menu-btn')?.addEventListener('click', () => {
            document.getElementById('mobile-menu').classList.toggle('active');
        });

        document.querySelectorAll('a[href^="#"]').forEach(anchor => {
            anchor.addEventListener('click', (e) => {
                e.preventDefault();
                const target = document.querySelector(anchor.getAttribute('href'));
                if (target) {
                    target.scrollIntoView({ behavior: 'smooth' });
                    document.getElementById('mobile-menu')?.classList.remove('active');
                }
            });
        });
    }

    showToast(message) {
        const toast = document.createElement('div');
        toast.textContent = message;
        toast.style.cssText = `
            position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%);
            background: rgba(255, 215, 0, 0.9); color: #000; padding: 12px 24px;
            border-radius: 8px; font-weight: 600; z-index: 9999;
        `;
        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), 2000);
    }

    setupSocketListeners() {
        socket.on('gameState', (state) => {
            if (state.currentRound !== clientState.lastReceivedRound) {
                this.clientFireworks.clear();
                clientState.lastReceivedRound = state.currentRound;
                this.cameraY = 0;
            }
            this.updateFromServer(state);
        });

        socket.on('newRound', (state) => {
            this.clientFireworks.clear();
            clientState.lastReceivedRound = state.currentRound;
            this.cameraY = 0;
            this.targetCameraY = 0;
            document.getElementById('game-overlay').classList.remove('active');
            this.updateFromServer(state);
        });

        socket.on('roundEnded', (data) => {
            this.showWinner(data);
        });

        socket.on('winners', (winners) => {
            this.updateWinnersTable(winners);
        });

        socket.on('connect', () => {
            console.log('🔌 Connected to server');
            this.clientFireworks.clear();
        });
    }

    updateFromServer(state) {
        clientState = { ...clientState, ...state };

        // Update camera target
        this.targetCameraY = state.cameraY || 0;

        // Smooth camera follow
        this.cameraY += (this.targetCameraY - this.cameraY) * 0.1;

        // Update UI
        document.getElementById('current-round').textContent = `#${state.currentRound}`;
        const timeStr = state.timeRemaining >= 60
            ? `${Math.floor(state.timeRemaining / 60)}:${(state.timeRemaining % 60).toString().padStart(2, '0')}`
            : `0:${state.timeRemaining.toString().padStart(2, '0')}`;
        document.getElementById('game-timer').textContent = timeStr;
        document.getElementById('hero-countdown').textContent = timeStr;
        document.getElementById('timer-progress').style.width = `${(state.timeRemaining / CONFIG.ROUND_DURATION) * 100}%`;
        document.getElementById('prize-pool').textContent = `${state.prizePool} SOL`;
        document.getElementById('total-distributed').textContent = state.totalDistributed;
        document.getElementById('total-given').textContent = `${state.totalDistributed} SOL`;

        // Show active/total count
        const activeCount = state.activeCount || state.fireworks.filter(fw => !fw.hasExploded).length;
        const totalCount = state.totalCount || state.fireworks.length;
        document.getElementById('active-fireworks').textContent = `${activeCount} / ${totalCount}`;

        // Update fireworks
        const canvasWidth = this.gameCanvas.width;
        const canvasHeight = this.gameCanvas.height;

        const serverIds = new Set(state.fireworks.map(fw => fw.id));

        for (const id of this.clientFireworks.keys()) {
            if (!serverIds.has(id)) {
                this.clientFireworks.delete(id);
            }
        }

        state.fireworks.forEach(fwData => {
            if (this.clientFireworks.has(fwData.id)) {
                this.clientFireworks.get(fwData.id).update(fwData, canvasWidth, canvasHeight, this.cameraY);
            } else {
                const fw = new ClientFirework(fwData, canvasWidth, canvasHeight);
                fw.update(fwData, canvasWidth, canvasHeight, this.cameraY);
                this.clientFireworks.set(fwData.id, fw);
            }
        });

        if (state.winners && state.winners.length > 0) {
            this.updateWinnersTable(state.winners);
        }
    }

    showWinner(data) {
        document.getElementById('winner-wallet').textContent = data.winner.wallet + '...';
        document.getElementById('winner-prize').textContent = `${data.prizePool} SOL`;

        const overlay = document.getElementById('game-overlay');
        let heightInfo = overlay.querySelector('.winner-height');
        if (!heightInfo) {
            heightInfo = document.createElement('p');
            heightInfo.className = 'winner-height';
            heightInfo.style.cssText = 'font-size: 16px; color: #00ff88; margin-top: 8px;';
            overlay.querySelector('.winner-announcement').appendChild(heightInfo);
        }
        heightInfo.textContent = `🚀 Reached ${data.winner.heightReached}m - THE LAST SURVIVOR!`;

        overlay.classList.add('active');
    }

    updateWinnersTable(winners) {
        const tbody = document.getElementById('winners-list');
        tbody.innerHTML = '';

        winners.slice(0, 8).forEach((winner, index) => {
            const row = document.createElement('tr');
            row.className = 'winner-row' + (index === 0 ? ' gold' : index === 1 ? ' silver' : index === 2 ? ' bronze' : '');

            const rankBadge = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : (index + 1);
            const timeAgo = this.getTimeAgo(winner.timestamp);

            row.innerHTML = `
                <td><span class="rank-badge">${rankBadge}</span></td>
                <td class="wallet-cell"><span class="wallet-address">${winner.wallet}...</span></td>
                <td>#${winner.round}</td>
                <td class="prize-cell">${winner.prize} SOL</td>
                <td>${timeAgo}</td>
                <td><a href="https://solscan.io/tx/example${winner.round}" target="_blank" class="verify-link">Solscan ↗</a></td>
            `;
            tbody.appendChild(row);
        });
    }

    getTimeAgo(timestamp) {
        const seconds = Math.floor((Date.now() - timestamp) / 1000);
        if (seconds < 60) return 'Just now';
        const minutes = Math.floor(seconds / 60);
        if (minutes < 60) return `${minutes} min ago`;
        const hours = Math.floor(minutes / 60);
        return `${hours}h ago`;
    }

    startBackgroundShow() {
        setInterval(() => {
            if (Math.random() > 0.5) {
                this.bgFireworks.push(new BackgroundFirework(this.bgCanvas));
            }
        }, 700);

        const animateBg = () => {
            this.bgCtx.clearRect(0, 0, this.bgCanvas.width, this.bgCanvas.height);
            this.bgFireworks = this.bgFireworks.filter(fw => {
                fw.update();
                fw.draw(this.bgCtx);
                return !fw.isComplete();
            });
            requestAnimationFrame(animateBg);
        };
        animateBg();
    }

    startRenderLoop() {
        const render = () => {
            this.drawGame();
            requestAnimationFrame(render);
        };
        render();
    }

    drawGame() {
        const ctx = this.gameCtx;

        // Clear with fade for trail effect
        ctx.fillStyle = 'rgba(5, 5, 16, 0.12)';
        ctx.fillRect(0, 0, this.gameCanvas.width, this.gameCanvas.height);

        // Draw height indicator
        this.drawHeightIndicator();

        // Draw all fireworks
        this.clientFireworks.forEach(fw => fw.draw(ctx));

        // Leader indicator
        this.drawLeaderIndicator();

        // Draw survivor count
        this.drawSurvivorCount();
    }

    drawHeightIndicator() {
        const ctx = this.gameCtx;
        const height = Math.floor(this.cameraY * 1000);

        ctx.save();
        ctx.font = 'bold 12px monospace';
        ctx.fillStyle = 'rgba(255, 215, 0, 0.6)';
        ctx.textAlign = 'left';
        ctx.fillText(`↑ ${height}m`, 15, 30);
        ctx.restore();
    }

    drawLeaderIndicator() {
        const active = Array.from(this.clientFireworks.values()).filter(fw => !fw.hasExploded && fw.isOnScreen(this.gameCanvas.height));
        if (active.length === 0) return;

        const leader = active.reduce((max, fw) => fw.heightReached > max.heightReached ? fw : max);

        const ctx = this.gameCtx;
        ctx.save();
        ctx.font = 'bold 10px monospace';
        ctx.textAlign = 'center';
        ctx.fillStyle = '#ffd700';
        ctx.shadowColor = '#ffd700';
        ctx.shadowBlur = 10;
        ctx.fillText('👑 LEADING', leader.x, leader.y - 35);
        ctx.restore();
    }

    drawSurvivorCount() {
        const active = Array.from(this.clientFireworks.values()).filter(fw => !fw.hasExploded);
        const total = this.clientFireworks.size;

        if (total === 0) return;

        const ctx = this.gameCtx;
        ctx.save();
        ctx.font = 'bold 14px monospace';
        ctx.fillStyle = active.length <= 5 ? '#ff4444' : active.length <= 15 ? '#ffaa00' : '#00ff88';
        ctx.textAlign = 'right';
        ctx.fillText(`🎆 ${active.length} survivors`, this.gameCanvas.width - 15, 30);
        ctx.restore();
    }

    // ==========================================
    // NEW YEAR COUNTDOWNS
    // ==========================================
    startNewYearCountdowns() {
        const updateCountdowns = () => {
            const now = new Date();
            const year = now.getFullYear();
            const nextYear = now.getMonth() === 11 && now.getDate() === 31 ? year + 1 : year + 1;

            const timezones = [
                { name: 'NYC', offset: -5, emoji: '🗽' },
                { name: 'LA', offset: -8, emoji: '🌴' },
                { name: 'London', offset: 0, emoji: '🇬🇧' },
                { name: 'Dubai', offset: 4, emoji: '🇦🇪' },
                { name: 'Tokyo', offset: 9, emoji: '🇯🇵' },
                { name: 'Sydney', offset: 11, emoji: '🇦🇺' }
            ];

            const container = document.getElementById('ny-countdowns');
            if (!container) return;

            container.innerHTML = timezones.map(tz => {
                const localNow = new Date(now.getTime() + (now.getTimezoneOffset() + tz.offset * 60) * 60000);
                const newYear = new Date(nextYear, 0, 1, 0, 0, 0);
                const tzNewYear = new Date(newYear.getTime() - tz.offset * 60 * 60000);

                let diff = tzNewYear - now;

                if (diff <= 0) {
                    return `<div class="countdown-item celebrated">${tz.emoji} ${tz.name}: 🎉 2025!</div>`;
                }

                const hours = Math.floor(diff / (1000 * 60 * 60));
                const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
                const seconds = Math.floor((diff % (1000 * 60)) / 1000);

                return `<div class="countdown-item">${tz.emoji} ${tz.name}: ${hours}h ${minutes}m ${seconds}s</div>`;
            }).join('');
        };

        updateCountdowns();
        setInterval(updateCountdowns, 1000);
    }
}

// ==========================================
// DYNAMIC UPDATES
// ==========================================
function updateDevSupply() {
    const devSupply = 1 + Math.random() * 3;
    const el = document.getElementById('dev-supply');
    if (el) el.textContent = `${devSupply.toFixed(2)} SOL`;
}

function updateHolders() {
    const holders = 1200 + Math.floor(Math.random() * 100);
    const el = document.getElementById('total-holders');
    if (el) el.textContent = holders.toLocaleString();
}

// ==========================================
// INITIALIZATION
// ==========================================
document.addEventListener('DOMContentLoaded', () => {
    const game = new GameRenderer();

    setInterval(updateDevSupply, 5000);
    setInterval(updateHolders, 10000);

    window.addEventListener('scroll', () => {
        const navbar = document.querySelector('.navbar');
        if (navbar) {
            navbar.style.background = window.scrollY > 50 ? 'rgba(10, 10, 26, 0.95)' : 'rgba(10, 10, 26, 0.8)';
        }
    });

    console.log('🎆 $FIREWORK Race Client - 50 Holders Battle! 🎆');
});
