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
    PARTICLE_COUNT: 30,
    GRAVITY: 0.025,
    FRICTION: 0.98
};

// ==========================================
// CLIENT GAME STATE
// ==========================================
let clientState = {
    fireworks: [],
    winner: null,
    phase: 'racing',
    currentRound: 0,
    timeRemaining: 30,
    prizePool: '0.00',
    totalDistributed: '0.0',
    winners: [],
    lastReceivedRound: 0,
    cameraY: 0 // Camera offset for scrolling
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
            this.decay = 0.02;
        } else {
            const angle = Math.random() * Math.PI * 2;
            const speed = 2 + Math.random() * 5;
            this.vx = Math.cos(angle) * speed;
            this.vy = Math.sin(angle) * speed;
            this.life = 1;
            this.size = 2 + Math.random() * 4;
            this.decay = 0.012 + Math.random() * 0.008;
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
        ctx.shadowBlur = this.isTrail ? 5 : 15;
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
// CLIENT FIREWORK (Visual only)
// ==========================================
class ClientFirework {
    constructor(data, canvasWidth, canvasHeight) {
        this.id = data.id;
        this.wallet = data.wallet;
        this.color = data.color;
        this.secondaryColor = data.secondaryColor;
        this.hasExploded = data.hasExploded;
        this.heightReached = data.heightReached;

        // Convert normalized position to canvas coords
        this.x = data.x * canvasWidth;
        this.y = data.y * canvasHeight;
        this.canvasHeight = canvasHeight;

        this.trail = [];
        this.particles = [];
        this.wasExploded = data.hasExploded;
        this.size = 5;
    }

    update(newData, canvasWidth, canvasHeight, cameraY = 0) {
        const prevX = this.x;
        const prevY = this.y;

        this.x = newData.x * canvasWidth;
        // Simple camera follow - rockets climb visually
        const rawY = newData.y * canvasHeight;
        this.y = rawY + (cameraY * canvasHeight * 0.6);
        this.heightReached = newData.heightReached;

        // Check if just exploded
        if (newData.hasExploded && !this.wasExploded) {
            this.explode();
            this.wasExploded = true;
        }
        this.hasExploded = newData.hasExploded;

        // Add trail if moving and not exploded
        if (!this.hasExploded && Math.random() > 0.3) {
            this.trail.push(new Particle(
                this.x + (Math.random() - 0.5) * 4,
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
        for (let i = 0; i < 25; i++) {
            this.particles.push(new Particle(this.x, this.y, this.secondaryColor, false));
        }
        for (let i = 0; i < 20; i++) {
            this.particles.push(new Particle(this.x, this.y, '#ffffff', false));
        }
    }

    draw(ctx) {
        // Draw trail
        this.trail.forEach(p => p.draw(ctx));

        // Draw explosion particles
        this.particles.forEach(p => p.draw(ctx));

        if (this.hasExploded) return;

        // Draw firework
        ctx.save();
        ctx.shadowColor = this.color;
        ctx.shadowBlur = 20;
        ctx.fillStyle = this.color;
        ctx.beginPath();
        ctx.arc(this.x, this.y, this.size, 0, Math.PI * 2);
        ctx.fill();

        // Inner core
        ctx.fillStyle = '#ffffff';
        ctx.shadowBlur = 10;
        ctx.beginPath();
        ctx.arc(this.x, this.y, this.size * 0.4, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();

        // Label
        ctx.save();
        ctx.font = 'bold 11px monospace';
        ctx.textAlign = 'center';
        ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
        const label = this.wallet;
        const textWidth = ctx.measureText(label).width;
        ctx.fillRect(this.x - textWidth / 2 - 4, this.y - 25, textWidth + 8, 16);
        ctx.fillStyle = this.color;
        ctx.fillText(label, this.x, this.y - 13);

        // Height
        ctx.font = '9px monospace';
        ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
        ctx.fillText(this.heightReached + 'm', this.x, this.y - 35);
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
        for (let i = 0; i < 40; i++) {
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
            // If round changed, clear old fireworks first
            if (state.currentRound !== clientState.lastReceivedRound) {
                this.clientFireworks.clear();
                clientState.lastReceivedRound = state.currentRound;
            }
            this.updateFromServer(state);
        });

        socket.on('newRound', (state) => {
            this.clientFireworks.clear();
            clientState.lastReceivedRound = state.currentRound;
            document.getElementById('game-overlay').classList.remove('active');
            this.updateFromServer(state);
        });

        socket.on('roundEnded', (data) => {
            this.showWinner(data);
        });

        socket.on('winners', (winners) => {
            this.updateWinnersTable(winners);
        });

        // Handle reconnection - clear and resync
        socket.on('connect', () => {
            console.log('🔌 Connected to server');
            this.clientFireworks.clear();
        });
    }

    updateFromServer(state) {
        clientState = { ...clientState, ...state };

        // Update UI
        document.getElementById('current-round').textContent = `#${state.currentRound}`;
        if (state.phase === 'celebrating') {
            document.getElementById('game-timer').textContent = "WINNER!";
            document.getElementById('hero-countdown').textContent = "WINNER!";
        } else {
            document.getElementById('game-timer').textContent = `0:${state.timeRemaining.toString().padStart(2, '0')}`;
            document.getElementById('hero-countdown').textContent = `0:${state.timeRemaining.toString().padStart(2, '0')}`;
        }
        document.getElementById('timer-progress').style.width = `${(state.timeRemaining / 30) * 100}%`;
        document.getElementById('prize-pool').textContent = `${state.prizePool} SOL`;
        document.getElementById('total-distributed').textContent = state.totalDistributed;
        document.getElementById('total-given').textContent = `${state.totalDistributed} SOL`;

        const activeCount = state.fireworks.filter(fw => !fw.hasExploded).length;
        document.getElementById('active-fireworks').textContent = activeCount;

        // Update fireworks with camera offset
        const canvasWidth = this.gameCanvas.width;
        const canvasHeight = this.gameCanvas.height;
        const cameraY = state.cameraY || 0;

        // Get IDs from server state
        const serverIds = new Set(state.fireworks.map(fw => fw.id));

        // Remove any fireworks not in server state (cleanup stale ones)
        for (const id of this.clientFireworks.keys()) {
            if (!serverIds.has(id)) {
                this.clientFireworks.delete(id);
            }
        }

        state.fireworks.forEach(fwData => {
            if (this.clientFireworks.has(fwData.id)) {
                this.clientFireworks.get(fwData.id).update(fwData, canvasWidth, canvasHeight, cameraY);
            } else {
                const fw = new ClientFirework(fwData, canvasWidth, canvasHeight);
                fw.update(fwData, canvasWidth, canvasHeight, cameraY);
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
        heightInfo.textContent = `🚀 Reached ${data.winner.heightReached}m - HIGHEST CLIMBER!`;

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
            if (Math.random() > 0.4) {
                this.bgFireworks.push(new BackgroundFirework(this.bgCanvas));
            }
        }, 600);

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
        const width = this.gameCanvas.width;
        const height = this.gameCanvas.height;

        // Init zoom if not set
        if (!this.renderZoom) {
            this.renderZoom = 1.0;
            this.focusX = width / 2;
            this.focusY = height / 2;
        }

        // Full clear - no ghosting/shadows
        ctx.fillStyle = 'rgb(5, 5, 16)';
        ctx.fillRect(0, 0, width, height);

        // --- CAMERA LOGIC ---
        let targetZoom = 1.0;
        let targetFocusX = width / 2;
        let targetFocusY = height / 2;

        if (clientState.phase === 'celebrating' && clientState.winner) {
            targetZoom = 2.0; // Zoom in!
            // Track winner
            const winnerFw = this.clientFireworks.get(clientState.winner.id);
            if (winnerFw) {
                targetFocusX = winnerFw.x;
                targetFocusY = winnerFw.y;
            }
        }

        // Smooth Lerp
        this.renderZoom += (targetZoom - this.renderZoom) * 0.05;
        this.focusX += (targetFocusX - this.focusX) * 0.1;
        this.focusY += (targetFocusY - this.focusY) * 0.1;

        ctx.save();

        // Apply Camera Transform: Scale around focus point
        ctx.translate(width / 2, height / 2);
        ctx.scale(this.renderZoom, this.renderZoom);
        ctx.translate(-this.focusX, -this.focusY);

        // Draw all fireworks
        this.clientFireworks.forEach(fw => fw.draw(ctx));

        // Leader indicator
        this.drawLeaderIndicator();

        ctx.restore();
    }

    drawHeightMarkers() {
        const ctx = this.gameCtx;
        const height = this.gameCanvas.height;

        ctx.save();
        ctx.font = '10px monospace';
        ctx.fillStyle = 'rgba(255, 255, 255, 0.15)';
        ctx.textAlign = 'right';

        for (let h = 100; h < 3000; h += 100) {
            const y = height - (h / 1000) * height;
            // Draw ALL markers - camera transform handles visibility
            ctx.fillText(`${h}m`, 40, y);
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
            ctx.setLineDash([5, 10]);
            ctx.beginPath();
            ctx.moveTo(50, y);
            ctx.lineTo(this.gameCanvas.width - 20, y);
            ctx.stroke();
        }
        ctx.setLineDash([]);
        ctx.restore();
    }

    drawLeaderIndicator() {
        const active = Array.from(this.clientFireworks.values()).filter(fw => !fw.hasExploded);
        if (active.length === 0) return;

        const leader = active.reduce((max, fw) => fw.heightReached > max.heightReached ? fw : max);

        const ctx = this.gameCtx;
        ctx.save();
        ctx.font = 'bold 10px monospace';
        ctx.textAlign = 'center';
        ctx.fillStyle = '#ffd700';
        ctx.shadowColor = '#ffd700';
        ctx.shadowBlur = 10;
        ctx.fillText('👑 LEADING', leader.x, leader.y - 50);
        ctx.restore();
    }

    drawStars() {
        const ctx = this.gameCtx;
        const time = Date.now() / 1000;

        for (let i = 0; i < 40; i++) {
            const x = (i * 47 + 20) % this.gameCanvas.width;
            const y = (i * 31 + 10) % (this.gameCanvas.height - 150);
            const twinkle = Math.sin(time * 2 + i) * 0.5 + 0.5;
            ctx.fillStyle = `rgba(255, 255, 255, ${0.05 + twinkle * 0.15})`;
            ctx.beginPath();
            ctx.arc(x, y, 1, 0, Math.PI * 2);
            ctx.fill();
        }
    }

    // ==========================================
    // NEW YEAR COUNTDOWNS
    // ==========================================
    startNewYearCountdowns() {
        const updateCountdowns = () => {
            const now = new Date();

            // ISO Time strings for 2025 New Year
            const timezones = [
                { name: 'NYC', time: '2025-01-01T00:00:00-05:00', emoji: '🗽' },
                { name: 'LA', time: '2025-01-01T00:00:00-08:00', emoji: '🌴' },
                { name: 'London', time: '2025-01-01T00:00:00+00:00', emoji: '🇬🇧' },
                { name: 'Dubai', time: '2025-01-01T00:00:00+04:00', emoji: '🇦🇪' },
                { name: 'Tokyo', time: '2025-01-01T00:00:00+09:00', emoji: '🇯🇵' },
                { name: 'Sydney', time: '2025-01-01T00:00:00+11:00', emoji: '🇦🇺' }
            ];

            const container = document.getElementById('ny-countdowns');
            if (!container) return;

            container.innerHTML = timezones.map(tz => {
                const targetTime = new Date(tz.time).getTime();
                let diff = targetTime - now.getTime();

                // If diff is negative by MORE than 1 day, user's clock is probably wrong (set to 2025)
                // Just show celebration
                if (diff < -86400000) {
                    return `<div class="countdown-item celebrated">${tz.emoji} <span class="tz-name">${tz.name}</span> <span class="celebrate">🎉 2025!</span></div>`;
                }

                // Normal countdown
                if (diff <= 0) {
                    return `<div class="countdown-item celebrated">${tz.emoji} <span class="tz-name">${tz.name}</span> <span class="celebrate">🎉 2025!</span></div>`;
                }

                const totalSecs = Math.floor(diff / 1000);
                const hours = Math.floor(totalSecs / 3600);
                const minutes = Math.floor((totalSecs % 3600) / 60);
                const seconds = totalSecs % 60;

                return `<div class="countdown-item">${tz.emoji} <span class="tz-name">${tz.name}</span> <span class="tz-time">${hours}h ${minutes}m ${seconds}s</span></div>`;
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

    console.log('🎆 $FIREWORK Client Connected - Happy New Year 2025! 🎆');
});
