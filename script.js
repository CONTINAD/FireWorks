/* ==========================================
   $FIREWORK - Game Logic & Animations
   High-quality firework battle game engine
   ========================================== */

// ==========================================
// CONFIGURATION
// ==========================================
const CONFIG = {
    ROUND_DURATION: 30, // 30 seconds per round
    MIN_FIREWORKS: 12,
    MAX_FIREWORKS: 20,
    PARTICLE_COUNT: 60,
    COLORS: [
        '#ff9500', '#ffd700', '#ff6b9d', '#9945FF',
        '#00d4ff', '#00ff88', '#ff4d4d', '#ffffff',
        '#ff3366', '#33ff99', '#6699ff', '#ffcc00'
    ],
    GRAVITY: 0.025,
    FRICTION: 0.98,
    // Race settings
    BASE_SPEED: 2.5,
    SPEED_VARIANCE: 1.5,
    EXPLOSION_CHANCE_BASE: 0.002, // Base chance per frame to explode
    EXPLOSION_CHANCE_INCREASE: 0.0001 // Increases as firework gets higher
};

// ==========================================
// GAME STATE
// ==========================================
let gameState = {
    currentRound: 127,
    timeRemaining: 30,
    prizePool: 0.8,
    activeFireworks: 0,
    totalDistributed: 127.5,
    isRunning: false,
    roundStarted: false,
    fireworks: [],
    winner: null,
    highestReached: 0
};

// Mock wallet addresses for demo
const MOCK_WALLETS = [
    '7xKp4mNw', '3fRt8jKl', '9mNp2xWq', '5kLm7yZa',
    '2pQr9sBt', '8tUv3nCd', '4wXy6mEf', '1aZb5hGi',
    'Fm3nJ7kP', 'Lx9oW2yA', 'Hp6qZ8dB', 'Nv4rS3fC',
    'Qy1tU5gD', 'Sw8uV6hE', 'Ux5vW7iF', 'Wz2wX8jG',
    'Bk7mR4pL', 'Cn9sT6qN', 'Dj2uV8rP', 'Ef4wX1sQ'
];

// ==========================================
// PARTICLE CLASS
// ==========================================
class Particle {
    constructor(x, y, color, isTrail = false, isExplosion = false) {
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
            // Explosion particle - bigger and more dramatic
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
// RACING FIREWORK CLASS
// ==========================================
class RacingFirework {
    constructor(id, walletAddress, lane, totalLanes, canvasWidth, canvasHeight) {
        this.id = id;
        this.wallet = walletAddress;
        this.canvasHeight = canvasHeight;

        // Position in lane
        const laneWidth = (canvasWidth - 100) / totalLanes;
        this.x = 50 + lane * laneWidth + laneWidth / 2;
        this.y = canvasHeight - 80;
        this.startY = this.y;

        // Racing properties
        this.baseSpeed = CONFIG.BASE_SPEED + (Math.random() - 0.5) * CONFIG.SPEED_VARIANCE;
        this.speed = this.baseSpeed;
        this.wobble = Math.random() * Math.PI * 2;
        this.wobbleSpeed = 0.05 + Math.random() * 0.05;
        this.wobbleAmount = 3 + Math.random() * 5;

        // Visual properties
        this.color = CONFIG.COLORS[Math.floor(Math.random() * CONFIG.COLORS.length)];
        this.secondaryColor = CONFIG.COLORS[Math.floor(Math.random() * CONFIG.COLORS.length)];
        this.trail = [];
        this.particles = [];
        this.size = 5;
        this.glowIntensity = 1;

        // State
        this.hasExploded = false;
        this.explosionY = null;
        this.heightReached = 0;
        this.rank = 0;
        this.isWinner = false;

        // Random "survival strength" - higher = survives longer
        this.survivalStrength = Math.random();
    }

    update(elapsedTime) {
        if (this.hasExploded) {
            // Update explosion particles only
            this.particles = this.particles.filter(p => {
                p.update();
                return !p.isDead();
            });
            return;
        }

        // Race upward!
        this.y -= this.speed;

        // Add slight speed variation for excitement
        this.speed = this.baseSpeed + Math.sin(elapsedTime * 0.01 + this.id) * 0.3;

        // Wobble side to side
        this.wobble += this.wobbleSpeed;
        this.x += Math.sin(this.wobble) * this.wobbleAmount * 0.1;

        // Track height reached (inverted because y decreases as we go up)
        this.heightReached = this.startY - this.y;

        // Random explosion chance - increases as firework gets higher
        const heightPercent = this.heightReached / (this.canvasHeight - 150);
        const explosionChance = CONFIG.EXPLOSION_CHANCE_BASE +
            (heightPercent * CONFIG.EXPLOSION_CHANCE_INCREASE * 10) -
            (this.survivalStrength * 0.002); // Survival strength reduces chance

        // More likely to explode after a certain height
        if (heightPercent > 0.1 && Math.random() < explosionChance) {
            this.explode();
            return;
        }

        // Force explode if reaches very top
        if (this.y < 30) {
            this.explode();
            return;
        }

        // Add trail particles
        if (Math.random() > 0.2) {
            this.trail.push(new Particle(
                this.x + (Math.random() - 0.5) * 4,
                this.y + 5,
                this.color,
                true
            ));
        }

        // Sparks
        if (Math.random() > 0.7) {
            this.trail.push(new Particle(
                this.x + (Math.random() - 0.5) * 8,
                this.y,
                this.secondaryColor,
                true
            ));
        }

        // Update trail
        this.trail = this.trail.filter(p => {
            p.update();
            return !p.isDead();
        });

        // Glow pulsing
        this.glowIntensity = 0.8 + Math.sin(elapsedTime * 0.005 + this.id) * 0.2;
    }

    explode() {
        this.hasExploded = true;
        this.explosionY = this.y;

        // Create spectacular explosion
        const particleCount = this.isWinner ? CONFIG.PARTICLE_COUNT * 2 : CONFIG.PARTICLE_COUNT;

        for (let i = 0; i < particleCount; i++) {
            this.particles.push(new Particle(this.x, this.y, this.color, false));
        }

        // Add secondary color burst
        for (let i = 0; i < particleCount / 2; i++) {
            this.particles.push(new Particle(this.x, this.y, this.secondaryColor, false));
        }

        // White sparkles
        for (let i = 0; i < 30; i++) {
            this.particles.push(new Particle(this.x, this.y, '#ffffff', false));
        }

        // Gold sparkles for winner
        if (this.isWinner) {
            for (let i = 0; i < 50; i++) {
                this.particles.push(new Particle(this.x, this.y, '#ffd700', false));
            }
        }
    }

    draw(ctx, showLabels = true) {
        // Draw trail first
        this.trail.forEach(p => p.draw(ctx));

        // Draw explosion particles
        this.particles.forEach(p => p.draw(ctx));

        if (this.hasExploded) return;

        // Draw the firework rocket
        ctx.save();

        // Outer glow
        ctx.shadowColor = this.color;
        ctx.shadowBlur = 20 * this.glowIntensity;

        // Main body
        ctx.fillStyle = this.color;
        ctx.beginPath();
        ctx.arc(this.x, this.y, this.size, 0, Math.PI * 2);
        ctx.fill();

        // Inner bright core
        ctx.fillStyle = '#ffffff';
        ctx.shadowBlur = 10;
        ctx.beginPath();
        ctx.arc(this.x, this.y, this.size * 0.4, 0, Math.PI * 2);
        ctx.fill();

        // Height indicator line
        ctx.strokeStyle = this.color;
        ctx.globalAlpha = 0.3;
        ctx.shadowBlur = 0;
        ctx.setLineDash([2, 4]);
        ctx.beginPath();
        ctx.moveTo(this.x, this.y + this.size + 5);
        ctx.lineTo(this.x, this.startY);
        ctx.stroke();
        ctx.setLineDash([]);

        ctx.restore();

        // Draw wallet label
        if (showLabels) {
            ctx.save();
            ctx.font = 'bold 11px monospace';
            ctx.textAlign = 'center';

            // Background for label
            const label = this.wallet;
            const textWidth = ctx.measureText(label).width;
            ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
            ctx.fillRect(this.x - textWidth / 2 - 4, this.y - 25, textWidth + 8, 16);

            // Label text
            ctx.fillStyle = this.color;
            ctx.fillText(label, this.x, this.y - 13);

            // Height reached
            const heightLabel = Math.floor(this.heightReached) + 'm';
            ctx.font = '9px monospace';
            ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
            ctx.fillText(heightLabel, this.x, this.y - 35);

            ctx.restore();
        }
    }

    isComplete() {
        return this.hasExploded && this.particles.length === 0;
    }
}

// ==========================================
// BACKGROUND FIREWORK CLASS
// ==========================================
class BackgroundFirework {
    constructor(canvas) {
        this.canvas = canvas;
        this.x = Math.random() * canvas.width;
        this.y = canvas.height;
        this.targetY = 100 + Math.random() * (canvas.height * 0.5);
        this.vy = -4 - Math.random() * 3;
        this.color = CONFIG.COLORS[Math.floor(Math.random() * CONFIG.COLORS.length)];
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
// GAME ENGINE
// ==========================================
class FireworkGame {
    constructor() {
        this.gameCanvas = document.getElementById('game-canvas');
        this.gameCtx = this.gameCanvas.getContext('2d');
        this.bgCanvas = document.getElementById('bg-fireworks');
        this.bgCtx = this.bgCanvas.getContext('2d');

        this.bgFireworks = [];
        this.gameFireworks = [];
        this.lastWinner = null;
        this.roundStartTime = 0;
        this.explosionOrder = [];

        this.setupCanvases();
        this.bindEvents();
        this.startBackgroundShow();
        this.startGame();
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
        document.querySelector('.hero')?.addEventListener('click', (e) => {
            this.launchBgFirework(e.clientX);
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
            position: fixed;
            bottom: 20px;
            left: 50%;
            transform: translateX(-50%);
            background: rgba(255, 215, 0, 0.9);
            color: #000;
            padding: 12px 24px;
            border-radius: 8px;
            font-weight: 600;
            z-index: 9999;
            animation: fadeInUp 0.3s ease;
        `;
        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), 2000);
    }

    launchBgFirework(x) {
        this.bgFireworks.push(new BackgroundFirework({
            width: this.bgCanvas.width,
            height: this.bgCanvas.height
        }));
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

    startGame() {
        gameState.isRunning = true;
        this.startNewRound();

        const animateGame = () => {
            this.updateGame();
            this.drawGame();
            requestAnimationFrame(animateGame);
        };
        animateGame();

        setInterval(() => this.updateTimer(), 1000);
    }

    startNewRound() {
        // Reset state
        gameState.timeRemaining = CONFIG.ROUND_DURATION;
        gameState.winner = null;
        gameState.roundStarted = true;
        gameState.highestReached = 0;
        this.gameFireworks = [];
        this.explosionOrder = [];
        this.roundStartTime = Date.now();

        // Hide winner overlay
        document.getElementById('game-overlay').classList.remove('active');

        // Generate fireworks
        const count = CONFIG.MIN_FIREWORKS + Math.floor(Math.random() * (CONFIG.MAX_FIREWORKS - CONFIG.MIN_FIREWORKS));
        gameState.activeFireworks = count;

        const canvasWidth = this.gameCanvas.width;
        const canvasHeight = this.gameCanvas.height;

        // Create all fireworks at once - they race together!
        for (let i = 0; i < count; i++) {
            const wallet = MOCK_WALLETS[i % MOCK_WALLETS.length];
            this.gameFireworks.push(new RacingFirework(
                i, wallet, i, count, canvasWidth, canvasHeight
            ));
        }

        // Update UI
        document.getElementById('current-round').textContent = `#${gameState.currentRound}`;
        document.getElementById('active-fireworks').textContent = count;
        document.getElementById('prize-pool').textContent = `${gameState.prizePool.toFixed(2)} SOL`;
    }

    updateTimer() {
        if (gameState.timeRemaining > 0 && gameState.roundStarted) {
            gameState.timeRemaining--;

            const minutes = Math.floor(gameState.timeRemaining / 60);
            const seconds = gameState.timeRemaining % 60;
            const timeStr = `${minutes}:${seconds.toString().padStart(2, '0')}`;

            document.getElementById('game-timer').textContent = timeStr;
            document.getElementById('hero-countdown').textContent = timeStr;

            const progress = (gameState.timeRemaining / CONFIG.ROUND_DURATION) * 100;
            document.getElementById('timer-progress').style.width = `${progress}%`;

            // Update active count
            const activeCount = this.gameFireworks.filter(fw => !fw.hasExploded).length;
            document.getElementById('active-fireworks').textContent = activeCount;
            gameState.activeFireworks = activeCount;

            // If timer runs out, force remaining to explode and determine winner
            if (gameState.timeRemaining === 0) {
                this.forceEndRound();
            }
        }
    }

    forceEndRound() {
        // Force all remaining fireworks to explode
        const remaining = this.gameFireworks.filter(fw => !fw.hasExploded);
        remaining.forEach(fw => {
            if (!fw.hasExploded) {
                fw.explode();
                this.explosionOrder.push(fw);
            }
        });

        // Find the winner (highest reached)
        this.determineWinner();
    }

    updateGame() {
        if (!gameState.roundStarted) return;

        const elapsedTime = Date.now() - this.roundStartTime;

        // Track which fireworks just exploded this frame
        const previouslyActive = this.gameFireworks.filter(fw => !fw.hasExploded);

        // Update all fireworks
        this.gameFireworks.forEach(fw => {
            const wasActive = !fw.hasExploded;
            fw.update(elapsedTime);

            // If just exploded, add to order
            if (wasActive && fw.hasExploded) {
                this.explosionOrder.push(fw);
            }
        });

        // Update active count
        const activeCount = this.gameFireworks.filter(fw => !fw.hasExploded).length;

        // Track highest current firework
        const activeFws = this.gameFireworks.filter(fw => !fw.hasExploded);
        if (activeFws.length > 0) {
            const highest = activeFws.reduce((max, fw) =>
                fw.heightReached > max.heightReached ? fw : max
            );
            gameState.highestReached = Math.floor(highest.heightReached);
        }

        // Check if only one remains - WINNER!
        if (activeCount === 1 && !gameState.winner) {
            const winner = this.gameFireworks.find(fw => !fw.hasExploded);
            if (winner) {
                winner.isWinner = true;
                // Let them go a bit higher then explode gloriously
                setTimeout(() => {
                    if (!winner.hasExploded) {
                        winner.explode();
                        this.explosionOrder.push(winner);
                        this.announceWinner(winner);
                    }
                }, 1500);
            }
        } else if (activeCount === 0 && !gameState.winner && this.gameFireworks.length > 0) {
            // All exploded - find winner by height
            this.determineWinner();
        }
    }

    determineWinner() {
        if (gameState.winner) return;

        // Winner is the one who reached the highest before exploding
        const winner = this.gameFireworks.reduce((highest, fw) => {
            if (!highest || fw.heightReached > highest.heightReached) {
                return fw;
            }
            return highest;
        }, null);

        if (winner) {
            winner.isWinner = true;
            this.announceWinner(winner);
        }
    }

    announceWinner(firework) {
        if (gameState.winner) return;

        gameState.winner = firework;
        gameState.roundStarted = false;

        // Calculate height in "meters" for display
        const heightDisplay = Math.floor(firework.heightReached);

        // Update winner display
        document.getElementById('winner-wallet').textContent = firework.wallet + '...';
        document.getElementById('winner-prize').textContent = `${gameState.prizePool.toFixed(2)} SOL`;

        // Add height info to overlay
        const overlay = document.getElementById('game-overlay');
        let heightInfo = overlay.querySelector('.winner-height');
        if (!heightInfo) {
            heightInfo = document.createElement('p');
            heightInfo.className = 'winner-height';
            heightInfo.style.cssText = 'font-size: 16px; color: #00ff88; margin-top: 8px;';
            overlay.querySelector('.winner-announcement').appendChild(heightInfo);
        }
        heightInfo.textContent = `🚀 Reached ${heightDisplay}m - HIGHEST CLIMBER!`;

        overlay.classList.add('active');

        // Update stats
        gameState.totalDistributed += gameState.prizePool;
        document.getElementById('total-distributed').textContent = gameState.totalDistributed.toFixed(1);
        document.getElementById('total-given').textContent = `${gameState.totalDistributed.toFixed(1)} SOL`;

        // Add to winners table
        this.addWinnerToTable(firework, heightDisplay);

        // Start next round after delay
        setTimeout(() => this.endRound(), 4000);
    }

    addWinnerToTable(firework, height) {
        const tbody = document.getElementById('winners-list');
        const firstRow = tbody.querySelector('tr');

        const newRow = document.createElement('tr');
        newRow.className = 'winner-row gold';
        newRow.innerHTML = `
            <td><span class="rank-badge">🥇</span></td>
            <td class="wallet-cell">
                <span class="wallet-address">${firework.wallet}...</span>
            </td>
            <td>#${gameState.currentRound}</td>
            <td class="prize-cell">${gameState.prizePool.toFixed(2)} SOL</td>
            <td>Just now</td>
            <td>
                <a href="https://solscan.io/tx/example${gameState.currentRound}" target="_blank" class="verify-link">
                    Solscan ↗
                </a>
            </td>
        `;

        // Update existing ranks
        tbody.querySelectorAll('.winner-row').forEach((row, index) => {
            const badge = row.querySelector('.rank-badge');
            if (index === 0) {
                row.classList.remove('gold');
                row.classList.add('silver');
                badge.textContent = '🥈';
            } else if (index === 1) {
                row.classList.remove('silver');
                row.classList.add('bronze');
                badge.textContent = '🥉';
            } else {
                row.classList.remove('bronze');
                badge.textContent = index + 2;
            }
        });

        tbody.insertBefore(newRow, firstRow);

        if (tbody.children.length > 10) {
            tbody.lastElementChild.remove();
        }
    }

    endRound() {
        gameState.currentRound++;
        gameState.prizePool = 0.5 + Math.random() * 1.5;
        document.getElementById('total-rounds').textContent = gameState.currentRound;
        this.startNewRound();
    }

    drawGame() {
        // Clear with slight fade for trail effect
        this.gameCtx.fillStyle = 'rgba(5, 5, 16, 0.15)';
        this.gameCtx.fillRect(0, 0, this.gameCanvas.width, this.gameCanvas.height);

        // Draw height markers
        this.drawHeightMarkers();

        // Draw all fireworks (exploded ones show particles)
        this.gameFireworks.forEach(fw => fw.draw(this.gameCtx));

        // Draw starfield
        this.drawStars();

        // Draw current leader indicator
        this.drawLeaderIndicator();
    }

    drawHeightMarkers() {
        const ctx = this.gameCtx;
        const height = this.gameCanvas.height;

        ctx.save();
        ctx.font = '10px monospace';
        ctx.fillStyle = 'rgba(255, 255, 255, 0.15)';
        ctx.textAlign = 'right';

        // Draw height markers every 100 "meters"
        for (let h = 100; h < height - 100; h += 100) {
            const y = height - 80 - h;
            if (y > 50) {
                ctx.fillText(`${h}m`, 40, y);

                // Dotted line
                ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
                ctx.setLineDash([5, 10]);
                ctx.beginPath();
                ctx.moveTo(50, y);
                ctx.lineTo(this.gameCanvas.width - 20, y);
                ctx.stroke();
            }
        }
        ctx.setLineDash([]);
        ctx.restore();
    }

    drawLeaderIndicator() {
        const active = this.gameFireworks.filter(fw => !fw.hasExploded);
        if (active.length === 0) return;

        // Find current leader
        const leader = active.reduce((max, fw) =>
            fw.heightReached > max.heightReached ? fw : max
        );

        const ctx = this.gameCtx;
        ctx.save();

        // Draw "LEADER" badge above the leading firework
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
}

// ==========================================
// DYNAMIC UPDATES
// ==========================================
function updateDevSupply() {
    const devSupply = 1 + Math.random() * 3;
    document.getElementById('dev-supply').textContent = `${devSupply.toFixed(2)} SOL`;
}

function updateHolders() {
    const holders = 1200 + Math.floor(Math.random() * 100);
    document.getElementById('total-holders').textContent = holders.toLocaleString();
}

// ==========================================
// INITIALIZATION
// ==========================================
document.addEventListener('DOMContentLoaded', () => {
    const game = new FireworkGame();

    setInterval(updateDevSupply, 5000);
    setInterval(updateHolders, 10000);

    window.addEventListener('scroll', () => {
        const navbar = document.querySelector('.navbar');
        if (window.scrollY > 50) {
            navbar.style.background = 'rgba(10, 10, 26, 0.95)';
        } else {
            navbar.style.background = 'rgba(10, 10, 26, 0.8)';
        }
    });

    console.log('🎆 $FIREWORK Race Game Initialized - Climb Higher, Win Bigger! 🎆');
});
